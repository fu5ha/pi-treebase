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
    | "model"
    | "remove";

export type ActionItem = {
    index: number;
    id: string;
    entry: SessionEntry;
    action: TreebaseAction;
    groupId: string;
    depth: number;
    /** Structural/state records can only be preserved, never rewritten or removed. */
    protected?: boolean;
    protectedReason?: string;
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
        case "model":
            return "M";
        case "remove":
            return "X";
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
        const protectedReason = !isTreebaseActionableEntry(entry) ? "system / bookkeeping"
            : referencedIds.has(entry.id) ? "structural reference target"
            : visibleIds !== undefined && !visibleIds.has(entry.id) ? "inactive raw history"
            : undefined;
        const protectedEntry = protectedReason !== undefined;
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
            action: protectedEntry ? "pick" : "model",
            groupId, depth: 0, protected: protectedEntry, protectedReason,
        };
    });
    // Action/navigation groups are not dependencies. Only an assistant tool-call
    // envelope and its matching results must share protection. Multiple calls in
    // one envelope form a single dependency component, not a whole assistant turn.
    const calls = new Map<string, ActionItem[]>();
    const dependencies = new Map<string, Set<string>>();
    const connect = (a: string, b: string) => {
        if (!dependencies.has(a)) dependencies.set(a, new Set());
        if (!dependencies.has(b)) dependencies.set(b, new Set());
        dependencies.get(a)!.add(b);
        dependencies.get(b)!.add(a);
    };
    for (const item of items) {
        if (item.entry.type !== "message" || item.entry.message.role !== "assistant") continue;
        for (const block of item.entry.message.content) {
            if (block.type !== "toolCall") continue;
            const key = JSON.stringify([block.id, block.name]);
            const envelopes = calls.get(key) ?? [];
            envelopes.push(item);
            calls.set(key, envelopes);
        }
    }
    for (const item of items) {
        if (item.entry.type !== "message" || item.entry.message.role !== "toolResult") continue;
        const result = item.entry.message;
        for (const envelope of calls.get(JSON.stringify([result.toolCallId, result.toolName])) ?? [])
            connect(envelope.id, item.id);
    }
    const locked = new Map(items.filter(item => item.protected)
        .map(item => [item.id, { id: item.id, reason: item.protectedReason! }]));
    const queue = [...locked.keys()];
    for (let i = 0; i < queue.length; i++) {
        const id = queue[i];
        for (const dependency of dependencies.get(id) ?? []) {
            if (locked.has(dependency)) continue;
            locked.set(dependency, locked.get(id)!);
            queue.push(dependency);
        }
    }
    return items.map(item => {
        const origin = locked.get(item.id);
        return origin ? { ...item, protected: true, action: "pick",
            protectedReason: item.protectedReason ??
                `tool dependency on ${origin.id} (${origin.reason})` } : item;
    });
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

/** Report contradictions; never silently repair a user's P or X selection. */
export function actionDependencyErrors(items: ActionItem[], branch: SessionEntry[]): string[] {
    const actions = new Map(items.map((item) => [item.id, item.action]));
    const calls = new Map<string, { entry: SessionEntry; action: TreebaseAction }>();
    const results = new Map<string, { entry: SessionEntry; action: TreebaseAction }[]>();
    for (const entry of branch) {
        if (entry.type !== "message") continue;
        const action = actions.get(entry.id) ?? "pick";
        if (entry.message.role === "assistant") {
            for (const block of entry.message.content) {
                if (block.type === "toolCall") calls.set(block.id, { entry, action });
            }
        } else if (entry.message.role === "toolResult") {
            const id = entry.message.toolCallId;
            results.set(id, [...(results.get(id) ?? []), { entry, action }]);
        }
    }
    const errors: string[] = [];
    for (const [id, call] of calls) {
        for (const result of results.get(id) ?? []) {
            if ((call.action === "pick" && result.action === "remove")
                || (call.action === "remove" && result.action === "pick")) {
                errors.push(`Tool ${id}: ${call.entry.id} is ${actionLetter(call.action)}, but result ${result.entry.id} is ${actionLetter(result.action)}. Choose compatible actions.`);
            }
        }
    }
    return errors;
}
