import {
    TreeSelectorComponent,
    type ExtensionAPI,
    type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, setKeybindings, truncateToWidth } from "@earendil-works/pi-tui";

export async function showTreeSelector(
    ctx: ExtensionCommandContext,
    pi?: ExtensionAPI,
): Promise<string | null> {
    if (ctx.mode !== "tui") {
        ctx.ui.notify("/treebase requires terminal UI mode", "error");
        return null;
    }
    const tree = ctx.sessionManager.getTree();
    const currentLeafId = ctx.sessionManager.getLeafId();
    if (!tree || tree.length === 0) return null;

    return ctx.ui.custom<string | null>((tui, _theme, keybindings, done) => {
        // The native selector uses pi's active theme and TUI keybindings internally.
        // Scope the injected manager to synchronous component operations rather than
        // leaving a different global manager installed after this screen closes.
        function withBindings<T>(operation: () => T): T {
            const previous = getKeybindings();
            setKeybindings(keybindings);
            try {
                return operation();
            } finally {
                setKeybindings(previous);
            }
        }
        const selector = withBindings(() => new TreeSelectorComponent(
            tree,
            currentLeafId,
            tui.terminal.rows,
            (entryId: string) => done(entryId),
            () => done(null),
            (entryId: string, label?: string) => {
                pi?.setLabel(entryId, label);
            },
            undefined,
            undefined,
        ));
        return {
            // Native label input reserves two columns; guard pathological widths.
            render: (width: number) => withBindings(() =>
                selector.render(Math.max(3, width)).map(line => truncateToWidth(line, width)),
            ),
            invalidate: () => selector.invalidate(),
            handleInput: (data: string) => {
                withBindings(() => selector.handleInput(data));
                tui.requestRender();
            },
            get focused() {
                return selector.focused;
            },
            set focused(value: boolean) {
                selector.focused = value;
            },
        };
    });
}
