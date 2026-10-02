import type {
    SessionManager,
    SessionEntry,
    SessionProjection,
} from "@earendil-works/pi-coding-agent";

export type { SessionEntry };
type HistoryReader = Pick<SessionManager, "getEntry" | "getBranch">;
export type TreeNode = {
    entry: SessionEntry;
    children: TreeNode[];
    label?: string;
    labelTimestamp?: string;
};

export type TreebaseAction =
    | "pick"
    | "summarize-high"
    | "summarize-low"
    | "drop";

export type ActionItem = {
    index: number;
    id: string;
    entry: SessionEntry;
    action: TreebaseAction;
    groupId: string;
    depth: number;
    /** Structural/state records can only be preserved, never summarized or dropped. */
    protected?: boolean;
};

export function isAncestor(
    sessionManager: HistoryReader,
    ancestorId: string | null,
    descendantId: string | null,
): boolean {
    if (ancestorId === null) return true;
    if (!ancestorId || !descendantId) return false;
    let current = sessionManager.getEntry(descendantId);
    while (current) {
        if (current.id === ancestorId) return true;
        current = current.parentId
            ? sessionManager.getEntry(current.parentId)
            : undefined;
    }
    return false;
}

export function entriesBetweenAncestorAndLeaf(
    sessionManager: HistoryReader,
    ancestorId: string,
    leafId: string,
): SessionEntry[] {
    const branch = sessionManager.getBranch(leafId);
    const start = branch.findIndex((entry) => entry.id === ancestorId);
    return start >= 0 ? branch.slice(start) : [];
}

export function parentOf(
    sessionManager: HistoryReader,
    entryId: string,
): string | null {
    return sessionManager.getEntry(entryId)?.parentId ?? null;
}

export function actionLetter(action: TreebaseAction): string {
    switch (action) {
        case "pick":
            return "P";
        case "summarize-high":
            return "H";
        case "summarize-low":
            return "L";
        case "drop":
            return "D";
    }
}

export function isTreebaseActionableEntry(entry: SessionEntry): boolean {
    switch (entry.type) {
        case "message":
            return ["user", "assistant", "toolResult", "bashExecution"].includes(entry.message.role);
        case "custom_message":
        case "branch_summary":
            return true;
        // Structural/state entries are shown, but never offered normal actions.
        case "thinking_level_change":
        case "model_change":
        case "label":
        case "session_info":
        case "custom":
        case "context_edit":
        case "usage":
        case "compaction":
            return false;
        default:
            return false;
    }
}

export function filterActionableEntries(entries: SessionEntry[]): SessionEntry[] {
    return entries.filter(isTreebaseActionableEntry);
}

export function makeActionItems(entries: SessionEntry[], projection?: SessionProjection): ActionItem[] {
    const visibleIds = projection
        ? new Set(projection.entries.filter((entry) => entry.messages.length > 0).map((entry) => entry.sourceEntry.id))
        : undefined;
    const referencedIds = new Set(entries.flatMap((entry) => {
        if (entry.type === "context_edit" || entry.type === "label") return [entry.targetId];
        if (entry.type === "compaction") return [entry.firstKeptEntryId];
        return [];
    }));
    let turn = 0;
    let assistantGroupId: string | null = null;

    const items: ActionItem[] = entries.map((entry, index) => {
        const protectedEntry = !isTreebaseActionableEntry(entry)
            || referencedIds.has(entry.id)
            || (visibleIds !== undefined && !visibleIds.has(entry.id));
        const role =
            entry.type === "message" ? entry.message?.role : entry.type;
        let groupId: string;

        if (role === "system" || (entry.type !== "message" && !isTreebaseActionableEntry(entry))
            || (entry.type === "message" && !["user", "assistant", "toolResult", "bashExecution"].includes(role))) {
            // State updates are separate rows, but must not sever an assistant
            // call/result group that spans them.
            groupId = `preserve-${entry.id}`;
        } else if (role === "user") {
            turn++;
            assistantGroupId = null;
            groupId = `turn-${turn}-user`;
        } else if (role === "assistant" || role === "toolResult") {
            if (!assistantGroupId) {
                if (turn === 0) turn++;
                assistantGroupId = `turn-${turn}-assistant`;
            }
            groupId = assistantGroupId;
        } else {
            // Context-bearing non-message entries (branch summaries,
            // compactions, custom messages) are separate action groups unless
            // they occur before any user message, in which case create an
            // initial group for them.
            if (turn === 0) turn++;
            assistantGroupId = null;
            groupId = `turn-${turn}-${entry.type}-${entry.id}`;
        }

        return {
            index, id: entry.id, entry,
            action: protectedEntry ? "pick" : "summarize-low",
            groupId, depth: 0, protected: protectedEntry,
        };
    });
    // A referenced or inactive assistant envelope must keep its matching tool
    // results, even when only one member was directly protected.
    const protectedGroups = new Set(items.filter((item) => item.protected).map((item) => item.groupId));
    return items.map((item) => protectedGroups.has(item.groupId)
        ? { ...item, protected: true, action: "pick" }
        : item);
}

export function setGroupAction(
    items: ActionItem[],
    groupId: string,
    action: TreebaseAction,
): ActionItem[] {
    return items.map((item) =>
        item.groupId === groupId && !item.protected ? { ...item, action } : item,
    );
}

export function entryTitle(entry: SessionEntry): string {
    const normalize = (s: string) => s.replace(/[\r\n\t]+/g, " ").trim();
    const textFromContent = (content: any): string => {
        if (typeof content === "string")
            return normalize(content).slice(0, 180);
        if (Array.isArray(content))
            return normalize(
                content
                    .filter((c) => c?.type === "text")
                    .map((c) => c.text)
                    .join(" "),
            ).slice(0, 180);
        return "";
    };
    if (entry.type === "message") {
        const msg = entry.message as any;
        const role = msg?.role ?? "message";
        if (role === "system") return systemUpdateTitle(msg);
        if (role === "toolResult")
            return `[tool result: ${msg.toolName ?? msg.toolCallId ?? "tool"}]`;
        return `${role}: ${textFromContent(msg?.content) || "(no text)"}`;
    }
    if (entry.type === "custom_message")
        return `[${entry.customType}]: ${textFromContent(entry.content)}`;
    if (entry.type === "branch_summary")
        return `[branch summary]: ${normalize(entry.summary ?? "")}`;
    if (entry.type === "compaction")
        return `[compaction: ${Math.round((entry.tokensBefore ?? 0) / 1000)}k tokens]`;
    if (entry.type === "model_change") return `[model: ${entry.modelId}]`;
    if (entry.type === "thinking_level_change")
        return `[thinking: ${entry.thinkingLevel}]`;
    if (entry.type === "context_edit")
        return `[context edit: ${entry.replacement === null ? "omit" : "replace"} ${entry.targetId}]`;
    if (entry.type === "usage")
        return `[usage: ${entry.kind}, ${entry.provider}/${entry.model}]`;
    return `[${entry.type}]`;
}

/** Describe prompt/tool deltas without putting the entire system prompt in a row. */
export function systemUpdateTitle(message: {
    sections?: Record<string, string | null>;
    toolsAdded?: { name: string }[];
    toolsRemoved?: { name: string }[];
    replace?: boolean;
}): string {
    const changes: string[] = [message.replace ? "replacement" : "update"];
    for (const [name, content] of Object.entries(message.sections ?? {})) {
        changes.push(`${content === null ? "remove" : "replace"} section ${name}`);
    }
    if (message.toolsAdded?.length) changes.push(`tools +${message.toolsAdded.map((t) => t.name).join(", ")}`);
    if (message.toolsRemoved?.length) changes.push(`tools -${message.toolsRemoved.map((t) => t.name).join(", ")}`);
    return `[system: ${changes.join("; ")}]`;
}

export function serializeEntryForSummary(entry: SessionEntry): string {
    return JSON.stringify(entry, null, 2);
}
