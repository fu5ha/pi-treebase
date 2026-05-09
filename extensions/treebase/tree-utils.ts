import type {
    SessionEntry,
    SessionManager,
} from "@earendil-works/pi-coding-agent";

export type { SessionEntry };
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
    id: string;
    entry: SessionEntry;
    action: TreebaseAction;
    groupId: string;
    depth: number;
};

export function isAncestor(
    sessionManager: SessionManager,
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
    sessionManager: SessionManager,
    ancestorId: string,
    leafId: string,
): SessionEntry[] {
    const branch = sessionManager.getBranch(leafId);
    const start = branch.findIndex((entry) => entry.id === ancestorId);
    return start >= 0 ? branch.slice(start) : [];
}

export function parentOf(
    sessionManager: SessionManager,
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
        case "custom_message":
        case "branch_summary":
        case "compaction":
            return true;
        // These entries either do not participate in LLM context, are session
        // metadata, or are settings that should not be exposed as treebase
        // action rows / summary input.
        case "thinking_level_change":
        case "model_change":
        case "label":
        case "session_info":
        case "custom":
            return false;
        default:
            return false;
    }
}

export function filterActionableEntries(entries: SessionEntry[]): SessionEntry[] {
    return entries.filter(isTreebaseActionableEntry);
}

export function makeActionItems(entries: SessionEntry[]): ActionItem[] {
    const actionableEntries = filterActionableEntries(entries);
    let turn = 0;
    let assistantGroupId: string | null = null;

    return actionableEntries.map((entry) => {
        const role =
            entry.type === "message" ? entry.message?.role : entry.type;
        let groupId: string;

        if (role === "user") {
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

        return { id: entry.id, entry, action: "summarize-low", groupId, depth: 0 };
    });
}

export function setGroupAction(
    items: ActionItem[],
    groupId: string,
    action: TreebaseAction,
): ActionItem[] {
    return items.map((item) =>
        item.groupId === groupId ? { ...item, action } : item,
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
    return `[${entry.type}]`;
}

export function serializeEntryForSummary(entry: SessionEntry): string {
    return JSON.stringify(entry, null, 2);
}
