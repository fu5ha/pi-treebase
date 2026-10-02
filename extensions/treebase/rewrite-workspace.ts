import { SessionManager, estimateTokens, convertToLlm, type SessionEntry, type SessionHeader } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BranchWriter } from "./session-writer.ts";
import { actionDependencyErrors, makeActionItems, type ActionItem } from "./tree-utils.ts";

type Choice = { id: string; action: "pick" | "model" | "remove"; protected: boolean; hash: string; projected: boolean };
export type RewriteManifest = {
    version: 1 | 2;
    operationId: string;
    sessionId: string;
    originalLeaf: string;
    selectedParent: string | null;
    selectedIds: string[];
    originalHash: string;
    choices: Choice[];
    originalEstimatedTokens: number;
};
export type RewriteWorkspace = {
    directory: string;
    originalPath: string;
    contextPath: string;
    choicesPath: string;
    instructionsPath: string;
    readyPath: string;
    manifestHash: string;
    manifest: RewriteManifest;
};

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
    return JSON.stringify(value);
};
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function fail(message: string): never { throw new Error(message); }
const payload = (entry: SessionEntry) => {
    const { parentId: _parent, ...rest } = entry;
    return rest;
};
const paths = (directory: string) => ({
    directory, originalPath: path.join(directory, "original.jsonl"), contextPath: path.join(directory, "context.jsonl"),
    choicesPath: path.join(directory, "choices.json"), instructionsPath: path.join(directory, "instructions.md"),
    readyPath: path.join(directory, "ready.json"),
});
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

function parseJsonl(text: string): { header: SessionHeader; entries: SessionEntry[] } {
    const records = text.split(/\r?\n/).filter(line => line.trim()).map((line, i) => {
        try { return JSON.parse(line); } catch { return fail(`Invalid JSON on nonblank record ${i + 1}`); }
    });
    const header = records.shift();
    if (!object(header) || header.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string")
        fail("First record must be a pi session header");
    const ids = new Set<string>();
    for (const record of records) {
        validateShape(record);
        if (ids.has(record.id)) fail(`Duplicate record ID ${record.id}`);
        ids.add(record.id);
    }
    return { header: header as unknown as SessionHeader, entries: records };
}

function validateContent(content: unknown, assistant = false) {
    if (typeof content === "string" && !assistant) return;
    if (!Array.isArray(content)) fail("Message content must be a supported content array (or string for non-assistant messages)");
    for (const block of content) {
        if (!object(block)) fail("Invalid content block");
        if (block.type === "text" && typeof block.text === "string") continue;
        if (!assistant && block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") continue;
        if (assistant && block.type === "thinking" && typeof block.thinking === "string") continue;
        if (assistant && block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string" && object(block.arguments)) continue;
        fail(`Unsupported/malformed content block ${block.type}`);
    }
}

function validateShape(entry: any): asserts entry is SessionEntry {
    if (!object(entry) || typeof entry.id !== "string" || !entry.id || typeof entry.timestamp !== "string" ||
        !(entry.parentId === null || typeof entry.parentId === "string")) fail("Invalid session entry identity");
    const stringFields: Record<string, string[]> = {
        thinking_level_change: ["thinkingLevel"], model_change: ["provider", "modelId"],
        usage: ["kind", "provider", "model"], custom: ["customType"], label: ["targetId"],
        compaction: ["summary", "firstKeptEntryId"], branch_summary: ["summary", "fromId"],
        custom_message: ["customType"], context_edit: ["targetId"], session_info: [], message: [],
    };
    if (!(entry.type in stringFields)) fail(`Unsupported session entry type ${entry.type}`);
    for (const field of stringFields[entry.type]) if (typeof entry[field] !== "string") fail(`${entry.id}: ${field} must be a string`);
    if (entry.type === "custom_message") {
        validateContent(entry.content);
        if (typeof entry.display !== "boolean") fail(`${entry.id}: display must be boolean`);
    }
    if (entry.type === "context_edit" && entry.replacement !== null) {
        if (!object(entry.replacement)) fail(`${entry.id}: invalid context replacement`);
        validateContent(entry.replacement.content, Array.isArray(entry.replacement.content) &&
            entry.replacement.content.some((b: any) => b?.type === "toolCall" || b?.type === "thinking"));
    }
    if (entry.type === "compaction" && (!Number.isFinite(entry.tokensBefore) || entry.tokensBefore < 0))
        fail(`${entry.id}: invalid compaction token count`);
    if (entry.type === "usage" || entry.usage !== undefined) validateUsage(entry.usage, entry.id);
    if (entry.type === "label" && entry.label !== undefined && typeof entry.label !== "string")
        fail(`${entry.id}: invalid label`);
    if (entry.type === "session_info" && entry.name !== undefined && typeof entry.name !== "string")
        fail(`${entry.id}: invalid session name`);
    if (entry.type === "compaction" && entry.systemMessage !== undefined)
        validateShape({ type: "message", id: `${entry.id}.checkpoint`, parentId: null, timestamp: entry.timestamp, message: entry.systemMessage });
    if (entry.type === "message") {
        const m = entry.message;
        if (!object(m) || !Number.isFinite(m.timestamp)) fail(`${entry.id}: invalid message`);
        if (["system", "user", "assistant", "toolResult", "custom"].includes(m.role)) validateContent(m.content, m.role === "assistant");
        else if (m.role === "bashExecution") {
            if (typeof m.command !== "string" || typeof m.output !== "string" || typeof m.cancelled !== "boolean" ||
                typeof m.truncated !== "boolean") fail(`${entry.id}: invalid bash execution`);
        } else fail(`${entry.id}: unsupported message role ${m.role}`);
        if (m.role === "assistant" && (!object(m.usage) || !["api", "provider", "model", "stopReason"].every(k => typeof m[k] === "string")))
            fail(`${entry.id}: incomplete assistant metadata`);
        if (m.role === "assistant") {
            validateUsage(m.usage, entry.id);
            if (!["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"].includes(m.stopReason))
                fail(`${entry.id}: unsupported stopReason`);
        }
        if (m.role === "toolResult" && (typeof m.toolCallId !== "string" || typeof m.toolName !== "string" || typeof m.isError !== "boolean"))
            fail(`${entry.id}: invalid tool result`);
        if (m.role === "toolResult" && !Array.isArray(m.content)) fail(`${entry.id}: tool results require content arrays`);
        if (m.role === "system") {
            if (Array.isArray(m.content) && m.content.some((block: any) => block.type !== "text"))
                fail(`${entry.id}: system content permits only text`);
            if (m.sections !== undefined && (!object(m.sections) || !Object.values(m.sections).every(v => v === null || typeof v === "string")))
                fail(`${entry.id}: invalid system sections`);
            if (m.toolsAdded !== undefined && (!Array.isArray(m.toolsAdded) || !m.toolsAdded.every((tool: any) =>
                object(tool) && typeof tool.name === "string" && typeof tool.description === "string" && object(tool.parameters))))
                fail(`${entry.id}: invalid tool declarations`);
            if (m.toolsRemoved !== undefined && (!Array.isArray(m.toolsRemoved) || !m.toolsRemoved.every((tool: any) =>
                object(tool) && typeof tool.name === "string"))) fail(`${entry.id}: invalid tool removal`);
        }
        if (m.role === "custom" && (typeof m.customType !== "string" || typeof m.display !== "boolean"))
            fail(`${entry.id}: invalid custom message`);
    }
}

function validateUsage(usage: any, id: string) {
    if (!object(usage) || !["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(k =>
        Number.isFinite(usage[k]) && usage[k] >= 0) || !object(usage.cost) ||
        !["input", "output", "cacheRead", "cacheWrite", "total"].every(k => Number.isFinite(usage.cost[k]) && usage.cost[k] >= 0))
        fail(`${id}: invalid usage`);
}
function estimated(sm: SessionManager): number {
    return convertToLlm(sm.buildSessionProjection().messages).reduce((sum, message) => sum + estimateTokens(message), 0);
}

/** Snapshot before adding any editing activity; serialization also handles in-memory sessions. */
export async function prepareWorkspace(sm: SessionManager, items: ActionItem[]): Promise<RewriteWorkspace> {
    const header = sm.getHeader();
    const leaf = sm.getLeafId();
    if (!header || !leaf || !items.length) fail("Cannot prepare an empty rewrite");
    const selected = sm.getBranch(leaf);
    const start = selected.findIndex(entry => entry.id === items[0].id);
    if (start < 0 || !equal(selected.slice(start).map(e => e.id), items.map(i => i.id))) fail("Selections no longer match the current branch");
    const canonicalItems = makeActionItems(selected.slice(start), sm.buildSessionProjection());
    for (let i = 0; i < items.length; i++) {
        if (!equal(items[i].entry, canonicalItems[i].entry)) fail(`Selection payload ${items[i].id} is stale`);
        if (canonicalItems[i].protected && items[i].action !== "pick") fail(`Locked record ${items[i].id} must be P`);
        if (!["pick", "model", "remove"].includes(items[i].action)) fail(`Invalid action for ${items[i].id}`);
    }
    const dependencyErrors = actionDependencyErrors(items, selected);
    if (dependencyErrors.length) fail(dependencyErrors.join("\n"));
    const original = [...[header], ...sm.getEntries()].map(record => JSON.stringify(record)).join("\n") + "\n";
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-treebase-"));
    const visible = new Set(sm.buildSessionProjection().entries.filter(e => e.messages.length).map(e => e.sourceEntry.id));
    const manifest: RewriteManifest = {
        version: 2, operationId: randomUUID(), sessionId: sm.getSessionId(), originalLeaf: leaf,
        selectedParent: items[0].entry.parentId, selectedIds: items.map(i => i.id),
        originalHash: hash(original), originalEstimatedTokens: estimated(sm),
        choices: items.map((item, i) => ({ id: item.id, action: item.action, protected: !!canonicalItems[i].protected,
            hash: hash(canonical(item.entry)), projected: visible.has(item.id) }))
            .filter(choice => choice.action !== "model"),
    };
    const manifestText = JSON.stringify(manifest, null, 2) + "\n";
    const workspace = { ...paths(directory), manifest, manifestHash: hash(manifestText) };
    await fs.writeFile(workspace.originalPath, original, { mode: 0o400 });
    await fs.writeFile(workspace.contextPath, original);
    await fs.writeFile(workspace.choicesPath, manifestText);
    await fs.writeFile(path.join(directory, "session.schema.json"), JSON.stringify(sessionSchema, null, 2));
    await fs.writeFile(path.join(directory, "choices.schema.json"), JSON.stringify(choicesSchema, null, 2));
    await fs.writeFile(workspace.instructionsPath, instructions(workspace));
    return workspace;
}

export async function loadWorkspace(directory: string, expectedManifestHash: string): Promise<RewriteWorkspace> {
    const files = paths(directory);
    const text = await fs.readFile(files.choicesPath, "utf8");
    if (hash(text) !== expectedManifestHash) fail("choices.json changed; restore the immutable manifest before continuing");
    const manifest = JSON.parse(text) as RewriteManifest;
    if (![1, 2].includes(manifest.version) || !Array.isArray(manifest.choices)) fail("Unsupported rewrite manifest");
    if (manifest.version === 2 && manifest.choices.some(c => !["pick", "remove"].includes(c.action)))
        fail("Version 2 choices must contain only P/X overrides");
    return { ...files, manifest, manifestHash: expectedManifestHash };
}

/** Only selected raw entries plus explicitly attributed insertions become the final branch. */
export async function validateWorkspace(sm: SessionManager, workspace: RewriteWorkspace, contextWindow?: number) {
    const verified = await loadWorkspace(workspace.directory, workspace.manifestHash);
    const manifest = verified.manifest;
    if (sm.getSessionId() !== manifest.sessionId) fail("Workspace belongs to a different session");
    const originalText = await fs.readFile(workspace.originalPath, "utf8");
    if (hash(originalText) !== manifest.originalHash) fail("original.jsonl changed; snapshot integrity check failed");
    const original = parseJsonl(originalText);
    const edited = parseJsonl(await fs.readFile(workspace.contextPath, "utf8"));
    if (!equal(original.header, edited.header)) fail("Session header is protected");
    const originalById = new Map(original.entries.map(e => [e.id, e]));
    const selected = new Set(manifest.selectedIds);
    const explicitChoices = new Map(manifest.choices.map(c => [c.id, c]));
    // Version 2 stores only P/X overrides. The immutable snapshot supplies
    // payload integrity for implied M records; selectedIds still defines order.
    const choices = new Map(manifest.selectedIds.map(id => {
        const before = originalById.get(id);
        if (!before) fail(`Selected record ${id} missing from original snapshot`);
        if (manifest.version === 1 && !explicitChoices.has(id)) fail(`Missing legacy choice for ${id}`);
        const choice: Choice = explicitChoices.get(id) ?? {
            id, action: "model", protected: false, hash: hash(canonical(before)), projected: true,
        };
        return [id, choice] as const;
    }));
    const outside = original.entries.filter(e => !selected.has(e.id));
    if (!equal(outside, edited.entries.filter(e => originalById.has(e.id) && !selected.has(e.id))))
        fail("Outside-range records changed, disappeared, or were reordered");
    const candidate = edited.entries.filter(e => selected.has(e.id) || !originalById.has(e.id));
    const byId = new Map(candidate.map(e => [e.id, e]));
    for (const choice of choices.values()) {
        const before = originalById.get(choice.id)!;
        const after = byId.get(choice.id);
        if (hash(canonical(before)) !== choice.hash) fail(`Snapshot choice hash mismatch for ${choice.id}`);
        if (choice.action === "remove" && after) fail(`X record ${choice.id} must be omitted`);
        if (choice.protected || choice.action === "pick") {
            if (!after || !equal(payload(before), payload(after))) fail(`P/locked payload ${choice.id} changed or disappeared`);
        } else if (after) validateModelEdit(before, after);
    }
    // Walk only the rewrite chain. Unrelated original descendants may still point
    // to deleted selected IDs in this editing artifact; they are never imported.
    const children = new Map<string | null, SessionEntry[]>();
    for (const entry of candidate) {
        const list = children.get(entry.parentId) ?? [];
        list.push(entry); children.set(entry.parentId, list);
    }
    const ordered: SessionEntry[] = [];
    let parent = manifest.selectedParent;
    const visited = new Set<string>();
    while (children.has(parent)) {
        const next = children.get(parent)!;
        if (next.length !== 1) fail(`Rewrite chain branches at ${parent ?? "root"}; update parentId links`);
        const entry = next[0];
        if (visited.has(entry.id)) fail("Rewrite chain contains a cycle");
        ordered.push(entry); visited.add(entry.id); parent = entry.id;
    }
    if (ordered.length !== candidate.length) fail("Rewrite records are disconnected from selectedParent; update parentId links");
    let previousSlot = -1;
    for (const entry of ordered) {
        let slot = manifest.selectedIds.indexOf(entry.id);
        if (slot < 0) slot = insertionSlot(entry, manifest, choices);
        if (slot < previousSlot) fail(`Record ${entry.id} crossed an ordered original/P anchor`);
        previousSlot = slot;
    }
    const preview = SessionManager.inMemory(sm.getCwd(), undefined, [original.header, ...original.entries]);
    if (manifest.selectedParent) preview.branch(manifest.selectedParent); else preview.resetLeaf();
    const writer = new BranchWriter(preview);
    for (const entry of ordered) writer.append(entry);
    validateToolPairing(convertToLlm(preview.buildSessionProjection().messages));
    const estimatedTokens = estimated(preview);
    // Acceptance uses effective context, not JSONL byte size or historical usage.
    // It is an estimate, not a provider token-count guarantee.
    const limit = contextWindow === undefined ? Infinity : Math.floor(contextWindow * 0.9);
    if (estimatedTokens > limit) fail(`Effective context estimate ${estimatedTokens} exceeds 90% model budget ${limit}; shrink M material`);
    if (estimatedTokens > manifest.originalEstimatedTokens)
        fail(`Effective context grew from approximately ${manifest.originalEstimatedTokens} to ${estimatedTokens} tokens; shrink M material`);
    return { entries: ordered, estimatedTokens, originalEstimatedTokens: manifest.originalEstimatedTokens };
}

function validateModelEdit(before: SessionEntry, after: SessionEntry) {
    const a: any = structuredClone(payload(before)), b: any = structuredClone(payload(after));
    if (before.type === "message" && after.type === "message") {
        const key = before.message.role === "bashExecution" ? "output" : "content";
        if (before.message.role === "assistant" && after.message.role === "assistant") {
            const calls = (content: any[]) => content.filter(block => block.type === "toolCall");
            if (!equal(calls(before.message.content), calls(after.message.content)))
                fail(`M record ${before.id}: retain tool-call payloads exactly or remove the entire call/result pair`);
        }
        delete a.message[key]; delete b.message[key];
    } else if (before.type === "custom_message" && after.type === "custom_message") {
        delete a.content; delete b.content;
    } else if (before.type === "branch_summary" && after.type === "branch_summary") {
        delete a.summary; delete b.summary;
    }
    if (!equal(a, b)) fail(`M record ${before.id}: only content/output/summary is editable; metadata and type must stay intact`);
}

function insertionSlot(entry: SessionEntry, manifest: RewriteManifest, choices: Map<string, Choice>): number {
    if (!Number.isFinite(Date.parse(entry.timestamp))) fail(`${entry.id}: inserted record requires an ISO timestamp`);
    if (entry.type !== "custom_message" || entry.customType !== "treebase.context" || entry.display !== true ||
        !object(entry.details)) fail(`${entry.id}: insertions must be display:true custom_message records of type treebase.context`);
    const sources = entry.details.treebaseSources;
    const after = entry.details.treebaseAfter;
    if (!Array.isArray(sources) || !sources.length || !sources.every(id => typeof id === "string" &&
        choices.get(id)?.action === "model" && !choices.get(id)?.protected) || !sources.includes(after))
        fail(`${entry.id}: insertion requires treebaseSources of editable M IDs and treebaseAfter among those IDs`);
    const slot = manifest.selectedIds.indexOf(after);
    const anchorInterval = (index: number) => manifest.selectedIds.slice(0, index + 1)
        .filter(id => choices.get(id)?.protected || choices.get(id)?.action === "pick").length;
    if (!sources.every(id => anchorInterval(manifest.selectedIds.indexOf(id)) === anchorInterval(slot)))
        fail(`${entry.id}: synthesized material cannot cross a P/locked anchor`);
    return slot + 0.5;
}

function validateToolPairing(messages: ReturnType<typeof convertToLlm>) {
    const pending = new Map<string, string>();
    const used = new Set<string>();
    const tools = new Set<string>();
    let declaredTools = false;
    for (const message of messages) {
        if (message.role === "system") {
            if (message.toolsAdded !== undefined || message.toolsRemoved !== undefined) declaredTools = true;
            // Native projection replays protected system updates and checkpoints.
            for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
            for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
            continue;
        }
        if (message.role === "toolResult") {
            if (pending.get(message.toolCallId) !== message.toolName) fail(`Orphan/mismatched tool result ${message.toolCallId}`);
            pending.delete(message.toolCallId);
            continue;
        }
        if (pending.size) fail(`Missing tool results before ${message.role}: ${[...pending.keys()].join(", ")}`);
        if (message.role === "assistant") for (const block of message.content) {
            if (block.type !== "toolCall") continue;
            if (used.has(block.id)) fail(`Repeated tool-call ID ${block.id}`);
            if (declaredTools && !tools.has(block.name)) fail(`Tool call ${block.id} uses undeclared/inactive tool ${block.name}`);
            used.add(block.id); pending.set(block.id, block.name);
        }
    }
    if (pending.size) fail(`Missing tool results: ${[...pending.keys()].join(", ")}`);
}

function instructions(workspace: RewriteWorkspace): string {
    return `# Controlled context editing

You are the actual current agent on a temporary working branch, with your normal tools.
Edit ONLY ${workspace.contextPath}. Never change original.jsonl or choices.json.
Inspect choices.json and session.schema.json before editing. In version 2, choices
lists only P/X overrides (including locked P records); every selectedId absent
from choices is M. Projected-source flags describe the explicit overrides only.
This duplicate contains all session history, including unrelated branches. X is NOT
a confidentiality boundary. Do not reintroduce X facts into synthesized replacements.

Use programmatic JSONL inspection and batched edits. Preserve precise useful facts;
prefer concise context over a prescribed summary format. No new agent/session is needed.

## Durable extraction contract

- P and locked records must remain with their original ID, timestamp and payload.
  Only parentId may change. Retained original entries must preserve original order.
- X records must be deleted from this duplicate. M may be retained, removed, or have
  content/output/summary rewritten; all other metadata and toolCall blocks stay exact.
  Remove tool calls and matching results together, never fabricate their results.
- The selected records are choices.json.selectedIds. Outside-range records and header
  must remain byte-equivalent as JSON values and in their original relative order.
  Outside descendants may still reference a deleted selected ID: this artifact is
  extracted, not directly opened as a live session.
- Reconnect retained selected records and new records into ONE parentId chain starting
  at choices.json.selectedParent (possibly null). Do not rely on line numbers.
  The final chain can be empty if no P/locked entries remain.
- New material must be a custom_message with fresh unique ID, ISO timestamp,
  customType:"treebase.context", display:true, string/text/image content, and
  details: {treebaseSources:["M-source-id",...], treebaseAfter:"M-source-id"}.
  treebaseAfter must be among the sources. Insert after that source's original slot,
  whether that source is retained or removed. Multiple insertions at the same slot
  are allowed. All sources must be editable M records in the same P/locked-anchor
  interval; synthesized material cannot cross a P anchor. No new system, structural,
  tool, assistant or user records. Existing compactions/context edits stay protected.
- Effective context must not grow, and must fit 90% of the active model context
  window when known, using pi's estimated model-context tokens (not file byte size).
  Preserved checkpoints/references and tool pairing are validated before activation.

## Completion and repair

When finished, write ${workspace.readyPath} containing exactly:
{"operationId":${JSON.stringify(workspace.manifest.operationId)}}
Then end normally with a short receipt. Do not invoke /treebase yourself.
The extension validates after a completed run, supplies bounded repair diagnostics,
and automatically attempts activation from a deferred idle command context.
Interrupted/aborted runs cannot activate output. The user can cancel with
/treebase cancel. After extension/session reload the user must use
/treebase resume and let a fresh run complete before automatic activation.
Instructions and editing activity stay off the final branch.
Snapshots/artifacts are retained in ${workspace.directory} for recovery and inspection.
`;
}

const contentSchema = {
    oneOf: [{ type: "string" }, { type: "array", items: { oneOf: [
        { type: "object", required: ["type", "text"], properties: { type: { const: "text" }, text: { type: "string" } } },
        { type: "object", required: ["type", "data", "mimeType"], properties: { type: { const: "image" }, data: { type: "string" }, mimeType: { type: "string" } } },
        { type: "object", required: ["type", "thinking"], properties: { type: { const: "thinking" }, thinking: { type: "string" } } },
        { type: "object", required: ["type", "id", "name", "arguments"], properties: { type: { const: "toolCall" }, id: { type: "string" }, name: { type: "string" }, arguments: { type: "object" } } },
    ] } }] };
const blocks = contentSchema.oneOf[1].items!.oneOf;
const normalContentSchema = { oneOf: [{ type: "string" }, { type: "array", items: { oneOf: [blocks[0], blocks[1]] } }] };
const assistantContentSchema = { type: "array", items: { oneOf: [blocks[0], blocks[2], blocks[3]] } };
const stringSchema = { type: "string" };
const numberSchema = { type: "number", minimum: 0 };
const usageSchema = {
    type: "object", required: ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"],
    properties: {
        input: numberSchema, output: numberSchema, cacheRead: numberSchema, cacheWrite: numberSchema, totalTokens: numberSchema,
        cost: { type: "object", required: ["input", "output", "cacheRead", "cacheWrite", "total"],
            properties: { input: numberSchema, output: numberSchema, cacheRead: numberSchema, cacheWrite: numberSchema, total: numberSchema } },
    },
};
const messageSchema = {
    type: "object", required: ["role", "timestamp"],
    properties: {
        role: { enum: ["system", "user", "assistant", "toolResult", "bashExecution", "custom"] },
        timestamp: { type: "number" }, content: contentSchema,
    },
    allOf: [
        { if: { properties: { role: { enum: ["system", "user", "assistant", "toolResult", "custom"] } } }, then: { required: ["content"] } },
        { if: { properties: { role: { enum: ["user", "custom"] } } }, then: { properties: { content: normalContentSchema } } },
        { if: { properties: { role: { const: "assistant" } } }, then: {
            required: ["api", "provider", "model", "usage", "stopReason"],
            properties: { api: stringSchema, provider: stringSchema, model: stringSchema, usage: usageSchema,
                content: assistantContentSchema,
                stopReason: { enum: ["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"] } },
        } },
        { if: { properties: { role: { const: "toolResult" } } }, then: { required: ["toolCallId", "toolName", "isError"],
            properties: { toolCallId: stringSchema, toolName: stringSchema, isError: { type: "boolean" }, usage: usageSchema,
                content: normalContentSchema.oneOf[1] } } },
        { if: { properties: { role: { const: "bashExecution" } } }, then: { required: ["command", "output", "cancelled", "truncated"],
            properties: { command: stringSchema, output: stringSchema, cancelled: { type: "boolean" }, truncated: { type: "boolean" },
                exitCode: { type: ["number", "null"] }, excludeFromContext: { type: "boolean" }, fullOutputPath: stringSchema } } },
        { if: { properties: { role: { const: "custom" } } }, then: { required: ["customType", "display"],
            properties: { customType: stringSchema, display: { type: "boolean" } } } },
        { if: { properties: { role: { const: "system" } } }, then: { properties: {
            content: { oneOf: [{ type: "string" }, { type: "array", items: blocks[0] }] },
            sections: { type: "object", additionalProperties: { type: ["string", "null"] } },
            toolsAdded: { type: "array", items: { type: "object", required: ["name", "description", "parameters"],
                properties: { name: stringSchema, description: stringSchema, parameters: { type: "object" } } } },
            toolsRemoved: { type: "array", items: { type: "object", required: ["name"], properties: { name: stringSchema } } },
        } } },
    ],
};
const entrySpecificSchemas: Record<string, { required: string[]; properties?: Record<string, unknown> }> = {
    message: { required: ["message"], properties: { message: messageSchema } },
    custom_message: { required: ["customType", "content", "display"], properties: { customType: stringSchema, content: normalContentSchema, display: { type: "boolean" } } },
    thinking_level_change: { required: ["thinkingLevel"], properties: { thinkingLevel: stringSchema } },
    model_change: { required: ["provider", "modelId"], properties: { provider: stringSchema, modelId: stringSchema } },
    usage: { required: ["kind", "provider", "model", "usage"], properties: { kind: stringSchema, provider: stringSchema, model: stringSchema, usage: usageSchema, note: stringSchema } },
    compaction: { required: ["summary", "firstKeptEntryId", "tokensBefore"], properties: { summary: stringSchema, firstKeptEntryId: stringSchema,
        tokensBefore: numberSchema, systemMessage: messageSchema, fromHook: { type: "boolean" }, usage: usageSchema } },
    branch_summary: { required: ["summary", "fromId"], properties: { summary: stringSchema, fromId: stringSchema, fromHook: { type: "boolean" }, usage: usageSchema } },
    context_edit: { required: ["targetId", "replacement"], properties: { targetId: stringSchema,
        replacement: { oneOf: [{ type: "null" }, { type: "object", required: ["content"], properties: { content: contentSchema }, additionalProperties: false }] } } },
    label: { required: ["targetId"], properties: { targetId: stringSchema, label: stringSchema } },
    session_info: { required: [], properties: { name: stringSchema } },
    custom: { required: ["customType"], properties: { customType: stringSchema } },
};
const sessionSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    description: "One JSONL record. Runtime validation additionally enforces the choices, ancestry, references, replay and insertion contract.",
    oneOf: [
        { type: "object", required: ["type", "id", "timestamp", "cwd"], properties: { type: { const: "session" }, id: { type: "string" }, timestamp: { type: "string" }, cwd: { type: "string" }, version: { const: 3 } } },
        { type: "object", required: ["type", "id", "parentId", "timestamp"], properties: {
            type: { enum: ["message", "thinking_level_change", "model_change", "usage", "compaction", "branch_summary", "custom", "label", "session_info", "custom_message", "context_edit"] },
            id: { type: "string" }, parentId: { type: ["string", "null"] }, timestamp: { type: "string" },
            message: messageSchema,
            content: normalContentSchema,
        }, allOf: Object.entries(entrySpecificSchemas).map(([type, schema]) =>
            ({ if: { properties: { type: { const: type } } }, then: schema })) },
    ],
};
const choicesSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema", type: "object",
    required: ["version", "operationId", "sessionId", "originalLeaf", "selectedParent", "selectedIds", "originalHash", "choices", "originalEstimatedTokens"],
    properties: {
        version: { const: 2 }, operationId: { type: "string" }, sessionId: { type: "string" },
        originalLeaf: { type: "string" }, selectedParent: { type: ["string", "null"] },
        selectedIds: { type: "array", items: { type: "string" }, uniqueItems: true },
        originalHash: { type: "string" }, originalEstimatedTokens: { type: "number" },
        choices: { type: "array", description: "Only P/X overrides. Unlisted selectedIds imply M.",
            items: { type: "object", required: ["id", "action", "protected", "hash", "projected"],
            properties: { id: { type: "string" }, action: { enum: ["pick", "remove"] }, protected: { type: "boolean" }, hash: { type: "string" }, projected: { type: "boolean" } } } },
    },
};
