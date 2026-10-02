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
            // Session-wide terminal receipts prevent duplicate or cancelled reuse.
            const terminal = ctx.sessionManager.getEntries().find((candidate) =>
                candidate.type === "custom" && candidate.customType === STATE &&
                (candidate.data as Operation)?.operationId === op.operationId &&
                ["committed", "cancelled"].includes((candidate.data as Operation)?.status));
            return terminal?.type === "custom" ? terminal.data as Operation : op;
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

/** Navigation runs outside lifecycle dispatch, using an idle command context. */
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
    const commandContexts = new Map<string, ExtensionCommandContext>();
    const pending = new Set<ReturnType<typeof setTimeout>>();
    const clearRuntime = () => {
        for (const timer of pending) clearTimeout(timer);
        pending.clear();
        commandContexts.clear();
        settled.clear();
    };
    pi.on("session_start", clearRuntime);
    pi.on("session_shutdown", clearRuntime);

    const apply = async (ctx: ExtensionCommandContext, operationId: string) => {
        await ctx.waitForIdle();
        const op = operation(ctx);
        if (!op || op.operationId !== operationId || op.status !== "ready" ||
            !settled.has(operationId) || commandContexts.get(operationId) !== ctx) return;
        assertWorking(ctx, op);
        const sm = writableManager(ctx);
        const rollback = sm.getLeafId();
        const work = await workspace(op);
        const validated = await validateWorkspace(sm, work, ctx.model?.contextWindow);
        // Validation yields to the runtime. Never replace a branch if the user
        // navigated, started another run, cancelled, or reloaded meanwhile.
        assertWorking(ctx, op);
        if (!ctx.isIdle() || ctx.hasPendingMessages() || sm.getLeafId() !== rollback ||
            !settled.has(operationId) || commandContexts.get(operationId) !== ctx ||
            operation(ctx)?.status !== "ready") {
            throw new Error("Session changed before activation; use /treebase resume");
        }
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
            settled.delete(operationId);
            commandContexts.delete(operationId);
            ctx.ui.notify(`Treebase branch created (~${validated.estimatedTokens} context tokens).\nArtifacts: ${op.directory}`, "info");
        } catch (error) {
            if (rollback) sm.branch(rollback);
            else sm.resetLeaf();
            throw error;
        }
    };
    pi.on("before_agent_start", (_event, ctx) => {
        const op = operation(ctx);
        if (op?.status === "ready") {
            settled.delete(op.operationId);
            pi.appendEntry(STATE, { ...op, status: "failed",
                diagnostic: "Another agent run started after readiness; use /treebase resume" });
        }
    });
    // Settlement is deliberately notification-only. Readiness is persisted at
    // the actionable boundary, and deferred idle work revalidates before applying.
    pi.on("agent_before_settle", async (event, ctx) => {
        const op = operation(ctx);
        if (!op || !["editing", "ready"].includes(op.status)) return;
        try {
            assertWorking(ctx, op);
            if (event.outcome !== "completed" || ctx.signal?.aborted) {
                return { entries: [{ type: "custom", customType: STATE,
                    data: { ...op, status: "failed", diagnostic: `Editing run ${event.outcome}; use /treebase resume or cancel` } }] };
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
                        content: `Treebase validation failed: ${diagnostic}\nRepair ${join(op.directory, "context.jsonl")} using instructions.md. Write ready.json again when finished. Activation is automatic; do not invoke /treebase yourself.` }] : []),
                ],
                continue: repair,
            };
        }
    });
    pi.on("agent_settled", (_event, ctx) => {
        const op = operation(ctx);
        if (op?.status === "ready") {
            settled.add(op.operationId);
            const commandCtx = commandContexts.get(op.operationId);
            if (!commandCtx) {
                ctx.ui.notify("Treebase recovered; use /treebase resume before automatic activation.", "info");
                return;
            }
            // Do not await navigation from agent_settled: waitForIdle would
            // deadlock its dispatch. Retained command contexts are runtime-guarded.
            const timer = setTimeout(() => {
                pending.delete(timer);
                void apply(commandCtx, op.operationId).catch(error => {
                    // Reload/shutdown may invalidate guarded contexts while
                    // validation is awaiting I/O; do not touch them afterward.
                    if (commandContexts.get(op.operationId) !== commandCtx) return;
                    commandCtx.ui.notify(`Treebase activation failed: ${error instanceof Error ? error.message : String(error)}\nUse /treebase resume or cancel. Artifacts: ${op.directory}`, "error");
                });
            }, 0);
            pending.add(timer);
        }
        else if (op?.status === "failed") ctx.ui.notify(`Treebase paused: ${op.diagnostic}\nArtifacts: ${op.directory}`, "error");
        else if (op?.status === "editing") ctx.ui.notify("Treebase not completed. Use /treebase resume or cancel.", "info");
    });

    const handler = async (args: string, ctx: ExtensionCommandContext) => {
        if (ctx.mode !== "tui") {
            ctx.ui.notify("/treebase requires TUI mode", "error");
            return;
        }
        await ctx.waitForIdle();
        const sm = writableManager(ctx);
        try {
            const subcommand = args.trim();
            const op = operation(ctx);
            if (subcommand) {
                if (!["resume", "cancel"].includes(subcommand)) throw new Error("Use /treebase [resume|cancel]");
                if (!op || ["committed", "cancelled"].includes(op.status)) throw new Error("No active treebase operation on this branch");
                assertWorking(ctx, op);
                if (subcommand === "cancel") {
                    settled.delete(op.operationId);
                    commandContexts.delete(op.operationId);
                    sm.appendCustomEntry(STATE, { ...op, status: "cancelled" });
                    await activate(ctx, op.originalLeaf, sm.getLeafId());
                    ctx.ui.notify(`Treebase cancelled; artifacts retained at ${op.directory}`, "info");
                    return;
                }
                const work = await workspace(op);
                if (subcommand === "resume") {
                    settled.delete(op.operationId);
                    commandContexts.set(op.operationId, ctx);
                    await unlink(join(work.directory, "ready.json")).catch(() => {});
                    sm.appendCustomEntry(STATE, { ...op, status: "editing", repairs: 0 });
                    pi.sendUserMessage(`Continue the treebase operation ${op.operationId}. Inspect ${work.instructionsPath} and repair/edit ${work.contextPath}. ${op.diagnostic ?? ""}`);
                    return;
                }
                return;
            }
            if (op && ["editing", "ready", "failed"].includes(op.status)) throw new Error("An operation is already active. Use /treebase resume or cancel");
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
            commandContexts.set(state.operationId, ctx);
            pi.sendUserMessage(`Perform controlled editing on your own context for continued work based on treebase operation ${state.operationId}.
- Read ${work.instructionsPath}
- Inspect programmatically, batch precise edits, preserve retained facts concisely, and don't reintroduce removed material.
When finished, write ${join(work.directory, "ready.json")} containing {"operationId":"${state.operationId}"} and end your turn. The validated result will be activated automatically after your run settles.`);
            ctx.ui.notify(`Treebase editing on a temporary branch.\nArtifacts: ${work.directory}`, "info");
        } catch (error) {
            ctx.ui.notify(`Treebase failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
    };
    pi.registerCommand("treebase", {
        description: "Edit ancestor context with P/M/X (resume, cancel)", handler,
    });
}
