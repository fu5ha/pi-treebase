import { SessionManager, estimateTokens, convertToLlm, type SessionEntry, type SessionHeader } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BranchWriter } from "./session-writer.ts";
import { actionDependencyErrors, makeActionItems, type ActionItem } from "./tree-utils.ts";

type Choice = { id: string; action: "pick" | "model" | "remove"; protected: boolean; hash: string; projected: boolean };
export type RewriteManifest = {
    operationId: string;
    sessionId: string;
    originalLeaf: string;
    selectedParent: string | null;
    selectedIds: string[];
    branchIds: string[];
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
        operationId: randomUUID(), sessionId: sm.getSessionId(), originalLeaf: leaf,
        selectedParent: items[0].entry.parentId, selectedIds: items.map(i => i.id),
        branchIds: selected.map(e => e.id),
        originalHash: hash(original), originalEstimatedTokens: estimated(sm),
        choices: items.map((item, i) => ({ id: item.id, action: item.action, protected: !!canonicalItems[i].protected,
            hash: hash(canonical(item.entry)), projected: visible.has(item.id) }))
            .filter(choice => choice.action !== "model"),
    };
    const manifestText = JSON.stringify(manifest, null, 2) + "\n";
    const workspace = { ...paths(directory), manifest, manifestHash: hash(manifestText) };
    await fs.writeFile(workspace.originalPath, original, { mode: 0o400 });
    const actions = new Map(items.map(item => [item.id, item.action]));
    const editable = selected.filter(entry => actions.get(entry.id) !== "remove").map(entry =>
        actions.get(entry.id) === "model" ? exportSource(entry) : { source: entry.id });
    await fs.writeFile(workspace.contextPath, editable.map(record => JSON.stringify(record)).join("\n") + "\n");
    await fs.writeFile(workspace.choicesPath, manifestText);
    await fs.writeFile(path.join(directory, "context.schema.json"), JSON.stringify(contextSchema, null, 2));
    await fs.writeFile(path.join(directory, "choices.schema.json"), JSON.stringify(choicesSchema, null, 2));
    await fs.writeFile(workspace.instructionsPath, instructions(workspace));
    return workspace;
}

export async function loadWorkspace(directory: string, expectedManifestHash: string): Promise<RewriteWorkspace> {
    const files = paths(directory);
    const text = await fs.readFile(files.choicesPath, "utf8");
    if (hash(text) !== expectedManifestHash) fail("choices.json changed; restore the immutable manifest before continuing");
    const manifest = JSON.parse(text) as RewriteManifest;
    exactKeys(manifest, ["operationId", "sessionId", "originalLeaf", "selectedParent", "selectedIds",
        "branchIds", "originalHash", "choices", "originalEstimatedTokens"]);
    if (!Array.isArray(manifest.branchIds) || !Array.isArray(manifest.choices))
        fail("Unsupported rewrite manifest; finish or cancel old workspaces before updating");
    if (manifest.choices.some(c => !["pick", "remove"].includes(c.action)))
        fail("choices must contain only P/X overrides");
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
    const originalById = new Map(original.entries.map(e => [e.id, e]));
    const branch: SessionEntry[] = [];
    let cursor: string | null = manifest.originalLeaf;
    const seenBranch = new Set<string>();
    while (cursor !== null) {
        if (seenBranch.has(cursor)) fail("Snapshot branch contains a cycle");
        seenBranch.add(cursor);
        const entry = originalById.get(cursor);
        if (!entry) fail("Snapshot branch is disconnected");
        branch.unshift(entry); cursor = entry.parentId;
    }
    if (!equal(branch.map(e => e.id), manifest.branchIds)) fail("Manifest branch does not match snapshot");
    const start = branch.findIndex(e => e.id === manifest.selectedIds[0]);
    if (start < 0 || !equal(branch.slice(start).map(e => e.id), manifest.selectedIds) ||
        branch[start].parentId !== manifest.selectedParent) fail("Manifest selection does not match snapshot");
    const snapshot = SessionManager.inMemory(sm.getCwd(), undefined, [original.header, ...original.entries]);
    snapshot.branch(manifest.originalLeaf);
    const canonicalItems = makeActionItems(branch.slice(start), snapshot.buildSessionProjection());
    const explicit = new Map(manifest.choices.map(c => [c.id, c]));
    if (explicit.size !== manifest.choices.length || manifest.choices.some(c => !manifest.selectedIds.includes(c.id)))
        fail("Invalid choice IDs");
    const choices = new Map(manifest.selectedIds.map((id, i) => {
        const before = originalById.get(id)!;
        const choice = explicit.get(id) ?? { id, action: "model" as const, protected: false,
            hash: hash(canonical(before)), projected: true };
        if (choice.hash !== hash(canonical(before))) fail(`Snapshot choice hash mismatch for ${id}`);
        if (canonicalItems[i].protected && (!choice.protected || choice.action !== "pick"))
            fail(`Locked source ${id} must be preserved`);
        return [id, choice] as const;
    }));
    const records = parseEditingJsonl(await fs.readFile(workspace.contextPath, "utf8"));
    const prefix = branch.slice(0, start);
    for (let i = 0; i < prefix.length; i++)
        if (!equal(records[i], { source: prefix[i].id })) fail("Read-only branch prefix changed or disappeared");
    const selectedRecords = records.slice(prefix.length);
    const ordered: SessionEntry[] = [];
    const used = new Set<string>();
    const anchors = manifest.selectedIds.filter(id => choices.get(id)!.action === "pick");
    const interval = (id: string) => {
        const index = manifest.selectedIds.indexOf(id);
        return manifest.selectedIds.slice(0, index).filter(source => choices.get(source)!.action === "pick").length;
    };
    let currentInterval = 0;
    const excerpts: { callSource: string; resultSource: string }[] = [];
    for (const record of selectedRecords) {
        let entry: SessionEntry;
        let source: string | undefined;
        if (record.kind === "context") {
            exactKeys(record, ["kind", "sources", "content"]);
            if (!Array.isArray(record.sources) || !record.sources.length ||
                new Set(record.sources).size !== record.sources.length ||
                !record.sources.every((id: unknown) => typeof id === "string" &&
                    choices.get(id)?.action === "model" && !choices.get(id)?.protected && interval(id) === currentInterval))
                fail("Synthesized context requires editable M sources in its current anchor interval");
            validateContent(record.content);
            entry = { type: "custom_message", id: randomUUID(), parentId: null, timestamp: new Date().toISOString(),
                customType: "treebase.context", display: true, content: record.content,
                details: { treebaseSources: record.sources } } as SessionEntry;
        } else {
            source = record.kind === "tool-excerpt" ? record.resultSource : record.source;
            if (typeof source !== "string" || !choices.has(source)) fail("Unknown or outside-range source");
            if (used.has(source)) fail(`Duplicate source ${source}`);
            used.add(source);
            const choice = choices.get(source)!;
            const before = originalById.get(source)!;
            if (choice.action === "remove") fail(`X source ${source} must be omitted`);
            if (choice.action === "pick") {
                if (!equal(record, { source }) || anchors[currentInterval] !== source)
                    fail(`P/locked source ${source} changed, disappeared, or crossed an anchor`);
                currentInterval++;
                entry = structuredClone(before);
            } else {
                if (interval(source) !== currentInterval) fail(`M source ${source} crossed a P/locked anchor`);
                if (record.kind === "tool-excerpt") {
                    entry = extractToolExcerpt(record, before, originalById, choices, new Set(manifest.branchIds));
                    excerpts.push({ callSource: record.callSource, resultSource: source });
                } else {
                    const field = editableField(before);
                    exactKeys(record, ["source", ...(field ? [field] : [])]);
                    entry = structuredClone(before);
                    if (field && field in record) {
                        if (entry.type === "message") (entry.message as any)[field] = record[field];
                        else (entry as any)[field] = record[field];
                    }
                    validateShape(entry);
                    validateModelEdit(before, entry);
                }
            }
        }
        entry.parentId = ordered.at(-1)?.id ?? manifest.selectedParent;
        ordered.push(entry);
    }
    if (currentInterval !== anchors.length) fail("P/locked source disappeared");
    for (const excerpt of excerpts) {
        const call = [...prefix, ...ordered].find(e => e.id === excerpt.callSource);
        const before = originalById.get(excerpt.callSource)!;
        if (!call || !equal(payload(call), payload(before)))
            fail(`Tool excerpt ${excerpt.resultSource} requires its full unchanged assistant call envelope`);
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

function exactKeys(record: Record<string, any>, allowed: string[]) {
    if (Object.keys(record).some(key => !allowed.includes(key))) fail("Unexpected editing-record field");
}

function editableField(entry: SessionEntry): "content" | "output" | "summary" | undefined {
    if (entry.type === "message") return entry.message.role === "bashExecution" ? "output" : "content";
    if (entry.type === "custom_message") return "content";
    if (entry.type === "branch_summary") return "summary";
    return undefined;
}

function exportSource(entry: SessionEntry) {
    const field = editableField(entry);
    return field ? { source: entry.id, [field]: entry.type === "message" ? (entry.message as any)[field] : (entry as any)[field] }
        : { source: entry.id };
}

function parseEditingJsonl(text: string): Record<string, any>[] {
    return text.split(/\r?\n/).filter(line => line.trim()).map((line, i) => {
        let record: unknown;
        try { record = JSON.parse(line); } catch { return fail(`Invalid JSON on nonblank record ${i + 1}`); }
        if (!object(record)) fail(`Editing record ${i + 1} must be an object`);
        return record;
    });
}

function extractToolExcerpt(record: Record<string, any>, before: SessionEntry,
    originalById: Map<string, SessionEntry>, choices: Map<string, Choice>, branchIds: Set<string>): SessionEntry {
    exactKeys(record, ["kind", "callSource", "resultSource", "keep"]);
    const call = originalById.get(record.callSource);
    const resultMessage = before.type === "message" && before.message.role === "toolResult" ? before.message : undefined;
    if (before.type !== "message" || before.message.role !== "toolResult" ||
        !call || call.type !== "message" || call.message.role !== "assistant" ||
        !branchIds.has(call.id) || choices.get(call.id)?.action === "remove" ||
        !call.message.content.some(block => block.type === "toolCall" &&
            block.id === resultMessage!.toolCallId && block.name === resultMessage!.toolName))
        fail("Tool excerpt requires the original matching assistant call and result");
    if (!Array.isArray(record.keep) || !record.keep.length) fail("Tool excerpt requires nonempty keep ranges");
    const content = before.message.content;
    const retained = new Map<number, { startLine: number; endLine: number }[]>();
    let previousBlock = -1, previousEnd = 0;
    for (const range of record.keep) {
        if (!object(range)) fail("Invalid tool excerpt range");
        exactKeys(range, ["block", "startLine", "endLine"]);
        const { block, startLine, endLine } = range;
        if (!Number.isInteger(block) || block < 0 || !Number.isInteger(startLine) || !Number.isInteger(endLine) ||
            startLine < 1 || endLine < startLine || content[block]?.type !== "text")
            fail("Tool excerpt ranges require existing text blocks and 1-based inclusive lines");
        const text = (content[block] as { type: "text"; text: string }).text;
        if (endLine > text.split("\n").length || block < previousBlock ||
            (block === previousBlock && startLine <= previousEnd)) fail("Tool excerpt ranges must be ordered, disjoint, and in bounds");
        const ranges = retained.get(block) ?? [];
        ranges.push({ startLine, endLine }); retained.set(block, ranges);
        previousBlock = block; previousEnd = endLine;
    }
    const result = structuredClone(before);
    const message = (result as any).message;
    message.content = [];
    for (let block = 0; block < content.length; block++) {
        const original = content[block];
        if (original.type !== "text") {
            // Excerpts operate on text only; images are retained rather than silently discarded.
            message.content.push(structuredClone(original));
            continue;
        }
        const lines = original.text.split("\n");
        const ranges = retained.get(block) ?? [];
        const parts: string[] = [];
        let next = 1;
        for (const range of ranges) {
            if (range.startLine > next) parts.push(`[treebase: omitted lines ${next}-${range.startLine - 1} of block ${block}]`);
            parts.push(lines.slice(range.startLine - 1, range.endLine).join("\n"));
            next = range.endLine + 1;
        }
        if (next <= lines.length) parts.push(`[treebase: omitted lines ${next}-${lines.length} of block ${block}]`);
        message.content.push({ type: "text", text: parts.join("\n") });
    }
    if (message.details !== undefined && !object(message.details))
        fail("Tool excerpt cannot extend non-object tool-result details");
    message.details = { ...message.details, treebaseExcerpt: { callSource: call.id, resultSource: before.id,
        originalHash: hash(canonical(before)), keep: structuredClone(record.keep),
        ...(message.details?.treebaseExcerpt !== undefined
            ? { previous: structuredClone(message.details.treebaseExcerpt) } : {}) } };
    validateShape(result);
    return result;
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
    return `# Ordered branch context editing

The context you're editing is your own current context. You are trying to retain what is relevant
for continued work after going back to the user selected point in history. Do not read the whole
files you're editing into context at once; it's already there. Try to grown your own context as
little as possible during the process of doing these edits to your future context.

Edit ONLY ${workspace.contextPath}.

Read choices.json and context.schema.json. choices contain user choices for what to keep and delete;
selectedIds absent from choices imply you choose what to do. original.jsonl is the immutable full
session snapshot; context.jsonl exports only the current branch.

Each nonblank line is one editing record. Line order determines ancestry.
Do not write native session records, IDs, parentId, timestamps or a session header.
The read-only prefix before selectedIds is source-only and must remain first,
unchanged. P/locked sources must remain source-only and in their original order.
X sources must be absent and must not be reintroduced in synthesized context.
X is exclusion, not confidentiality: the snapshot and your current context retain it.

## Source entries

{"source":"original-id"} keeps the full original payload.
M entries export their original editable field: content, output or summary.
Edit that field or remove the whole line. All other metadata is restored from the
snapshot. Look up source-only prefix/P/locked payloads in original.jsonl when
you need their full content or source roles/tool names; the snapshot contains
the complete branch data and metadata.
Assistant content includes toolCall blocks; keep them exactly.
Keep tool calls and matching results together; never fabricate tool results.
M sources may reorder within their interval between P/locked anchors, not across
anchors. A source may appear at most once. Protected/inactive raw records stay
protected, so old context-edit/compaction effects cannot accidentally revive history.

## Synthesized context

{"kind":"context","sources":["M-id"],"content":"Useful facts"}
Content may also be supported text/image blocks. Sources must be editable M IDs
in the same current anchor interval. Sources may be removed or retained elsewhere
in that interval. Treebase imports a display:true treebase.context custom message
and records source provenance. Do not invent native historical tool calls or results.

## Verbatim tool excerpts

Replace a result's source line with:
{"kind":"tool-excerpt","callSource":"assistant-id","resultSource":"result-id","keep":[{"block":0,"startLine":42,"endLine":57}]}
Keep its full unchanged assistant call envelope as a separate source line. The
excerpt does not insert the call itself. Every sibling tool call in a multi-call
envelope still needs a result. The result must be editable M; the call may be M,
P, or in the protected prefix.

Ranges refer to original snapshot content blocks (zero-based) and text lines
(1-based, inclusive, split on LF). They must be nonempty, sorted, disjoint and in
bounds. Treebase extracts text directly and inserts explicit omission markers;
do not supply replacement text. Non-text blocks are retained unchanged. Result
metadata/error status and existing object details survive, with treebaseExcerpt
provenance added. Non-object details cannot be excerpted. For paraphrases use
synthesized context instead of pretending they are verbatim tool output.

The native projected/converted effective context estimate must not grow and
must fit 90% of the known model window. This is an estimate, not a provider token
guarantee. Use programmatic inspection and batched edits; no fixed summary format.

## Completion and recovery

Write ${workspace.readyPath} only when editing is complete:
{"operationId":"${workspace.manifest.operationId}","manifestHash":"${workspace.manifestHash}","ready":true}
Readiness is validated at completed settlement; repair diagnostics may follow.
After successful settlement treebase automatically revalidates and activates
from an idle deferred command context. Editing activity never enters the final
branch. /treebase resume continues an interrupted operation; /treebase cancel
returns to original history. Reload requires a fresh resumed settled editing run.
Supported native IDs/references are remapped by reconstruction; opaque
extension-private references are not remapped automatically. Unsupported
shapes, checkpoints and public append gaps fail explicitly.
Artifacts remain for recovery. There is no protocol version or legacy reader;
finish or cancel pending workspaces before updating the editing format.
`;
}

const textBlockSchema = { type: "object", required: ["type", "text"],
    properties: { type: { const: "text" }, text: { type: "string" } } };
const imageBlockSchema = { type: "object", required: ["type", "data", "mimeType"],
    properties: { type: { const: "image" }, data: { type: "string" }, mimeType: { type: "string" } } };
const thinkingBlockSchema = { type: "object", required: ["type", "thinking"],
    properties: { type: { const: "thinking" }, thinking: { type: "string" } } };
const toolCallBlockSchema = { type: "object", required: ["type", "id", "name", "arguments"],
    properties: { type: { const: "toolCall" }, id: { type: "string" }, name: { type: "string" }, arguments: { type: "object" } } };
const contentSchema = { oneOf: [
    { type: "string" },
    { type: "array", items: { oneOf: [textBlockSchema, imageBlockSchema, thinkingBlockSchema, toolCallBlockSchema] } },
] };
const synthesizedContentSchema = { oneOf: [
    { type: "string" },
    { type: "array", items: { oneOf: [textBlockSchema, imageBlockSchema] } },
] };
const contextSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    description: "One ordered editing JSONL record. Runtime validation checks snapshot sources, locks, anchor intervals, metadata and tool pairing.",
    oneOf: [
        { type: "object", additionalProperties: false, required: ["source"], properties: {
            source: { type: "string" }, content: contentSchema, output: { type: "string" }, summary: { type: "string" },
        } },
        { type: "object", additionalProperties: false, required: ["kind", "sources", "content"], properties: {
            kind: { const: "context" }, sources: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string" } },
            content: synthesizedContentSchema,
        } },
        { type: "object", additionalProperties: false, required: ["kind", "callSource", "resultSource", "keep"], properties: {
            kind: { const: "tool-excerpt" }, callSource: { type: "string" }, resultSource: { type: "string" },
            keep: { type: "array", minItems: 1, items: {
                type: "object", additionalProperties: false, required: ["block", "startLine", "endLine"],
                properties: { block: { type: "integer", minimum: 0 }, startLine: { type: "integer", minimum: 1 },
                    endLine: { type: "integer", minimum: 1 } },
            } },
        } },
    ],
};
const choicesSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false,
    required: ["operationId", "sessionId", "originalLeaf", "selectedParent", "selectedIds", "branchIds", "originalHash", "choices", "originalEstimatedTokens"],
    properties: {
        operationId: { type: "string" }, sessionId: { type: "string" }, originalLeaf: { type: "string" },
        selectedParent: { type: ["string", "null"] }, selectedIds: { type: "array", items: { type: "string" } },
        branchIds: { type: "array", items: { type: "string" } }, originalHash: { type: "string" },
        originalEstimatedTokens: { type: "number", minimum: 0 },
        choices: { type: "array", description: "Only P/X overrides. Unlisted selectedIds imply M.",
            items: { type: "object", additionalProperties: false, required: ["id", "action", "protected", "hash", "projected"],
                properties: { id: { type: "string" }, action: { enum: ["pick", "remove"] },
                    protected: { type: "boolean" }, hash: { type: "string" }, projected: { type: "boolean" } } } },
    },
};
