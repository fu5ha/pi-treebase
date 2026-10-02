import {
    SessionManager,
    type ExtensionCommandContext,
    type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";

/** pi 1.0 commands expose a read-only view of the live writable manager. */
export function writableManager(ctx: ExtensionCommandContext): SessionManager {
    const manager = ctx.sessionManager;
    if (!(manager instanceof SessionManager)) {
        throw new Error("Treebase requires the pi 1.0 SessionManager");
    }
    return manager;
}

export class BranchWriter {
    readonly ids = new Map<string, string>();

    readonly manager: SessionManager;

    constructor(manager: SessionManager) {
        this.manager = manager;
    }

    reference(id: string): string {
        const mapped = this.ids.get(id) ?? id;
        if (!this.manager.getBranch().some((entry) => entry.id === mapped)) {
            throw new Error(`Cannot reconstruct reference to ${id}: keep its target verbatim`);
        }
        return mapped;
    }

    append(original: SessionEntry): string {
        const sm = this.manager;
        let id: string;
        switch (original.type) {
            case "message": {
                const message = structuredClone(original.message);
                switch (message.role) {
                    case "system":
                    case "user":
                    case "assistant":
                    case "toolResult":
                    case "bashExecution":
                    case "custom":
                        id = sm.appendMessage(message);
                        break;
                    default:
                        throw new Error(`No public append API for message role ${message.role}`);
                }
                break;
            }
            case "custom_message":
                id = sm.appendCustomMessageEntry(original.customType, structuredClone(original.content),
                    original.display, structuredClone(original.details));
                break;
            case "custom":
                id = sm.appendCustomEntry(original.customType, structuredClone(original.data));
                break;
            case "model_change":
                id = sm.appendModelChange(original.provider, original.modelId);
                break;
            case "thinking_level_change":
                id = sm.appendThinkingLevelChange(original.thinkingLevel);
                break;
            case "usage":
                id = sm.appendUsage(original.kind, original.provider, original.model,
                    structuredClone(original.usage), original.note).id;
                break;
            case "session_info":
                if (original.name === undefined) {
                    throw new Error("pi 1.0 has no typed public API to append a cleared session name");
                }
                id = sm.appendSessionInfo(original.name);
                break;
            case "label":
                id = sm.appendLabelChange(this.reference(original.targetId), original.label);
                break;
            case "context_edit":
                id = sm.appendContextEdit(this.reference(original.targetId), structuredClone(original.replacement));
                break;
            case "compaction": {
                // Public appendCompaction computes a fresh checkpoint. Verify that it
                // can reproduce this record before trusting that behavior.
                if (original.systemMessage) {
                    const expected = getCurrentSystemMessage([original.systemMessage]);
                    const actual = getCurrentSystemMessage(sm.buildSessionProjection().messages);
                    const withoutTime = (message: typeof actual) =>
                        message ? { ...message, timestamp: 0 } : undefined;
                    if (JSON.stringify(withoutTime(expected)) !== JSON.stringify(withoutTime(actual))) {
                        throw new Error(`Cannot reproduce system checkpoint at ${original.id} with pi's public API`);
                    }
                }
                const boundary = original.firstKeptEntryId === original.id
                    ? null : this.reference(original.firstKeptEntryId);
                id = sm.appendCompaction(original.summary, boundary, original.tokensBefore,
                    structuredClone(original.details), original.fromHook, structuredClone(original.usage));
                break;
            }
            case "branch_summary": {
                const parent = sm.getLeafId();
                const from = this.ids.get(original.fromId) ?? original.fromId;
                // branchWithSummary captures the current leaf as provenance.
                if (from === "root") sm.resetLeaf();
                else if (sm.getEntry(from)) sm.branch(from);
                else throw new Error(`Cannot preserve branch-summary provenance ${original.fromId}`);
                id = sm.branchWithSummary(parent, original.summary, structuredClone(original.details),
                    original.fromHook, structuredClone(original.usage));
                break;
            }
            default:
                throw new Error(`No public reconstruction API for session entry ${(original as SessionEntry).type}`);
        }
        this.ids.set(original.id, id);
        return id;
    }
}
