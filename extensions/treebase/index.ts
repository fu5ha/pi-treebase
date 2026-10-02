import {
    SessionManager,
    type ExtensionAPI,
    type ExtensionCommandContext,
    type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { showActionList } from "./action-list.js";
import { buildRewrite, type RewritePart, type BuildRewriteResult } from "./summarize.js";
import { showTreeSelector } from "./tree-selector.js";
import { entriesBetweenAncestorAndLeaf, isAncestor, makeActionItems, parentOf } from "./tree-utils.js";
import { BranchWriter, writableManager } from "./session-writer.js";

function retainedToolUse(part: Extract<RewritePart, { kind: "retained-tool-use" }>): SessionEntry[] {
    const callEntry = structuredClone(part.toolCallItem.entry);
    const resultEntry = structuredClone(part.toolResultItem.entry);
    if (callEntry.type !== "message" || callEntry.message.role !== "assistant" ||
        resultEntry.type !== "message" || resultEntry.message.role !== "toolResult") {
        throw new Error("Invalid retained tool-use pair");
    }
    const block = callEntry.message.content.find(
        (block) => block.type === "toolCall" && block.id === part.toolCallId,
    );
    if (!block || block.type !== "toolCall") throw new Error("Retained tool call not found");
    // Keep provider item-id suffix and opaque namespace/signature metadata.
    const suffix = part.toolCallId.includes("|") ? part.toolCallId.slice(part.toolCallId.indexOf("|")) : "";
    const id = `call_${randomUUID()}${suffix}`;
    callEntry.message.content = [{ ...block, id }];
    resultEntry.message.toolCallId = id;
    return [callEntry, resultEntry];
}

function writeParts(sm: SessionManager, targetId: string, rewrite: BuildRewriteResult): string | null {
    const parentId = parentOf(sm, targetId);
    if (parentId) sm.branch(parentId);
    else sm.resetLeaf();
    const writer = new BranchWriter(sm);
    const retainedPairs = new Map<string, SessionEntry[]>();
    for (const part of rewrite.parts) {
        if (part.kind === "pick") writer.append(part.item.entry);
        else if (part.kind === "retained-tool-use") {
            let pair = retainedPairs.get(part.toolCallId);
            if (!pair) {
                pair = retainedToolUse(part);
                retainedPairs.set(part.toolCallId, pair);
            }
            writer.append(pair[part.position === "call" ? 0 : 1]);
        } else if (part.text.trim()) {
            const fileOps = [
                part.readFiles.length ? `<read-files>\n${part.readFiles.join("\n")}\n</read-files>` : "",
                part.modifiedFiles.length ? `<modified-files>\n${part.modifiedFiles.join("\n")}\n</modified-files>` : "",
            ].filter(Boolean).join("\n\n");
            sm.branchWithSummary(sm.getLeafId(), part.text.trim() + (fileOps ? `\n\n${fileOps}` : ""), {
                sourceIds: part.sourceIds,
                readFiles: part.readFiles,
                modifiedFiles: part.modifiedFiles,
                generatedBy: "treebase",
            }, true);
        }
    }
    if (rewrite.usage && rewrite.usageProvider && rewrite.usageModel) {
        sm.appendUsage("treebase_summary", rewrite.usageProvider, rewrite.usageModel, rewrite.usage);
    }
    return sm.getLeafId();
}

async function applyRewrite(ctx: ExtensionCommandContext, targetId: string, rewrite: BuildRewriteResult) {
    const sm = writableManager(ctx);
    const originalLeaf = sm.getLeafId();
    // Exercise every public copy operation on a detached manager before changing
    // the live leaf. This catches unsupported roles, references and checkpoints.
    const header = sm.getHeader();
    const preview = SessionManager.inMemory(sm.getCwd(), undefined,
        [...(header ? [structuredClone(header)] : []), ...structuredClone(sm.getEntries())]);
    writeParts(preview, targetId, rewrite);
    try {
        const leaf = writeParts(sm, targetId, rewrite);
        // Native tree navigation refreshes finalized context and tool state.
        // User/custom targets otherwise restore a draft at their parent. A
        // state-only anchor activates any leaf, including null, without drafts.
        const anchor = sm.appendCustomEntry("treebase.activation", { leafId: leaf });
        if (originalLeaf) sm.branch(originalLeaf);
        else sm.resetLeaf();
        const result = await ctx.navigateTree(anchor, { summarize: false });
        if (result.cancelled) throw new Error("Treebase activation cancelled");
    } catch (error) {
        if (originalLeaf) sm.branch(originalLeaf);
        else sm.resetLeaf();
        throw error;
    }
}

export default function (pi: ExtensionAPI) {
    pi.registerCommand("treebase", {
        description: "Interactively rewrite the path back to an earlier tree node",
        handler: async (_args, ctx) => {
            if (ctx.mode !== "tui") {
                ctx.ui.notify("/treebase requires TUI mode", "error");
                return;
            }
            await ctx.waitForIdle();
            const sm = writableManager(ctx);
            const currentLeafId = sm.getLeafId();
            if (!currentLeafId) {
                ctx.ui.notify("No current session leaf", "error");
                return;
            }
            const targetId = await showTreeSelector(ctx, pi);
            if (!targetId || targetId === currentLeafId) return;
            if (!isAncestor(sm, targetId, currentLeafId)) {
                await ctx.navigateTree(targetId, { summarize: false });
                ctx.ui.notify("Selected node is not an ancestor; navigated without rewriting.", "info");
                return;
            }
            const segment = entriesBetweenAncestorAndLeaf(sm, targetId, currentLeafId);
            const items = makeActionItems(segment, sm.buildSessionProjection());
            if (!items.length) {
                ctx.ui.notify("Could not compute treebase path", "error");
                return;
            }
            const edited = await showActionList(ctx, items);
            if (!edited) return;
            try {
                const rewrite = await buildRewrite(ctx, edited);
                if (!rewrite) {
                    ctx.ui.notify("Treebase cancelled", "info");
                    return;
                }
                await applyRewrite(ctx, targetId, rewrite);
                const paths = [
                    rewrite.debugFiles.summarizerMessagePath,
                    rewrite.debugFiles.summarizerResponsePath,
                ].filter(Boolean);
                ctx.ui.notify(`Treebase branch created${paths.length ? `\n${paths.join("\n")}` : ""}`, "info");
            } catch (error) {
                ctx.ui.notify(`Treebase failed: ${error instanceof Error ? error.message : String(error)}`, "error");
            }
        },
    });
}
