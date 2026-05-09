import { complete, type UserMessage } from "@earendil-works/pi-ai";
import {
    BorderedLoader,
    type ExtensionCommandContext,
    type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { type ActionItem } from "./tree-utils.js";

export type RewritePart =
    | { kind: "pick"; item: ActionItem }
    | {
          kind: "summary";
          priority: "combined";
          text: string;
          sourceIds: string[];
          readFiles: string[];
          modifiedFiles: string[];
      };

const SYSTEM_PROMPT = `You summarize conversation history segments between a user and an expert coding agent inside the pi coding agent harness.

Input contains <summary-group> elements. Each <summary-group> should become exactly one combined summary.

Inside each summary group, prepared conversation content is wrapped in <importance level="high"> or <importance level="low"> tags.

Input may also contain top level <picked-verbatim-group> elements between summary groups. Conversation inside those tags will be kept verbatim and interspersed in order with the summaries you produce. Use that picked-verbatim context to make each summary coherent in its final surrounding context, but do not summarize or repeat picked-verbatim content unless needed as a brief reference.

Return ONLY JSON with this shape:
{"summary_groups":[{"id":"g1","summary":"..."}]}

Keep summary group order and ids exactly as given.

High-importance input should be preserved in detail and be mentioned prominently in output. Low-importance input should be summarized briefly: enough to preserve chronology, but not details.
Combine high and low importance inputs into one coherent summary per group.
Make summaries fit naturally before/after the picked-verbatim groups that surround them.
Do not invent facts.

Use the following format as guide for each summary:

## Goal
[What was the user trying to accomplish?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by the user]
- [omit if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes, omit section if none]

### In Progress
- [ ] [Work that was started but not finished, omit section if none]

### Blocked
- [Issues preventing progress, if any, omit section if none]

## Key Decisions
- **[Decision]**: [Brief rationale]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

type AgentMessage = any;
type FileOps = { read: Set<string>; written: Set<string>; edited: Set<string> };

function createFileOps(): FileOps {
    return { read: new Set(), written: new Set(), edited: new Set() };
}

function createCustomMessage(
    customType: string,
    content: any,
    display: boolean,
    details: any,
    timestamp: string,
): AgentMessage {
    return {
        role: "custom",
        customType,
        content,
        display,
        details,
        timestamp: new Date(timestamp).getTime(),
    };
}

function createBranchSummaryMessage(
    summary: string,
    fromId: string,
    timestamp: string,
): AgentMessage {
    return {
        role: "branchSummary",
        summary,
        fromId,
        timestamp: new Date(timestamp).getTime(),
    };
}

function createCompactionSummaryMessage(
    summary: string,
    tokensBefore: number,
    timestamp: string,
): AgentMessage {
    return {
        role: "compactionSummary",
        summary,
        tokensBefore,
        timestamp: new Date(timestamp).getTime(),
    };
}

/** Copied from pi's compaction getMessageFromEntry shape, with branch-summary behavior. */
export function getMessageFromEntry(
    entry: SessionEntry,
): AgentMessage | undefined {
    switch (entry.type) {
        case "message":
            // Match pi branch summarization: skip tool results; assistant tool calls carry the context.
            if (entry.message.role === "toolResult") return undefined;
            // Drop empty assistant/thinking-only envelopes. They do not serialize to useful
            // summary context and otherwise show up as empty assistant turns.
            if (
                entry.message.role === "assistant" &&
                !hasSubstantiveAssistantContent(entry.message)
            )
                return undefined;
            return entry.message;
        case "custom_message":
            return createCustomMessage(
                entry.customType,
                entry.content,
                entry.display,
                entry.details,
                entry.timestamp,
            );
        case "branch_summary":
            return createBranchSummaryMessage(
                entry.summary,
                entry.fromId,
                entry.timestamp,
            );
        case "compaction":
            return createCompactionSummaryMessage(
                entry.summary,
                entry.tokensBefore,
                entry.timestamp,
            );
        case "thinking_level_change":
        case "model_change":
        case "custom":
        case "label":
        case "session_info":
            return undefined;
    }
}

function hasSubstantiveAssistantContent(message: AgentMessage): boolean {
    if (!Array.isArray(message.content)) return false;
    if (message.errorMessage) return true;
    if (
        message.stopReason &&
        message.stopReason !== "stop" &&
        message.stopReason !== "toolUse"
    )
        return true;
    return message.content.some((block: any) => {
        if (!block || typeof block !== "object") return false;
        if (block.type === "text") return Boolean(block.text?.trim());
        if (block.type === "toolCall") return true;
        return false;
    });
}

function estimateTokens(message: AgentMessage): number {
    let chars = 0;
    switch (message.role) {
        case "user":
        case "custom":
        case "toolResult": {
            const content = message.content;
            if (typeof content === "string") chars = content.length;
            else if (Array.isArray(content))
                for (const block of content)
                    if (block.type === "text") chars += block.text?.length ?? 0;
            return Math.ceil(chars / 4);
        }
        case "assistant":
            for (const block of message.content ?? []) {
                if (block.type === "text") chars += block.text?.length ?? 0;
                else if (block.type === "thinking")
                    chars += block.thinking?.length ?? 0;
                else if (block.type === "toolCall")
                    chars +=
                        (block.name?.length ?? 0) +
                        JSON.stringify(block.arguments ?? {}).length;
            }
            return Math.ceil(chars / 4);
        case "bashExecution":
            return Math.ceil(
                ((message.command?.length ?? 0) +
                    (message.output?.length ?? 0)) /
                    4,
            );
        case "branchSummary":
        case "compactionSummary":
            return Math.ceil((message.summary?.length ?? 0) / 4);
        default:
            return 0;
    }
}

function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOps) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return;
    for (const block of message.content) {
        if (!block || block.type !== "toolCall") continue;
        const p =
            typeof block.arguments?.path === "string"
                ? block.arguments.path
                : undefined;
        if (!p) continue;
        if (block.name === "read") fileOps.read.add(p);
        else if (block.name === "write") fileOps.written.add(p);
        else if (block.name === "edit") fileOps.edited.add(p);
    }
}

/** Copied from pi's prepareBranchEntries algorithm, adapted for treebase. */
export function prepareBranchEntries(
    entries: SessionEntry[],
    tokenBudget = 0,
): { messages: AgentMessage[]; fileOps: FileOps; totalTokens: number } {
    const messages: AgentMessage[] = [];
    const fileOps = createFileOps();
    let totalTokens = 0;

    for (const entry of entries) {
        if (
            entry.type === "branch_summary" &&
            !entry.fromHook &&
            entry.details
        ) {
            const details = entry.details as {
                readFiles?: unknown;
                modifiedFiles?: unknown;
            };
            if (Array.isArray(details.readFiles))
                for (const f of details.readFiles)
                    if (typeof f === "string") fileOps.read.add(f);
            if (Array.isArray(details.modifiedFiles))
                for (const f of details.modifiedFiles)
                    if (typeof f === "string") fileOps.edited.add(f);
        }
    }

    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        const message = getMessageFromEntry(entry);
        if (!message) continue;
        extractFileOpsFromMessage(message, fileOps);
        const tokens = estimateTokens(message);
        if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
            if (
                (entry.type === "compaction" ||
                    entry.type === "branch_summary") &&
                totalTokens < tokenBudget * 0.9
            ) {
                messages.unshift(message);
                totalTokens += tokens;
            }
            break;
        }
        messages.unshift(message);
        totalTokens += tokens;
    }

    return { messages, fileOps, totalTokens };
}

function convertToLlm(messages: AgentMessage[]): AgentMessage[] {
    return messages
        .map((m) => {
            switch (m.role) {
                case "bashExecution":
                    if (m.excludeFromContext) return undefined;
                    return {
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: `Ran \`${m.command}\`\n\n${m.output || "(no output)"}`,
                            },
                        ],
                        timestamp: m.timestamp,
                    };
                case "custom":
                    return {
                        role: "user",
                        content:
                            typeof m.content === "string"
                                ? [{ type: "text", text: m.content }]
                                : m.content,
                        timestamp: m.timestamp,
                    };
                case "branchSummary":
                    return {
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: `The following is a summary of a branch that this conversation came back from:\n\n<summary>\n${m.summary}\n</summary>`,
                            },
                        ],
                        timestamp: m.timestamp,
                    };
                case "compactionSummary":
                    return {
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${m.summary}\n</summary>`,
                            },
                        ],
                        timestamp: m.timestamp,
                    };
                case "user":
                case "assistant":
                case "toolResult":
                    return m;
                default:
                    return undefined;
            }
        })
        .filter(Boolean);
}

function serializeConversation(messages: AgentMessage[]): string {
    const parts: string[] = [];
    for (const msg of messages) {
        if (msg.role === "user") {
            const content =
                typeof msg.content === "string"
                    ? msg.content
                    : (msg.content ?? [])
                          .filter((c: any) => c.type === "text")
                          .map((c: any) => c.text)
                          .join("");
            if (content) parts.push(`[User]: ${content}`);
        } else if (msg.role === "assistant") {
            const textParts: string[] = [];
            const thinkingParts: string[] = [];
            const toolCalls: string[] = [];
            for (const block of msg.content ?? []) {
                if (block.type === "text") textParts.push(block.text);
                else if (block.type === "thinking")
                    thinkingParts.push(block.thinking);
                else if (block.type === "toolCall")
                    toolCalls.push(
                        `${block.name}(${Object.entries(block.arguments ?? {})
                            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                            .join(", ")})`,
                    );
            }
            if (thinkingParts.length > 0)
                parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
            if (textParts.length > 0)
                parts.push(`[Assistant]: ${textParts.join("\n")}`);
            if (toolCalls.length > 0)
                parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
        }
    }
    return parts.join("\n\n");
}

function computeFileLists(fileOps: FileOps): { readFiles: string[]; modifiedFiles: string[] } {
    const modified = new Set([...fileOps.edited, ...fileOps.written]);
    const readFiles = [...fileOps.read].filter((f) => !modified.has(f)).sort();
    const modifiedFiles = [...modified].sort();
    return { readFiles, modifiedFiles };
}

function formatFileOperations(fileOps: FileOps): string {
    const { readFiles: readOnly, modifiedFiles } = computeFileLists(fileOps);
    const sections: string[] = [];
    if (readOnly.length > 0)
        sections.push(`<read-files>\n${readOnly.join("\n")}\n</read-files>`);
    if (modifiedFiles.length > 0)
        sections.push(
            `<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`,
        );
    return sections.length ? `\n${sections.join("\n\n")}` : "";
}

function groupSummaries(items: ActionItem[]) {
    const groups: Array<{ id: string; items: ActionItem[] }> = [];
    let current: (typeof groups)[number] | null = null;
    for (const item of items) {
        if (item.action === "pick") {
            current = null;
            continue;
        }
        if (item.action === "drop") continue;
        if (!current) {
            current = { id: `g${groups.length + 1}`, items: [] };
            groups.push(current);
        }
        current.items.push(item);
    }
    return groups;
}

function splitByImportance(
    items: ActionItem[],
): Array<{ level: "high" | "low"; items: ActionItem[] }> {
    const out: Array<{ level: "high" | "low"; items: ActionItem[] }> = [];
    let current: (typeof out)[number] | null = null;
    for (const item of items) {
        const level = item.action === "summarize-high" ? "high" : "low";
        if (!current || current.level !== level) {
            current = { level, items: [] };
            out.push(current);
        }
        current.items.push(item);
    }
    return out;
}

export function buildSummarizerUserMessage(items: ActionItem[]): string {
    const groups = groupSummaries(items);
    const groupIdByItem = new Map<string, string>();
    for (const group of groups)
        for (const item of group.items) groupIdByItem.set(item.id, group.id);

    const parts: string[] = [];
    const emittedSummaryGroups = new Set<string>();
    let pendingPicked: ActionItem[] = [];

    const flushPicked = () => {
        if (pendingPicked.length === 0) return;
        const prepared = prepareBranchEntries(
            pendingPicked.map((item) => item.entry),
        );
        const conversation = serializeConversation(
            convertToLlm(prepared.messages),
        );
        const files = formatFileOperations(prepared.fileOps);
        parts.push(
            `<picked-verbatim-group>\n<conversation>\n${conversation}\n</conversation>${files}\n</picked-verbatim-group>`,
        );
        pendingPicked = [];
    };

    for (const item of items) {
        if (item.action === "drop") continue;
        if (item.action === "pick") {
            pendingPicked.push(item);
            continue;
        }

        flushPicked();
        const groupId = groupIdByItem.get(item.id)!;
        if (emittedSummaryGroups.has(groupId)) continue;
        emittedSummaryGroups.add(groupId);
        const group = groups.find((g) => g.id === groupId)!;
        const sections = splitByImportance(group.items)
            .map((section) => {
                const prepared = prepareBranchEntries(
                    section.items.map((sectionItem) => sectionItem.entry),
                );
                const conversation = serializeConversation(
                    convertToLlm(prepared.messages),
                );
                const files = formatFileOperations(prepared.fileOps);
                return `<importance level="${section.level}" entryIds="${section.items.map((sectionItem) => sectionItem.id).join(",")}">\n<conversation>\n${conversation}\n</conversation>${files}\n</importance>`;
            })
            .join("\n---\n");
        parts.push(
            `<summary-group id="${group.id}">\n${sections}\n</summary-group>`,
        );
    }

    flushPicked();
    return parts.join("\n\n");
}

export async function buildRewrite(
    ctx: ExtensionCommandContext,
    items: ActionItem[],
): Promise<RewritePart[] | null> {
    const groups = groupSummaries(items);
    const summaries = new Map<string, string>();

    if (groups.length > 0) {
        if (!ctx.model) throw new Error("No model selected for summarization");
        const result = await ctx.ui.custom<string | null>(
            (tui: any, theme: any, _kb: any, done: any) => {
                const loader = new BorderedLoader(
                    tui,
                    theme,
                    `Treebase summarizing with ${ctx.model.id}...`,
                );
                loader.onAbort = () => done(null);
                const run = async () => {
                    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(
                        ctx.model,
                    );
                    if (!auth.ok || !auth.apiKey)
                        throw new Error(
                            auth.ok
                                ? `No API key for ${ctx.model.provider}`
                                : String(
                                      (auth as { error?: unknown }).error ??
                                          "auth failed",
                                  ),
                        );
                    const body = buildSummarizerUserMessage(items);
                    const msg: UserMessage = {
                        role: "user",
                        content: [{ type: "text", text: body }],
                        timestamp: Date.now(),
                    };
                    const response = await complete(
                        ctx.model,
                        { systemPrompt: SYSTEM_PROMPT, messages: [msg] },
                        {
                            apiKey: auth.apiKey,
                            headers: auth.headers,
                            signal: loader.signal,
                        },
                    );
                    if (response.stopReason === "aborted") return null;
                    return response.content
                        .filter((c: any) => c.type === "text")
                        .map((c: any) => c.text)
                        .join("\n");
                };
                run()
                    .then(done)
                    .catch((err) =>
                        done(
                            JSON.stringify({
                                error: String(err?.message ?? err),
                                groups: [],
                            }),
                        ),
                    );
                return loader;
            },
        );
        if (result === null) return null;
        let parsed: any;
        try {
            parsed = JSON.parse(
                result
                    .replace(/^```json\s*/i, "")
                    .replace(/```$/g, "")
                    .trim(),
            );
        } catch {
            throw new Error(
                `Could not parse summarizer JSON: ${result.slice(0, 500)}`,
            );
        }
        if (parsed.error) throw new Error(parsed.error);
        for (const g of parsed.summary_groups ?? [])
            summaries.set(g.id, String(g.summary ?? ""));
    }

    const groupByItem = new Map<string, string>();
    for (const g of groups)
        for (const item of g.items) groupByItem.set(item.id, g.id);
    const emittedGroups = new Set<string>();
    const parts: RewritePart[] = [];
    for (const item of items) {
        if (item.action === "drop") continue;
        if (item.action === "pick") {
            parts.push({ kind: "pick", item });
            continue;
        }
        const gid = groupByItem.get(item.id)!;
        if (emittedGroups.has(gid)) continue;
        emittedGroups.add(gid);
        const g = groups.find((x) => x.id === gid)!;
        const prepared = prepareBranchEntries(g.items.map((x) => x.entry));
        const { readFiles, modifiedFiles } = computeFileLists(prepared.fileOps);
        parts.push({
            kind: "summary",
            priority: "combined",
            text: summaries.get(gid) ?? "",
            sourceIds: g.items.map((x) => x.id),
            readFiles,
            modifiedFiles,
        });
    }
    return parts;
}
