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
import {
    actionLetter,
    setGroupAction,
    type ActionItem,
    type TreebaseAction,
} from "./tree-utils.js";

type Theme = any;
type ToolCallInfo = { name: string; arguments: Record<string, any> };

class ActionList {
    private selected = 0;
    private toolCallMap = new Map<string, ToolCallInfo>();
    private maxVisibleLines: number;

    constructor(
        private items: ActionItem[],
        private done: (items: ActionItem[] | null) => void,
        private theme: Theme,
        terminalHeight: number,
        private ctx: ExtensionCommandContext,
    ) {
        this.maxVisibleLines = Math.max(8, Math.floor(terminalHeight / 2));
        this.buildToolCallMap();
        // Start at the newest visible entry. Items remain chronological for
        // rewrite output; only the editor cursor starts at the bottom.
        this.selected = Math.max(0, this.visibleItems().length - 1);
    }

    invalidate() {}

    private buildToolCallMap() {
        this.toolCallMap.clear();
        for (const item of this.items) {
            const entry = item.entry;
            if (entry.type !== "message" || entry.message?.role !== "assistant")
                continue;
            const content = entry.message.content;
            if (!Array.isArray(content)) continue;
            for (const block of content) {
                if (
                    block &&
                    typeof block === "object" &&
                    block.type === "toolCall"
                ) {
                    this.toolCallMap.set(block.id, {
                        name: block.name,
                        arguments: block.arguments ?? {},
                    });
                }
            }
        }
    }

    render(width: number): string[] {
        const visible = this.visibleItems();
        if (visible.length === 0)
            return [
                truncateToWidth(
                    this.theme.fg("muted", "  No entries on path"),
                    width,
                ),
            ];
        this.selected = Math.max(
            0,
            Math.min(this.selected, visible.length - 1),
        );
        const lines: string[] = [];
        const start = Math.max(
            0,
            Math.min(
                this.selected - Math.floor(this.maxVisibleLines / 2),
                visible.length - this.maxVisibleLines,
            ),
        );
        const end = Math.min(visible.length, start + this.maxVisibleLines);

        for (let i = start; i < end; i++) {
            const item = visible[i];
            const isSelected = i === this.selected;
            const cursor = isSelected ? this.theme.fg("accent", "› ") : "  ";
            const action = this.formatAction(item.action, isSelected);
            const prefix = this.formatGroupPrefix(visible, i);
            const content = this.getEntryDisplayText(item.entry, isSelected);
            let line =
                cursor + action + " " + this.theme.fg("dim", prefix) + content;
            if (isSelected) line = this.theme.bg("selectedBg", line);
            lines.push(truncateToWidth(line, width));
        }

        lines.push(
            truncateToWidth(
                this.theme.fg(
                    "muted",
                    `  (${this.selected + 1}/${visible.length}, ${this.items.length - visible.length} hidden tool-call envelope entr${this.items.length - visible.length === 1 ? "y" : "ies"})  Actions apply to whole turns`,
                ),
                width,
            ),
        );
        lines.push(
            truncateToWidth(
                this.theme.fg(
                    "muted",
                    "  ↑/↓: move. ←/→: prev/next group. P/H/L/D: set group. Shift+Enter: write summarizer message and cancel. Enter: confirm. Esc: cancel.",
                ),
                width,
            ),
        );
        return lines;
    }

    private visibleItems(): ActionItem[] {
        return this.items.filter(
            (item) => !this.isHiddenToolCallEnvelope(item.entry),
        );
    }

    private isHiddenToolCallEnvelope(entry: SessionEntry): boolean {
        if (entry.type !== "message" || entry.message?.role !== "assistant")
            return false;
        const msg = entry.message;
        const text = this.extractContent(msg.content).trim();
        if (text) return false;
        const isErrorOrAborted =
            msg.stopReason &&
            msg.stopReason !== "stop" &&
            msg.stopReason !== "toolUse";
        return !isErrorOrAborted && !msg.errorMessage;
    }

    private formatAction(action: TreebaseAction, isSelected: boolean): string {
        const letter = actionLetter(action);
        const label = `[${letter}]`;
        const styled = (() => {
            switch (action) {
                case "pick":
                    return this.theme.fg("success", label);
                case "summarize-high":
                    return this.theme.fg("accent", label);
                case "summarize-low":
                    return this.theme.fg("warning", label);
                case "drop":
                    return this.theme.fg("error", label);
            }
        })();
        return isSelected ? this.theme.bold(styled) : styled;
    }

    private formatGroupPrefix(items: ActionItem[], index: number): string {
        const item = items[index];
        const prev = items[index - 1];
        const next = items[index + 1];
        const samePrev = prev?.groupId === item.groupId;
        const sameNext = next?.groupId === item.groupId;
        if (!samePrev && !sameNext) return "── ";
        if (!samePrev) return "┌─ ";
        if (!sameNext) return "└─ ";
        return "│  ";
    }

    private baseGroupId(groupId: string): string {
        return groupId.replace(/:(tools|final)$/, "");
    }

    private isAssistantGroupedEntry(entry: SessionEntry): boolean {
        return (
            entry.type === "message" &&
            (entry.message?.role === "assistant" ||
                entry.message?.role === "toolResult")
        );
    }

    private setCurrent(action: TreebaseAction) {
        const selectedItem = this.visibleItems()[this.selected];
        if (!selectedItem) return;

        if (this.isAssistantGroupedEntry(selectedItem.entry)) {
            this.setAssistantGroupAction(selectedItem, action);
            return;
        }

        this.items = setGroupAction(this.items, selectedItem.groupId, action);
    }

    private setAssistantGroupAction(
        selectedItem: ActionItem,
        action: TreebaseAction,
    ) {
        const base = this.baseGroupId(selectedItem.groupId);
        const assistantItems = this.items.filter(
            (item) =>
                this.baseGroupId(item.groupId) === base &&
                this.isAssistantGroupedEntry(item.entry),
        );
        const visibleAssistantItems = assistantItems.filter(
            (item) => !this.isHiddenToolCallEnvelope(item.entry),
        );

        // If there is no distinct final assistant response visible, keep the
        // original whole-group behavior.
        if (visibleAssistantItems.length < 2) {
            this.items = setGroupAction(this.items, selectedItem.groupId, action);
            return;
        }

        const finalItem = visibleAssistantItems[visibleAssistantItems.length - 1];
        const selectedIsFinal = selectedItem.id === finalItem.id;
        const toolsGroupId = `${base}:tools`;
        const finalGroupId = `${base}:final`;

        const isAlreadySplit = assistantItems.some(
            (item) => item.groupId === toolsGroupId || item.groupId === finalGroupId,
        );
        const finalAction = finalItem.action;

        if (!selectedIsFinal) {
            // User changed a tool result / intermediate assistant row. Split the
            // turn into an intermediate tools group plus the final response. The
            // final response keeps its existing mode. If the requested action
            // matches the final response, rejoin instead.
            if (action === finalAction) {
                this.items = this.items.map((item) => {
                    if (this.baseGroupId(item.groupId) !== base) return item;
                    if (!this.isAssistantGroupedEntry(item.entry)) return item;
                    return { ...item, groupId: base, action };
                });
                return;
            }

            this.items = this.items.map((item) => {
                if (this.baseGroupId(item.groupId) !== base) return item;
                if (!this.isAssistantGroupedEntry(item.entry)) return item;
                if (item.id === finalItem.id) {
                    return { ...item, groupId: finalGroupId };
                }
                return { ...item, groupId: toolsGroupId, action };
            });
            return;
        }

        if (!isAlreadySplit) {
            // User changed the final response while the assistant turn is still
            // unified. update the whole group.
            this.items = setGroupAction(this.items, selectedItem.groupId, action);
            return;
        }

        // User changed the final response in an already split assistant turn.
        // If it now matches the tools/intermediate group, rejoin the turn.
        const toolsAction = this.items.find(
            (item) => item.groupId === toolsGroupId,
        )?.action;

        if (toolsAction && toolsAction === action) {
            this.items = this.items.map((item) => {
                if (this.baseGroupId(item.groupId) !== base) return item;
                if (!this.isAssistantGroupedEntry(item.entry)) return item;
                return { ...item, groupId: base, action };
            });
            return;
        }

        this.items = this.items.map((item) =>
            item.id === finalItem.id
                ? { ...item, groupId: finalGroupId, action }
                : item,
        );
    }

    private jumpGroup(direction: "up" | "down") {
        const visible = this.visibleItems();
        const current = visible[this.selected]?.groupId;
        if (!current) return;

        if (direction === "up") {
            let firstOfCurrent = this.selected;
            while (
                firstOfCurrent > 0 &&
                visible[firstOfCurrent - 1].groupId === current
            ) {
                firstOfCurrent--;
            }
            if (firstOfCurrent === 0) {
                this.selected = 0;
                return;
            }

            // Move to the newest visible entry of the previous group (its last
            // item), not the first/oldest item.
            this.selected = firstOfCurrent - 1;
        } else {
            let lastOfCurrent = this.selected;
            while (
                lastOfCurrent < visible.length - 1 &&
                visible[lastOfCurrent + 1].groupId === current
            ) {
                lastOfCurrent++;
            }
            if (lastOfCurrent >= visible.length - 1) {
                this.selected = visible.length - 1;
                return;
            }

            const nextGroup = visible[lastOfCurrent + 1].groupId;
            let lastOfNext = lastOfCurrent + 1;
            while (
                lastOfNext < visible.length - 1 &&
                visible[lastOfNext + 1].groupId === nextGroup
            ) {
                lastOfNext++;
            }
            this.selected = lastOfNext;
        }
    }

    handleInput(data: string) {
        const kb = getKeybindings();
        const visibleLength = this.visibleItems().length;
        if (kb.matches(data, "tui.select.up") || matchesKey(data, Key.up)) {
            this.selected =
                this.selected === 0 ? visibleLength - 1 : this.selected - 1;
        } else if (
            kb.matches(data, "tui.select.down") ||
            matchesKey(data, Key.down)
        ) {
            this.selected =
                this.selected === visibleLength - 1 ? 0 : this.selected + 1;
        } else if (
            kb.matches(data, "app.tree.foldOrUp") ||
            kb.matches(data, "tui.editor.cursorLeft") ||
            matchesKey(data, Key.left)
        ) {
            this.jumpGroup("up");
        } else if (
            kb.matches(data, "app.tree.unfoldOrDown") ||
            kb.matches(data, "tui.editor.cursorRight") ||
            matchesKey(data, Key.right)
        ) {
            this.jumpGroup("down");
        } else if (
            matchesKey(data, Key.shift("enter")) ||
            kb.matches(data, "tui.input.newLine")
        ) {
            this.writeSummarizerMessageAndCancel();
        } else if (
            kb.matches(data, "tui.select.confirm") ||
            matchesKey(data, Key.enter)
        ) {
            this.done(this.items);
        } else if (
            kb.matches(data, "tui.select.cancel") ||
            matchesKey(data, Key.escape)
        ) {
            this.done(null);
        } else if (data.toLowerCase() === "p") this.setCurrent("pick");
        else if (data.toLowerCase() === "h") this.setCurrent("summarize-high");
        else if (data.toLowerCase() === "l") this.setCurrent("summarize-low");
        else if (data.toLowerCase() === "d") this.setCurrent("drop");
    }

    private writeSummarizerMessageAndCancel(): void {
        const message = buildSummarizerUserMessage(this.items);
        const tmpFile = path.join(
            os.tmpdir(),
            `pi-treebase-summarizer-message-${Date.now()}.xml`,
        );
        fs.writeFileSync(
            tmpFile,
            message ||
                "<!-- No summarize-high/summarize-low groups selected. -->\n",
            "utf-8",
        );
        this.ctx.ui.notify(
            `Treebase summarizer message written to: ${tmpFile}`,
            "info",
        );
        this.done(null);
    }

    private getEntryDisplayText(
        entry: SessionEntry,
        isSelected: boolean,
    ): string {
        const normalize = (s: string) => s.replace(/[\n\t]/g, " ").trim();
        let result = "";
        switch (entry.type) {
            case "message": {
                const msg = entry.message;
                const role = msg.role;
                if (role === "user") {
                    result =
                        this.theme.fg("accent", "user: ") +
                        normalize(this.extractContent(msg.content));
                } else if (role === "assistant") {
                    const textContent = normalize(
                        this.extractContent(msg.content),
                    );
                    if (textContent)
                        result =
                            this.theme.fg("success", "assistant: ") +
                            textContent;
                    else if (msg.stopReason === "aborted")
                        result =
                            this.theme.fg("success", "assistant: ") +
                            this.theme.fg("muted", "(aborted)");
                    else if (msg.errorMessage)
                        result =
                            this.theme.fg("success", "assistant: ") +
                            this.theme.fg(
                                "error",
                                normalize(msg.errorMessage).slice(0, 80),
                            );
                    else
                        result =
                            this.theme.fg("success", "assistant: ") +
                            this.theme.fg("muted", "(no content)");
                } else if (role === "toolResult") {
                    const toolCall = msg.toolCallId
                        ? this.toolCallMap.get(msg.toolCallId)
                        : undefined;
                    result = this.theme.fg(
                        "muted",
                        toolCall
                            ? this.formatToolCall(
                                  toolCall.name,
                                  toolCall.arguments,
                              )
                            : `[${msg.toolName ?? "tool"}]`,
                    );
                } else if (role === "bashExecution") {
                    result = this.theme.fg(
                        "dim",
                        `[bash]: ${normalize(msg.command ?? "")}`,
                    );
                } else {
                    result = this.theme.fg("dim", `[${role}]`);
                }
                break;
            }
            case "custom_message": {
                const content =
                    typeof entry.content === "string"
                        ? entry.content
                        : (entry.content ?? [])
                              .filter((c: any) => c.type === "text")
                              .map((c: any) => c.text)
                              .join("");
                result =
                    this.theme.fg(
                        "customMessageLabel",
                        `[${entry.customType}]: `,
                    ) + normalize(content);
                break;
            }
            case "compaction": {
                const tokens = Math.round((entry.tokensBefore ?? 0) / 1000);
                result = this.theme.fg(
                    "borderAccent",
                    `[compaction: ${tokens}k tokens]`,
                );
                break;
            }
            case "branch_summary":
                result =
                    this.theme.fg("warning", "[branch summary]: ") +
                    normalize(entry.summary ?? "");
                break;
            case "model_change":
                result = this.theme.fg("dim", `[model: ${entry.modelId}]`);
                break;
            case "thinking_level_change":
                result = this.theme.fg(
                    "dim",
                    `[thinking: ${entry.thinkingLevel}]`,
                );
                break;
            case "custom":
                result = this.theme.fg("dim", `[custom: ${entry.customType}]`);
                break;
            case "label":
                result = this.theme.fg(
                    "dim",
                    `[label: ${entry.label ?? "(cleared)"}]`,
                );
                break;
            case "session_info":
                result = entry.name
                    ? this.theme.fg("dim", `[title: ${entry.name}]`)
                    : this.theme.fg("dim", "[title: empty]");
                break;
            default:
                result = this.theme.fg("dim", `[unknown]`);
        }
        return isSelected ? this.theme.bold(result) : result;
    }

    private extractContent(content: any): string {
        const maxLen = 200;
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

    private formatToolCall(name: string, args: Record<string, any>): string {
        const shortenPath = (p: string) => {
            const home = process.env.HOME || process.env.USERPROFILE || "";
            return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
        };
        switch (name) {
            case "read": {
                const path = shortenPath(
                    String(args.path || args.file_path || ""),
                );
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
            case "write":
                return `[write: ${shortenPath(String(args.path || args.file_path || ""))}]`;
            case "edit":
                return `[edit: ${shortenPath(String(args.path || args.file_path || ""))}]`;
            case "bash": {
                const rawCmd = String(args.command || "");
                const cmd = rawCmd
                    .replace(/[\n\t]/g, " ")
                    .trim()
                    .slice(0, 50);
                return `[bash: ${cmd}${rawCmd.length > 50 ? "..." : ""}]`;
            }
            case "grep":
                return `[grep: /${String(args.pattern || "")}/ in ${shortenPath(String(args.path || "."))}]`;
            case "find":
                return `[find: ${String(args.pattern || "")} in ${shortenPath(String(args.path || "."))}]`;
            case "ls":
                return `[ls: ${shortenPath(String(args.path || "."))}]`;
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
        const list = new ActionList(
            initialItems,
            done,
            theme,
            terminalHeight,
            ctx,
        );
        container.addChild(
            new DynamicBorder((s: string) => theme.fg("accent", s)),
        );
        container.addChild(
            new Text(theme.fg("accent", theme.bold("Treebase Actions")), 1, 0),
        );
        container.addChild(
            new Text(
                theme.fg(
                    "muted",
                    "Choose what should happen to each group. P - pick, H / L - summarize with high or importance, D - drop",
                ),
                1,
                0,
            ),
        );
        container.addChild(
            new DynamicBorder((s: string) => theme.fg("accent", s)),
        );
        container.addChild(list);
        container.addChild(
            new DynamicBorder((s: string) => theme.fg("accent", s)),
        );
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
