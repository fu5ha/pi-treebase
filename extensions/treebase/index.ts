import {
    type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext,
    type SessionEntry, SessionManager,
} from "@earendil-works/pi-coding-agent";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { showActionList } from "./action-list.ts";
import { showTreeSelector } from "./tree-selector.ts";
import { entriesBetweenAncestorAndLeaf, isAncestor, makeActionItems } from "./tree-utils.ts";
import { BranchWriter, writableManager } from "./session-writer.ts";
import { prepareWorkspace, loadWorkspace, validateWorkspace, type RewriteWorkspace } from "./rewrite-workspace.ts";

const STATE = "treebase.operation";
type Operation = {
    operationId: string;
    sessionId: string;
    originalLeaf: string;
    workingAnchor: string;
    directory: string;
    manifestHash: string;
    status: "editing" | "ready" | "failed" | "cancelled" | "committed";
    repairs: number;
    diagnostic?: string;
    finalLeaf?: string | null;
};

function operation(ctx: ExtensionContext): Operation | undefined {
    for (const entry of ctx.sessionManager.getBranch().slice().reverse()) {
        if (entry.type === "custom" && entry.customType === STATE) {
            const op = entry.data as Operation;
            // A user can revisit the abandoned working branch after activation.
            // A session-wide commit receipt prevents applying that operation twice.
            const committed = ctx.sessionManager.getEntries().find((candidate) =>
                candidate.type === "custom" && candidate.customType === STATE &&
                (candidate.data as Operation)?.operationId === op.operationId &&
                (candidate.data as Operation)?.status === "committed");
            return committed?.type === "custom" ? committed.data as Operation : op;
        }
    }
}

function assertWorking(ctx: ExtensionContext, op: Operation) {
    if (ctx.sessionManager.getSessionId() !== op.sessionId ||
        !isAncestor(ctx.sessionManager, op.workingAnchor, ctx.sessionManager.getLeafId())) {
        throw new Error("Stale treebase operation: return to its working branch in the original session");
    }
}

async function workspace(op: Operation) {
    return loadWorkspace(op.directory, op.manifestHash);
}

async function completion(work: RewriteWorkspace) {
    try {
        const signal = JSON.parse(await readFile(join(work.directory, "ready.json"), "utf8"));
        return signal.operationId === work.manifest.operationId;
    } catch { return false; }
}

function appendRange(sm: SessionManager, parent: string | null, entries: SessionEntry[]) {
    if (parent) sm.branch(parent);
    else sm.resetLeaf();
    const writer = new BranchWriter(sm);
    for (const entry of entries) writer.append(entry);
    return sm.getLeafId();
}

/** Navigation must run only in an idle command, never a lifecycle handler. */
async function activate(ctx: ExtensionCommandContext, leaf: string | null, rollback: string | null) {
    const sm = writableManager(ctx);
    if (leaf) sm.branch(leaf);
    else sm.resetLeaf();
    const anchor = sm.appendCustomEntry("treebase.activation", { leafId: leaf });
    if (rollback) sm.branch(rollback);
    else sm.resetLeaf();
    try {
        const result = await ctx.navigateTree(anchor, { summarize: false });
        if (result.cancelled) throw new Error("Treebase activation cancelled");
    } catch (error) {
        if (rollback) sm.branch(rollback);
        else sm.resetLeaf();
        throw error;
    }
}

export default function (pi: ExtensionAPI) {
    // Notification-only settlement cannot durably append a receipt. After a
    // reload, require a fresh editing run rather than guessing that a persisted
    // actionable-boundary readiness record had actually reached settlement.
    const settled = new Set<string>();
    pi.on("before_agent_start", (_event, ctx) => {
        const op = operation(ctx);
        if (op?.status === "ready") {
            settled.delete(op.operationId);
            pi.appendEntry(STATE, { ...op, status: "failed",
                diagnostic: "Another agent run started after readiness; use /pi-treebase resume before applying" });
        }
    });
    // Settlement is deliberately notification-only. Readiness is persisted at
    // the actionable boundary, and an idle command revalidates before applying.
    pi.on("agent_before_settle", async (event, ctx) => {
        const op = operation(ctx);
        if (!op || !["editing", "ready"].includes(op.status)) return;
        try {
            assertWorking(ctx, op);
            if (event.outcome !== "completed" || ctx.signal?.aborted) {
                return { entries: [{ type: "custom", customType: STATE,
                    data: { ...op, status: "failed", diagnostic: `Editing run ${event.outcome}; use /pi-treebase resume or cancel` } }] };
            }
            const work = await workspace(op);
            if (!(await completion(work))) return;
            const validated = await validateWorkspace(writableManager(ctx), work, ctx.model?.contextWindow);
            if (ctx.signal?.aborted) throw new Error("Editing interrupted during validation; resume before applying");
            return { entries: [{ type: "custom", customType: STATE,
                data: { ...op, status: "ready", diagnostic: `Estimated effective context: ${validated.estimatedTokens} tokens` } }] };
        } catch (error) {
            const diagnostic = error instanceof Error ? error.message : String(error);
            const repairs = op.repairs + 1;
            const repair = repairs <= 2 && !ctx.signal?.aborted;
            // At most two automatic continuations; never navigate from here.
            return {
                entries: [
                    { type: "custom", customType: STATE, data: { ...op, repairs,
                        status: repair ? "editing" : "failed", diagnostic } },
                    ...(repair ? [{ type: "custom_message" as const,
                        customType: "treebase.repair", display: true,
                        content: `Treebase validation failed: ${diagnostic}\nRepair ${join(op.directory, "context.jsonl")} using instructions.md. Write ready.json again when finished. Do not run /pi-treebase apply yourself.` }] : []),
                ],
                continue: repair,
            };
        }
    });
    pi.on("agent_settled", (_event, ctx) => {
        const op = operation(ctx);
        if (op?.status === "ready") {
            settled.add(op.operationId);
            ctx.ui.notify(`Treebase ready. Run /pi-treebase apply.\n${op.diagnostic}`, "info");
        }
        else if (op?.status === "failed") ctx.ui.notify(`Treebase paused: ${op.diagnostic}\nArtifacts: ${op.directory}`, "error");
        else if (op?.status === "editing") ctx.ui.notify("Treebase not completed. Use /pi-treebase resume or cancel.", "info");
    });

    const handler = async (args: string, ctx: ExtensionCommandContext) => {
        if (ctx.mode !== "tui") {
            ctx.ui.notify("/pi-treebase requires TUI mode", "error");
            return;
        }
        await ctx.waitForIdle();
        const sm = writableManager(ctx);
        try {
            const subcommand = args.trim();
            const op = operation(ctx);
            if (subcommand) {
                if (!["apply", "resume", "cancel"].includes(subcommand)) throw new Error("Use /pi-treebase [apply|resume|cancel]");
                if (!op || ["committed", "cancelled"].includes(op.status)) throw new Error("No active treebase operation on this branch");
                assertWorking(ctx, op);
                if (subcommand === "cancel") {
                    sm.appendCustomEntry(STATE, { ...op, status: "cancelled" });
                    await activate(ctx, op.originalLeaf, sm.getLeafId());
                    ctx.ui.notify(`Treebase cancelled; artifacts retained at ${op.directory}`, "info");
                    return;
                }
                const work = await workspace(op);
                if (subcommand === "resume") {
                    settled.delete(op.operationId);
                    await unlink(join(work.directory, "ready.json")).catch(() => {});
                    sm.appendCustomEntry(STATE, { ...op, status: "editing", repairs: 0 });
                    pi.sendUserMessage(`Continue the treebase operation ${op.operationId}. Inspect ${work.instructionsPath} and repair/edit ${work.contextPath}. ${op.diagnostic ?? ""}`);
                    return;
                }
                if (op.status !== "ready") throw new Error("Editing has not completed successfully. Use /pi-treebase resume");
                if (!settled.has(op.operationId)) throw new Error("Settlement is not confirmed in this runtime (possibly reloaded). Use /pi-treebase resume");
                const validated = await validateWorkspace(sm, work, ctx.model?.contextWindow);
                assertWorking(ctx, op);
                const rollback = sm.getLeafId();
                // Complete detached reconstruction before mutating any live leaf.
                const header = sm.getHeader();
                const preview = SessionManager.inMemory(sm.getCwd(), undefined,
                    [...(header ? [structuredClone(header)] : []), ...structuredClone(sm.getEntries())]);
                appendRange(preview, work.manifest.selectedParent, validated.entries);
                try {
                    const leaf = appendRange(sm, work.manifest.selectedParent, validated.entries);
                    const receipt = sm.appendCustomEntry("treebase.provenance", {
                        operationId: op.operationId, originalLeaf: op.originalLeaf,
                        directory: op.directory, manifestHash: op.manifestHash, finalLeaf: leaf,
                    });
                    await activate(ctx, receipt, rollback);
                    sm.appendCustomEntry(STATE, { ...op, status: "committed", finalLeaf: leaf });
                    ctx.ui.notify(`Treebase branch created (~${validated.estimatedTokens} context tokens).\nArtifacts: ${op.directory}`, "info");
                } catch (error) {
                    if (rollback) sm.branch(rollback);
                    else sm.resetLeaf();
                    throw error;
                }
                return;
            }
            if (op && ["editing", "ready", "failed"].includes(op.status)) throw new Error("An operation is already active. Use /pi-treebase apply, resume, or cancel");
            const originalLeaf = sm.getLeafId();
            if (!originalLeaf) throw new Error("No current session leaf");
            const target = await showTreeSelector(ctx, pi);
            if (!target) return;
            if (!isAncestor(sm, target, originalLeaf)) throw new Error("Choose an earlier entry in the current branch; unrelated destinations cannot be rewritten");
            const items = makeActionItems(entriesBetweenAncestorAndLeaf(sm, target, originalLeaf), sm.buildSessionProjection());
            const edited = await showActionList(ctx, items);
            if (!edited) return;
            const work = await prepareWorkspace(sm, edited);
            // Snapshot is complete before the first working-branch record.
            const workingAnchor = sm.appendCustomEntry("treebase.working", { operationId: work.manifest.operationId });
            const state: Operation = {
                operationId: work.manifest.operationId, sessionId: sm.getSessionId(),
                originalLeaf, workingAnchor, directory: work.directory,
                manifestHash: work.manifestHash, status: "editing", repairs: 0,
            };
            const stateId = sm.appendCustomEntry(STATE, state);
            await activate(ctx, stateId, originalLeaf);
            pi.sendUserMessage(`Perform controlled context editing for treebase operation ${state.operationId} using your current context and normal tools.
Read ${work.instructionsPath}, ${work.choicesPath}, and the schemas in ${work.directory}.
Edit ${work.contextPath}, not the live session. Original snapshot: ${work.originalPath}.
Inspect programmatically, batch precise edits, preserve retained facts concisely, and never reintroduce X material.
When finished, write ${join(work.directory, "ready.json")} containing {"operationId":"${state.operationId}"} and end your turn.
Do not invoke /pi-treebase apply: the user will activate the validated result from an idle command.`);
            ctx.ui.notify(`Treebase editing on a temporary branch.\nArtifacts: ${work.directory}`, "info");
        } catch (error) {
            ctx.ui.notify(`Treebase failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
    };
    for (const name of ["pi-treebase", "treebase"]) pi.registerCommand(name, {
        description: "Edit ancestor context with P/M/X (apply, resume, cancel)", handler,
    });
}
