import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    setTreeSelectorTheme,
    TreeSelectorComponent,
} from "./tree-selector-vendored-copy.js";

export async function showTreeSelector(
    ctx: any,
    pi?: ExtensionAPI,
): Promise<string | null> {
    const tree = ctx.sessionManager.getTree();
    const currentLeafId = ctx.sessionManager.getLeafId();
    if (!tree || tree.length === 0) return null;

    return ctx.ui.custom((tui: any, theme: any, _kb: any, done: any) => {
        setTreeSelectorTheme(theme);
        const rows = tui?.terminal?.rows ?? process.stdout.rows ?? 40;
        const selector = new TreeSelectorComponent(
            tree,
            currentLeafId,
            rows,
            (entryId: string) => done(entryId),
            () => done(null),
            (entryId: string, label?: string) => {
                pi?.setLabel(entryId, label);
            },
            undefined,
            undefined,
        );
        return {
            render: (width: number) => selector.render(width),
            invalidate: () => {
                setTreeSelectorTheme(theme);
                selector.invalidate();
            },
            handleInput: (data: string) => {
                selector.handleInput(data);
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
