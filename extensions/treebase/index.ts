import type {
    ExtensionAPI,
    ExtensionCommandContext,
    SessionEntry,
    SessionManager,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { showActionList } from "./action-list.js";
import { buildRewrite } from "./summarize.js";
import { showTreeSelector } from "./tree-selector.js";
import {
    entriesBetweenAncestorAndLeaf,
    isAncestor,
    makeActionItems,
    parentOf,
} from "./tree-utils.js";

function freshId(sm: SessionManager): string {
    for (let i = 0; i < 100; i++) {
        const id = randomUUID().slice(0, 8);
        if (!sm.getEntry(id)) return id;
    }
    return randomUUID();
}

function appendClonedEntry(
    sm: SessionManager,
    original: SessionEntry,
): string | null {
    switch (original.type) {
        case "message":
            return sm.appendMessage(
                structuredClone(original.message) as Parameters<
                    SessionManager["appendMessage"]
                >[0],
            );
        case "custom_message":
            return sm.appendCustomMessageEntry(
                original.customType,
                structuredClone(original.content),
                original.display,
                structuredClone(original.details),
            );
        case "model_change":
            return sm.appendModelChange(original.provider, original.modelId);
        case "thinking_level_change":
            return sm.appendThinkingLevelChange(original.thinkingLevel);
        case "branch_summary": {
            // No public appendBranchSummary API exists. Hack through the private
            // SessionManager method so picked branch summaries remain in context.
            // Keep original fromId as provenance metadata even though it may point
            // at the pre-treebase history.
            const entry = {
                type: "branch_summary",
                id: freshId(sm),
                parentId: sm.getLeafId(),
                timestamp: new Date().toISOString(),
                fromId: original.fromId,
                summary: original.summary,
                details: structuredClone(original.details),
                fromHook: original.fromHook,
            };
            (sm as unknown as { _appendEntry(entry: unknown): void })._appendEntry(entry);
            return entry.id;
        }
        default:
            return null;
    }
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
    const sections: string[] = [];
    if (readFiles.length > 0) {
        sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
    }
    if (modifiedFiles.length > 0) {
        sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
    }
    return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}

function appendSummary(
    sm: SessionManager,
    summary: string,
    sourceIds: string[],
    readFiles: string[],
    modifiedFiles: string[],
): string {
    const summaryWithFileOps = summary + formatFileOperations(readFiles, modifiedFiles);
    const entry = {
        type: "branch_summary",
        id: freshId(sm),
        parentId: sm.getLeafId(),
        timestamp: new Date().toISOString(),
        fromId: sourceIds.at(-1) ?? sm.getLeafId() ?? "treebase",
        summary: summaryWithFileOps,
        details: { sourceIds, readFiles, modifiedFiles, generatedBy: "treebase" },
        // Mark as not extension-generated so native branch summarization's
        // prepareBranchEntries() aggregates details.readFiles/modifiedFiles.
        fromHook: false,
    };
    // No public appendBranchSummary API exists. Hack through the private
    // SessionManager method. This is better than a custom message for now, maybe there should
    // be a customSummary type or something.
    (sm as unknown as { _appendEntry(entry: unknown): void })._appendEntry(entry);
    return entry.id;
}

async function applyRewrite(
    ctx: ExtensionCommandContext,
    targetId: string,
    parts: Awaited<ReturnType<typeof buildRewrite>>,
): Promise<string | null> {
    if (!parts) return null;
    // const-cast :flushed: is this bad?
    const sm = ctx.sessionManager as SessionManager;

    const parentId = parentOf(sm, targetId);
    if (parentId) sm.branch(parentId);
    else sm.resetLeaf();

    let appended = 0;
    for (const part of parts) {
        if (part.kind === "pick") {
            if (appendClonedEntry(sm, part.item.entry)) appended++;
        } else if (part.text.trim()) {
            appendSummary(
                sm,
                part.text.trim(),
                part.sourceIds,
                part.readFiles,
                part.modifiedFiles,
            );
            appended++;
        }
    }
    if (appended === 0) {
        ctx.ui.notify(
            "Treebase produced no entries; moved to target parent.",
            "warning",
        );
    }

    return sm.getLeafId();
}

function isEditableNavigationTarget(entry: SessionEntry | undefined): boolean {
    if (!entry) return false;
    if (entry.type === "custom_message") return true;
    return entry.type === "message" && entry.message.role === "user";
}

async function navigateToRewrittenLeaf(
    sm: SessionManager,
    ctx: ExtensionCommandContext,
    rewrittenLeafId: string,
) {
    const rewrittenLeaf = sm.getEntry(rewrittenLeafId);

    if (isEditableNavigationTarget(rewrittenLeaf)) {
        const draftParentId = sm.getLeafId();
        if (!draftParentId) throw new Error("failed to get leaf id");
        const draftId = sm.appendMessage({
            role: "user",
            content: "",
            timestamp: Date.now(),
        });
        // Selecting a user message in native /tree restores that message into
        // the editor and leaves the session leaf at its parent. Since
        // appendMessage advances the leaf to the draft, rewind before calling
        // ctx.navigateTree so the target is not a no-op.
        sm.branch(draftParentId);
        const result = await ctx.navigateTree(draftId, { summarize: false });
        if (result.cancelled) throw new Error("navigateTree cancelled unexpectedly");
        return;
    }

    const parentId = rewrittenLeaf?.parentId ?? null;
    if (parentId) sm.branch(parentId);
    else sm.resetLeaf();

    const result = await ctx.navigateTree(rewrittenLeafId, { summarize: false });
    if (result.cancelled) throw new Error("navigateTree cancelled unexpectedly");
}

export default function (pi: ExtensionAPI) {
    pi.registerCommand("treebase", {
        description:
            "Interactively rewrite the path back to an earlier tree node",
        handler: async (_args, ctx) => {
            if (!ctx.hasUI) {
                ctx.ui.notify("/treebase requires interactive mode", "error");
                return;
            }
            await ctx.waitForIdle();

            const sm = ctx.sessionManager as SessionManager;
            const currentLeafId = sm.getLeafId();
            if (!currentLeafId) {
                ctx.ui.notify("No current session leaf", "error");
                return;
            }

            const targetId = await showTreeSelector(ctx, pi);
            if (!targetId || targetId === currentLeafId) return;

            if (!isAncestor(sm, targetId, currentLeafId)) {
                await ctx.navigateTree(targetId, {
                    summarize: false,
                });
                ctx.ui.notify(
                    "Selected node is not chronologically behind the current leaf; teleported without rewriting.",
                    "info",
                );
                return;
            }

            const segment = entriesBetweenAncestorAndLeaf(
                sm,
                targetId,
                currentLeafId,
            );
            const actionItems = makeActionItems(segment);
            if (segment.length === 0 || actionItems.length === 0) {
                ctx.ui.notify("Could not compute treebase path with context-bearing entries", "error");
                return;
            }

            const edited = await showActionList(ctx, actionItems);
            if (!edited) return;

            try {
                const rewrite = await buildRewrite(ctx, edited);
                if (!rewrite) {
                    ctx.ui.notify("Treebase cancelled", "info");
                    return;
                }
                const rewrittenLeafId = await applyRewrite(ctx, targetId, rewrite);
                if (!rewrittenLeafId) return;

                await navigateToRewrittenLeaf(sm, ctx, rewrittenLeafId);
                ctx.ui.notify("Treebase branch created", "info");
            } catch (err: unknown) {
                ctx.ui.notify(
                    `Treebase failed: ${err instanceof Error ? err.message : String(err)}`,
                    "error",
                );
            }
        },
    });
}
