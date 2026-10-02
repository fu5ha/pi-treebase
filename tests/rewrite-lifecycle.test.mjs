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
        const hooks = new Map(), commands = new Map(), notices = [];
        extension({
            on: (name, handler) => hooks.set(name, handler),
            registerCommand: (name, command) => commands.set(name, command),
            sendUserMessage: () => {},
        });
        const ctx = {
            mode: "tui", sessionManager: sm, waitForIdle: async () => {},
            isIdle: () => true, hasPendingMessages: () => false,
            ui: { notify: message => notices.push(message) },
            navigateTree: async target => { sm.branch(target); return { cancelled: false }; },
        };
        assert.deepEqual([...commands.keys()], ["treebase"]);
        const command = args => commands.get("treebase").handler(args, ctx);
        const drain = async () => {
            for (let i = 0; i < 100 && !notices.at(-1)?.match(/branch created|activation failed/); i++)
                await new Promise(resolve => setTimeout(resolve, 10));
        };
        await command("resume");
        await writeFile(join(work.directory, "ready.json"), JSON.stringify({ operationId: state.operationId }));
        const boundary = async outcome => {
            const result = await hooks.get("agent_before_settle")({ outcome }, ctx);
            for (const draft of result?.entries ?? []) {
                if (draft.type === "custom") sm.appendCustomEntry(draft.customType, draft.data);
            }
            return result;
        };
        await boundary("aborted");
        const failedLeaf = sm.getLeafId();
        hooks.get("agent_settled")({}, ctx);
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(sm.getLeafId(), failedLeaf);
        assert.match(notices.at(-1), /paused/);

        sm.appendCustomEntry("treebase.operation", state);
        await boundary("completed");
        const readyLeaf = sm.getLeafId();
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(sm.getLeafId(), readyLeaf);
        hooks.get("agent_settled")({}, ctx);
        assert.equal(sm.getLeafId(), readyLeaf, "settled notification must not navigate");
        await drain();
        assert.match(notices.at(-1), /branch created/);
        assert.deepEqual(sm.buildSessionProjection().messages.filter(m => m.role === "user").map(m => m.content), ["keep"]);
        assert.equal(sm.getEntry(source).message.content, "keep");
        const count = sm.getEntries().length;
        sm.branch(readyLeaf);
        hooks.get("agent_settled")({}, ctx);
        await new Promise(resolve => setTimeout(resolve, 20));
        await command("resume");
        assert.match(notices.at(-1), /No active treebase operation/);
        assert.equal(sm.getEntries().length, count);
    } finally {
        await rm(work.directory, { recursive: true, force: true });
    }
});

test("cancelled operations stay cancelled when their earlier working leaf is revisited", async () => {
    const sm = SessionManager.inMemory(process.cwd());
    const source = sm.appendMessage({ role: "user", content: "original", timestamp: 1 });
    const anchor = sm.appendCustomEntry("treebase.working", {});
    const workingLeaf = sm.appendCustomEntry("treebase.operation", {
        operationId: "cancel-test", sessionId: sm.getSessionId(), originalLeaf: source,
        workingAnchor: anchor, status: "editing", repairs: 0, directory: "unused",
    });
    const commands = new Map(), notices = [];
    extension({ on: () => {}, registerCommand: (name, command) => commands.set(name, command) });
    const ctx = {
        mode: "tui", sessionManager: sm, waitForIdle: async () => {},
        ui: { notify: message => notices.push(message) },
        navigateTree: async target => { sm.branch(target); return { cancelled: false }; },
    };
    await commands.get("treebase").handler("cancel", ctx);
    assert.match(notices.at(-1), /cancelled/);
    assert.equal(sm.buildSessionProjection().messages[0].content, "original");
    sm.branch(workingLeaf);
    const count = sm.getEntries().length;
    await commands.get("treebase").handler("resume", ctx);
    assert.match(notices.at(-1), /No active treebase operation/);
    assert.equal(sm.getEntries().length, count);
});

for (const scenario of ["reload", "cancel", "navigation failure", "queued input"]) {
    test(`automatic activation is safe after ${scenario}`, async () => {
        const sm = SessionManager.inMemory(process.cwd());
        const source = sm.appendMessage({ role: "user", content: "original", timestamp: 1 });
        const work = await prepareWorkspace(sm, makeActionItems(sm.getBranch(), sm.buildSessionProjection()));
        try {
            const anchor = sm.appendCustomEntry("treebase.working", {});
            sm.appendCustomEntry("treebase.operation", {
                operationId: work.manifest.operationId, sessionId: sm.getSessionId(),
                originalLeaf: source, workingAnchor: anchor, directory: work.directory,
                manifestHash: work.manifestHash, status: "editing", repairs: 0,
            });
            const hooks = new Map(), commands = new Map(), notices = [];
            extension({
                on: (name, handler) => hooks.set(name, handler),
                registerCommand: (name, command) => commands.set(name, command),
                sendUserMessage: () => {},
            });
            const failNavigation = scenario === "navigation failure";
            const ctx = {
                mode: "tui", sessionManager: sm, waitForIdle: async () => {},
                isIdle: () => true, hasPendingMessages: () => scenario === "queued input",
                ui: { notify: message => notices.push(message) },
                navigateTree: async target => {
                    if (failNavigation) throw new Error("navigation failed");
                    sm.branch(target);
                    return { cancelled: false };
                },
            };
            const resume = () => commands.get("treebase").handler("resume", ctx);
            const complete = async () => {
                await writeFile(join(work.directory, "ready.json"), JSON.stringify({ operationId: work.manifest.operationId }));
                const result = await hooks.get("agent_before_settle")({ outcome: "completed" }, ctx);
                for (const entry of result.entries) sm.appendCustomEntry(entry.customType, entry.data);
                hooks.get("agent_settled")({}, ctx);
            };
            await resume();
            await complete();
            const readyLeaf = sm.getLeafId();
            if (scenario === "reload") hooks.get("session_start")({}, ctx);
            if (scenario === "cancel") await commands.get("treebase").handler("cancel", ctx);
            await new Promise(resolve => setTimeout(resolve, 100));
            assert.equal(sm.getEntries().some(e => e.type === "custom" &&
                e.customType === "treebase.operation" && e.data.status === "committed"), false);
            if (scenario !== "cancel") assert.equal(sm.getLeafId(), readyLeaf);
            if (scenario === "navigation failure" || scenario === "queued input")
                assert.match(notices.at(-1), /activation failed/);
            if (scenario === "reload") {
                // Recovered ready records alone are not enough; a fresh run is.
                hooks.get("agent_settled")({}, ctx);
                assert.match(notices.at(-1), /resume/);
                await resume();
                await complete();
                for (let i = 0; i < 100 && !notices.at(-1)?.includes("branch created"); i++)
                    await new Promise(resolve => setTimeout(resolve, 10));
                assert.match(notices.at(-1), /branch created/);
            }
        } finally {
            await rm(work.directory, { recursive: true, force: true });
        }
    });
}
