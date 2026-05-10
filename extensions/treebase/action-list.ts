import {
    DynamicBorder,
    type ExtensionCommandContext,
    type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
    Container,
    getKeybindings,
    Key,
    matchesKey,
    Text,
    truncateToWidth,
} from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSummarizerUserMessage } from "./summarize.js";
import { actionLetter, type ActionItem, type TreebaseAction } from "./tree-utils.js";

type Theme = any;
type ToolCallInfo = { name: string; arguments: Record<string, any> };
type RowIndex = number;
type TurnIndex = number;
type GroupId = string;

type ActionRowKind =
    | "user-message"
    | "assistant-tool-envelope"
    | "assistant-intermediate"
    | "assistant-final"
    | "tool-result"
    | "custom-message"
    | "branch-summary"
    | "compaction"
    | "other-context";

type Turn = UserTurn | AssistantTurn | StandaloneTurn;

type BaseTurn = {
    index: TurnIndex;
    rowIndexes: RowIndex[];
};

type UserTurn = BaseTurn & { kind: "user" };
type AssistantTurn = BaseTurn & {
    kind: "assistant";
    toolEnvelopeRowIndexes: RowIndex[];
    intermediateRowIndexes: RowIndex[];
    toolResultRowIndexes: RowIndex[];
    finalRowIndex?: RowIndex;
};
type StandaloneTurn = BaseTurn & { kind: "standalone" };

type ActionRow = {
    index: RowIndex;
    source: ActionItem;
    entry: SessionEntry;
    kind: ActionRowKind;
    turnIndex?: TurnIndex;
    groupId?: GroupId;
    visible: boolean;
    actionable: boolean;
};

type ActionGroup = {
    id: GroupId;
    rowIndexes: RowIndex[];
    action: TreebaseAction;
};

type ActionModel = {
    rows: ActionRow[];
    turns: Turn[];
    groups: Map<GroupId, ActionGroup>;
    selectedVisibleIndex: number;
};

type VisibleActionRow = {
    rowIndex: RowIndex;
    groupId: GroupId;
    action: TreebaseAction;
    groupPosition: "only" | "first" | "middle" | "last";
};

function extractTextContent(content: any, maxLen = 200): string {
    if (typeof content === "string") return content.slice(0, maxLen);
    if (!Array.isArray(content)) return "";
    let result = "";
    for (const c of content) {
        if (c && typeof c === "object" && c.type === "text") {
            result += c.text;
            if (result.length >= maxLen) return result.slice(0, maxLen);
        }
    }
    return result;
}

function isHiddenToolCallEnvelope(entry: SessionEntry): boolean {
    if (entry.type !== "message" || entry.message?.role !== "assistant") return false;
    const msg = entry.message;
    const text = extractTextContent(msg.content).trim();
    if (text) return false;
    const isErrorOrAborted =
        msg.stopReason && msg.stopReason !== "stop" && msg.stopReason !== "toolUse";
    return !isErrorOrAborted && !msg.errorMessage;
}

function classifyRow(entry: SessionEntry, visible: boolean): ActionRowKind {
    if (entry.type === "message") {
        const role = entry.message?.role;
        if (role === "user") return "user-message";
        if (role === "toolResult") return "tool-result";
        if (role === "assistant") return visible ? "assistant-intermediate" : "assistant-tool-envelope";
        return "other-context";
    }
    if (entry.type === "custom_message") return "custom-message";
    if (entry.type === "branch_summary") return "branch-summary";
    if (entry.type === "compaction") return "compaction";
    return "other-context";
}

function makeModel(items: ActionItem[]): ActionModel {
    const rows: ActionRow[] = items.map((item, index) => {
        const visible = !isHiddenToolCallEnvelope(item.entry);
        return {
            index,
            source: item,
            entry: item.entry,
            kind: classifyRow(item.entry, visible),
            groupId: item.groupId,
            visible,
            actionable: true,
        };
    });

    const groups = new Map<GroupId, ActionGroup>();
    for (const row of rows) {
        const groupId = row.groupId ?? `row:${row.index}`;
        row.groupId = groupId;
        const existing = groups.get(groupId);
        if (existing) existing.rowIndexes.push(row.index);
        else groups.set(groupId, { id: groupId, rowIndexes: [row.index], action: row.source.action });
    }

    const turns: Turn[] = [];
    for (const group of groups.values()) {
        const groupRows = group.rowIndexes.map((i) => rows[i]);
        const hasAssistantTurnRows = groupRows.some((row) =>
            row.entry.type === "message" &&
            (row.entry.message?.role === "assistant" || row.entry.message?.role === "toolResult"),
        );
        const turnIndex = turns.length;
        let turn: Turn;
        if (hasAssistantTurnRows) {
            const visibleAssistantRows = groupRows.filter(
                (row) => row.visible && row.entry.type === "message" && row.entry.message?.role === "assistant",
            );
            const finalRowIndex = visibleAssistantRows.at(-1)?.index;
            if (finalRowIndex !== undefined) rows[finalRowIndex].kind = "assistant-final";
            turn = {
                kind: "assistant",
                index: turnIndex,
                rowIndexes: group.rowIndexes.slice(),
                toolEnvelopeRowIndexes: groupRows
                    .filter((row) => row.kind === "assistant-tool-envelope")
                    .map((row) => row.index),
                intermediateRowIndexes: groupRows
                    .filter((row) => row.entry.type === "message" && row.entry.message?.role === "assistant" && row.index !== finalRowIndex)
                    .map((row) => row.index),
                toolResultRowIndexes: groupRows
                    .filter((row) => row.kind === "tool-result")
                    .map((row) => row.index),
                finalRowIndex,
            };
        } else if (groupRows.some((row) => row.kind === "user-message")) {
            turn = { kind: "user", index: turnIndex, rowIndexes: group.rowIndexes.slice() };
        } else {
            turn = { kind: "standalone", index: turnIndex, rowIndexes: group.rowIndexes.slice() };
        }
        for (const rowIndex of turn.rowIndexes) rows[rowIndex].turnIndex = turnIndex;
        turns.push(turn);
    }

    return { rows, turns, groups, selectedVisibleIndex: Math.max(0, rows.filter((row) => row.visible).length - 1) };
}

function getVisibleRows(model: ActionModel): VisibleActionRow[] {
    const visible = model.rows
        .filter((row) => row.visible)
        .map((row) => {
            const groupId = row.groupId ?? `row:${row.index}`;
            const action = model.groups.get(groupId)?.action ?? "summarize-low";
            return { rowIndex: row.index, groupId, action, groupPosition: "only" as const };
        });

    return visible.map((row, i) => {
        const samePrev = visible[i - 1]?.groupId === row.groupId;
        const sameNext = visible[i + 1]?.groupId === row.groupId;
        return {
            ...row,
            groupPosition: !samePrev && !sameNext ? "only" : !samePrev ? "first" : !sameNext ? "last" : "middle",
        };
    });
}

function setGroupAction(model: ActionModel, groupId: GroupId, action: TreebaseAction): void {
    const group = model.groups.get(groupId);
    if (group) group.action = action;
}

function replaceTurnGroups(model: ActionModel, turn: Turn, groups: ActionGroup[]): void {
    for (const rowIndex of turn.rowIndexes) {
        const groupId = model.rows[rowIndex].groupId;
        if (groupId) model.groups.delete(groupId);
    }
    for (const group of groups) {
        model.groups.set(group.id, group);
        for (const rowIndex of group.rowIndexes) model.rows[rowIndex].groupId = group.id;
    }
}

function setWholeTurnAction(model: ActionModel, turn: Turn, action: TreebaseAction): void {
    replaceTurnGroups(model, turn, [{ id: `turn:${turn.index}:all`, rowIndexes: turn.rowIndexes.slice(), action }]);
}

function splitAssistantTurn(
    model: ActionModel,
    turn: AssistantTurn,
    intermediateAction: TreebaseAction,
    finalAction: TreebaseAction,
): void {
    if (turn.finalRowIndex === undefined) return setWholeTurnAction(model, turn, intermediateAction);
    const intermediateRows = turn.rowIndexes.filter((i) => i !== turn.finalRowIndex);
    replaceTurnGroups(model, turn, [
        { id: `turn:${turn.index}:intermediate`, rowIndexes: intermediateRows, action: intermediateAction },
        { id: `turn:${turn.index}:final`, rowIndexes: [turn.finalRowIndex], action: finalAction },
    ]);
}

function joinAssistantTurn(model: ActionModel, turn: AssistantTurn, action: TreebaseAction): void {
    setWholeTurnAction(model, turn, action);
}

function getAssistantTurnGroups(model: ActionModel, turn: AssistantTurn): ActionGroup[] {
    const seen = new Set<GroupId>();
    const groups: ActionGroup[] = [];
    for (const rowIndex of turn.rowIndexes) {
        const groupId = model.rows[rowIndex].groupId;
        if (!groupId || seen.has(groupId)) continue;
        const group = model.groups.get(groupId);
        if (!group) continue;
        seen.add(groupId);
        groups.push(group);
    }
    return groups;
}

function normalizeAssistantTurnGroups(model: ActionModel, turn: AssistantTurn): void {
    const groups = getAssistantTurnGroups(model, turn);
    if (groups.length <= 1) return;
    const firstAction = groups[0].action;
    if (groups.every((group) => group.action === firstAction)) {
        joinAssistantTurn(model, turn, firstAction);
    }
}

function setRowActionInAssistantTurn(
    model: ActionModel,
    turn: AssistantTurn,
    rowIndex: RowIndex,
    action: TreebaseAction,
): void {
    const selectedGroupId = model.rows[rowIndex].groupId;
    if (!selectedGroupId) return;

    if (turn.finalRowIndex === undefined) {
        setGroupAction(model, selectedGroupId, action);
        return normalizeAssistantTurnGroups(model, turn);
    }

    const finalGroupId = model.rows[turn.finalRowIndex].groupId;
    const finalGroup = finalGroupId ? model.groups.get(finalGroupId) : undefined;
    const turnIsUnified = selectedGroupId === finalGroupId;
    const selectedIsFinal = rowIndex === turn.finalRowIndex;

    // The one special case: while an assistant turn is unified, changing a
    // tool/intermediate row must split it so the final response keeps its
    // existing action. After a turn is already split, generic group mutation +
    // normalization handles both edits and re-joins.
    if (turnIsUnified && !selectedIsFinal && finalGroup && action !== finalGroup.action) {
        splitAssistantTurn(model, turn, action, finalGroup.action);
        return;
    }

    setGroupAction(model, selectedGroupId, action);
    normalizeAssistantTurnGroups(model, turn);
}

function setRowAction(model: ActionModel, rowIndex: RowIndex, action: TreebaseAction): void {
    const row = model.rows[rowIndex];
    if (!row?.actionable || !row.groupId) return;
    const turn = row.turnIndex !== undefined ? model.turns[row.turnIndex] : undefined;
    if (turn?.kind === "assistant") setRowActionInAssistantTurn(model, turn, rowIndex, action);
    else setGroupAction(model, row.groupId, action);
}

function toActionItems(model: ActionModel): ActionItem[] {
    return model.rows.map((row) => {
        const groupId = row.groupId ?? row.source.groupId;
        return {
            ...row.source,
            action: model.groups.get(groupId)?.action ?? row.source.action,
            groupId,
        };
    });
}

class ActionList {
    private model: ActionModel;
    private toolCallMap = new Map<string, ToolCallInfo>();
    private maxVisibleLines: number;

    constructor(
        items: ActionItem[],
        private done: (items: ActionItem[] | null) => void,
        private theme: Theme,
        terminalHeight: number,
        private ctx: ExtensionCommandContext,
    ) {
        this.model = makeModel(items);
        this.maxVisibleLines = Math.max(8, Math.floor(terminalHeight / 2));
        this.buildToolCallMap();
    }

    invalidate() {}

    private buildToolCallMap() {
        this.toolCallMap.clear();
        for (const row of this.model.rows) {
            const entry = row.entry;
            if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
            const content = entry.message.content;
            if (!Array.isArray(content)) continue;
            for (const block of content) {
                if (block && typeof block === "object" && block.type === "toolCall") {
                    this.toolCallMap.set(block.id, { name: block.name, arguments: block.arguments ?? {} });
                }
            }
        }
    }

    render(width: number): string[] {
        const visible = getVisibleRows(this.model);
        if (visible.length === 0) return [truncateToWidth(this.theme.fg("muted", "  No entries on path"), width)];
        this.model.selectedVisibleIndex = Math.max(0, Math.min(this.model.selectedVisibleIndex, visible.length - 1));
        const lines: string[] = [];
        const start = Math.max(
            0,
            Math.min(this.model.selectedVisibleIndex - Math.floor(this.maxVisibleLines / 2), visible.length - this.maxVisibleLines),
        );
        const end = Math.min(visible.length, start + this.maxVisibleLines);

        for (let i = start; i < end; i++) {
            const view = visible[i];
            const row = this.model.rows[view.rowIndex];
            const isSelected = i === this.model.selectedVisibleIndex;
            const cursor = isSelected ? this.theme.fg("accent", "› ") : "  ";
            const action = this.formatAction(
                view.action,
                row.kind === "assistant-intermediate" || row.kind === "tool-result",
            );
            const prefix = this.formatGroupPrefix(view.groupPosition);
            const content = this.getEntryDisplayText(row.entry, isSelected);
            let line = cursor + action + " " + this.theme.fg("dim", prefix) + content;
            if (isSelected) line = this.theme.bg("selectedBg", line);
            lines.push(truncateToWidth(line, width));
        }

        lines.push(
            truncateToWidth(
                this.theme.fg(
                    "muted",
                    `  (${this.model.selectedVisibleIndex + 1}/${visible.length})`,
                ),
                width,
            ),
        );
        lines.push(
            truncateToWidth(
                this.theme.fg(
                    "muted",
                    "  ↑/↓: move. ←/→: prev/next group. P/H/L/D: set group action. Enter: confirm. Esc: cancel.",
                ),
                width,
            ),
        );
        lines.push(
            truncateToWidth(
                this.theme.fg(
                    "dim",
                    "   Shift+Enter write message that would have been sent to summarizer model to disk and cancel.",
                ),
                width,
            ),
        );
        return lines;
    }

    private formatAction(
        action: TreebaseAction,
        subtle: boolean,
    ): string {
        const letter = actionLetter(action);
        const label = subtle ? `|${letter}|` : `[${letter}]`;
        const styled = (() => {
            switch (action) {
                case "pick": return this.theme.fg("warning", label);
                case "summarize-high": return this.theme.fg("accent", label);
                case "summarize-low": return this.theme.fg("success", label);
                case "drop": return this.theme.fg("error", label);
            }
        })();
        return subtle ? styled : this.theme.bold(styled);
    }

    private formatGroupPrefix(position: VisibleActionRow["groupPosition"]): string {
        if (position === "only") return "── ";
        if (position === "first") return "┌─ ";
        if (position === "last") return "└─ ";
        return "│  ";
    }

    private setCurrent(action: TreebaseAction) {
        const selected = getVisibleRows(this.model)[this.model.selectedVisibleIndex];
        if (selected) setRowAction(this.model, selected.rowIndex, action);
    }

    private jumpGroup(direction: "up" | "down") {
        const visible = getVisibleRows(this.model);
        const current = visible[this.model.selectedVisibleIndex]?.groupId;
        if (!current) return;

        if (direction === "up") {
            let firstOfCurrent = this.model.selectedVisibleIndex;
            while (firstOfCurrent > 0 && visible[firstOfCurrent - 1].groupId === current) firstOfCurrent--;
            this.model.selectedVisibleIndex = firstOfCurrent === 0 ? 0 : firstOfCurrent - 1;
        } else {
            let lastOfCurrent = this.model.selectedVisibleIndex;
            while (lastOfCurrent < visible.length - 1 && visible[lastOfCurrent + 1].groupId === current) lastOfCurrent++;
            if (lastOfCurrent >= visible.length - 1) {
                this.model.selectedVisibleIndex = visible.length - 1;
                return;
            }
            const nextGroup = visible[lastOfCurrent + 1].groupId;
            let lastOfNext = lastOfCurrent + 1;
            while (lastOfNext < visible.length - 1 && visible[lastOfNext + 1].groupId === nextGroup) lastOfNext++;
            this.model.selectedVisibleIndex = lastOfNext;
        }
    }

    handleInput(data: string) {
        const kb = getKeybindings();
        const visibleLength = getVisibleRows(this.model).length;
        if (visibleLength === 0) return;
        if (kb.matches(data, "tui.select.up") || matchesKey(data, Key.up)) {
            this.model.selectedVisibleIndex = this.model.selectedVisibleIndex === 0 ? visibleLength - 1 : this.model.selectedVisibleIndex - 1;
        } else if (kb.matches(data, "tui.select.down") || matchesKey(data, Key.down)) {
            this.model.selectedVisibleIndex = this.model.selectedVisibleIndex === visibleLength - 1 ? 0 : this.model.selectedVisibleIndex + 1;
        } else if (kb.matches(data, "app.tree.foldOrUp") || kb.matches(data, "tui.editor.cursorLeft") || matchesKey(data, Key.left)) {
            this.jumpGroup("up");
        } else if (kb.matches(data, "app.tree.unfoldOrDown") || kb.matches(data, "tui.editor.cursorRight") || matchesKey(data, Key.right)) {
            this.jumpGroup("down");
        } else if (matchesKey(data, Key.shift("enter")) || kb.matches(data, "tui.input.newLine")) {
            this.writeSummarizerMessageAndCancel();
        } else if (kb.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) {
            this.done(toActionItems(this.model));
        } else if (kb.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) {
            this.done(null);
        } else if (data.toLowerCase() === "p") this.setCurrent("pick");
        else if (data.toLowerCase() === "h") this.setCurrent("summarize-high");
        else if (data.toLowerCase() === "l") this.setCurrent("summarize-low");
        else if (data.toLowerCase() === "d") this.setCurrent("drop");
    }

    private writeSummarizerMessageAndCancel(): void {
        const message = buildSummarizerUserMessage(toActionItems(this.model));
        const tmpFile = path.join(os.tmpdir(), `pi-treebase-summarizer-message-${Date.now()}.xml`);
        fs.writeFileSync(tmpFile, message || "<!-- No summarize-high/summarize-low groups selected. -->\n", "utf-8");
        this.ctx.ui.notify(`Treebase summarizer message written to: ${tmpFile}`, "info");
        this.done(null);
    }

    private getEntryDisplayText(entry: SessionEntry, isSelected: boolean): string {
        const normalize = (s: string) => s.replace(/[\n\t]/g, " ").trim();
        let result = "";
        switch (entry.type) {
            case "message": {
                const msg = entry.message;
                const role = msg.role;
                if (role === "user") result = this.theme.fg("accent", "user: ") + normalize(this.extractContent(msg.content));
                else if (role === "assistant") {
                    const textContent = normalize(this.extractContent(msg.content));
                    if (textContent) result = this.theme.fg("success", "assistant: ") + textContent;
                    else if (msg.stopReason === "aborted") result = this.theme.fg("success", "assistant: ") + this.theme.fg("muted", "(aborted)");
                    else if (msg.errorMessage) result = this.theme.fg("success", "assistant: ") + this.theme.fg("error", normalize(msg.errorMessage).slice(0, 80));
                    else result = this.theme.fg("success", "assistant: ") + this.theme.fg("muted", "(no content)");
                } else if (role === "toolResult") {
                    const toolCall = msg.toolCallId ? this.toolCallMap.get(msg.toolCallId) : undefined;
                    result = this.theme.fg("muted", toolCall ? this.formatToolCall(toolCall.name, toolCall.arguments) : `[${msg.toolName ?? "tool"}]`);
                } else if (role === "bashExecution") result = this.theme.fg("dim", `[bash]: ${normalize(msg.command ?? "")}`);
                else result = this.theme.fg("dim", `[${role}]`);
                break;
            }
            case "custom_message": {
                const content = typeof entry.content === "string" ? entry.content : (entry.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
                result = this.theme.fg("customMessageLabel", `[${entry.customType}]: `) + normalize(content);
                break;
            }
            case "compaction":
                result = this.theme.fg("borderAccent", `[compaction: ${Math.round((entry.tokensBefore ?? 0) / 1000)}k tokens]`);
                break;
            case "branch_summary":
                result = this.theme.fg("warning", "[branch summary]: ") + normalize(entry.summary ?? "");
                break;
            case "model_change":
                result = this.theme.fg("dim", `[model: ${entry.modelId}]`);
                break;
            case "thinking_level_change":
                result = this.theme.fg("dim", `[thinking: ${entry.thinkingLevel}]`);
                break;
            case "custom":
                result = this.theme.fg("dim", `[custom: ${entry.customType}]`);
                break;
            case "label":
                result = this.theme.fg("dim", `[label: ${entry.label ?? "(cleared)"}]`);
                break;
            case "session_info":
                result = entry.name ? this.theme.fg("dim", `[title: ${entry.name}]`) : this.theme.fg("dim", "[title: empty]");
                break;
            default:
                result = this.theme.fg("dim", `[unknown]`);
        }
        return isSelected ? this.theme.bold(result) : result;
    }

    private extractContent(content: any): string { return extractTextContent(content); }

    private formatToolCall(name: string, args: Record<string, any>): string {
        const shortenPath = (p: string) => {
            const home = process.env.HOME || process.env.USERPROFILE || "";
            return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
        };
        switch (name) {
            case "read": {
                const path = shortenPath(String(args.path || args.file_path || ""));
                const offset = args.offset;
                const limit = args.limit;
                let display = path;
                if (offset !== undefined || limit !== undefined) {
                    const start = offset ?? 1;
                    const end = limit !== undefined ? start + limit - 1 : "";
                    display += `:${start}${end ? `-${end}` : ""}`;
                }
                return `[read: ${display}]`;
            }
            case "write": return `[write: ${shortenPath(String(args.path || args.file_path || ""))}]`;
            case "edit": return `[edit: ${shortenPath(String(args.path || args.file_path || ""))}]`;
            case "bash": {
                const rawCmd = String(args.command || "");
                const cmd = rawCmd.replace(/[\n\t]/g, " ").trim().slice(0, 50);
                return `[bash: ${cmd}${rawCmd.length > 50 ? "..." : ""}]`;
            }
            case "grep": return `[grep: /${String(args.pattern || "")}/ in ${shortenPath(String(args.path || "."))}]`;
            case "find": return `[find: ${String(args.pattern || "") } in ${shortenPath(String(args.path || "."))}]`;
            case "ls": return `[ls: ${shortenPath(String(args.path || "."))}]`;
            default: {
                const raw = JSON.stringify(args ?? {});
                const argsStr = raw.slice(0, 40);
                return `[${name}: ${argsStr}${raw.length > 40 ? "..." : ""}]`;
            }
        }
    }
}

export async function showActionList(
    ctx: ExtensionCommandContext,
    initialItems: ActionItem[],
): Promise<ActionItem[] | null> {
    return ctx.ui.custom((tui: any, theme: any, _kb: any, done: any) => {
        const terminalHeight = tui?.terminal?.rows ?? process.stdout.rows ?? 40;
        const container = new Container();
        const list = new ActionList(initialItems, done, theme, terminalHeight, ctx);
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        container.addChild(new Text(theme.fg("accent", theme.bold("Treebase Actions")), 1, 0));
        container.addChild(
            new Text(
                theme.fg(
                    "muted",
                    "Choose what should happen to each group. P - pick, H / L - summarize with high or low importance, D - drop",
                ),
                1,
                0,
            ),
        );
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        container.addChild(list);
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        return {
            render: (w: number) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => {
                list.handleInput(data);
                tui.requestRender();
            },
        };
    });
}
