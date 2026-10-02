import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/treebase/index.ts";
import { prepareWorkspace } from "../extensions/treebase/rewrite-workspace.ts";
import { makeActionItems } from "../extensions/treebase/tree-utils.ts";

test("only successful completed editing activates; revisiting a working branch cannot commit twice", async () => {
    const sm = SessionManager.inMemory(process.cwd());
    const source = sm.appendMessage({ role: "user", content: "keep", timestamp: 1 });
    const work = await prepareWorkspace(sm, makeActionItems(sm.getBranch(), sm.buildSessionProjection()));
    try {
        const workingAnchor = sm.appendCustomEntry("treebase.working", { operationId: work.manifest.operationId });
        const state = {
            operationId: work.manifest.operationId, sessionId: sm.getSessionId(), originalLeaf: source,
            workingAnchor, directory: work.directory, manifestHash: work.manifestHash,
            status: "editing", repairs: 0,
        };
        sm.appendCustomEntry("treebase.operation", state);
        await writeFile(join(work.directory, "ready.json"), JSON.stringify({ operationId: state.operationId }));
        const hooks = new Map(), commands = new Map(), notices = [];
        extension({
            on: (name, handler) => hooks.set(name, handler),
            registerCommand: (name, command) => commands.set(name, command),
            sendUserMessage: () => {},
        });
        const ctx = {
            mode: "tui", sessionManager: sm, waitForIdle: async () => {},
            ui: { notify: message => notices.push(message) },
            navigateTree: async target => { sm.branch(target); return { cancelled: false }; },
        };
        const boundary = async outcome => {
            const result = await hooks.get("agent_before_settle")({ outcome }, ctx);
            for (const draft of result?.entries ?? []) {
                if (draft.type === "custom") sm.appendCustomEntry(draft.customType, draft.data);
            }
            return result;
        };
        await boundary("aborted");
        const failedLeaf = sm.getLeafId();
        await commands.get("pi-treebase").handler("apply", ctx);
        assert.equal(sm.getLeafId(), failedLeaf);
        assert.match(notices.at(-1), /not completed successfully/);

        sm.appendCustomEntry("treebase.operation", state);
        await boundary("completed");
        const readyLeaf = sm.getLeafId();
        await commands.get("pi-treebase").handler("apply", ctx);
        assert.match(notices.at(-1), /Settlement is not confirmed/);
        assert.equal(sm.getLeafId(), readyLeaf);
        hooks.get("agent_settled")({}, ctx);
        assert.equal(sm.getLeafId(), readyLeaf, "settled notification must not navigate");
        await commands.get("pi-treebase").handler("apply", ctx);
        assert.match(notices.at(-1), /branch created/);
        assert.deepEqual(sm.buildSessionProjection().messages.filter(m => m.role === "user").map(m => m.content), ["keep"]);
        assert.equal(sm.getEntry(source).message.content, "keep");
        const count = sm.getEntries().length;
        sm.branch(readyLeaf);
        await commands.get("pi-treebase").handler("apply", ctx);
        assert.match(notices.at(-1), /No active treebase operation/);
        assert.equal(sm.getEntries().length, count);
    } finally {
        await rm(work.directory, { recursive: true, force: true });
    }
});
