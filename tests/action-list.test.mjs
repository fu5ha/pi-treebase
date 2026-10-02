import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { showActionList } from "../extensions/treebase/action-list.ts";
import { makeActionItems } from "../extensions/treebase/tree-utils.ts";

const assistant = content => ({
    role: "assistant", content, api: "openai-completions", provider: "openai",
    model: "test", timestamp: 1, stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const text = value => ({ type: "text", text: value });
const call = { type: "toolCall", id: "call", name: "read", arguments: { path: "file" } };

function fixture({ final = true, textEnvelope = false } = {}) {
    const sm = SessionManager.inMemory(process.cwd());
    sm.appendMessage({ role: "user", content: "request", timestamp: 1 });
    sm.appendMessage({ ...assistant(textEnvelope ? [text("working"), call] : [call]), stopReason: "toolUse" });
    sm.appendMessage({ role: "toolResult", toolCallId: "call", toolName: "read",
        content: [text("result")], isError: false, timestamp: 1 });
    if (final) sm.appendMessage(assistant([text("answer")]));
    return sm;
}

async function select(sm, keys, modify = items => items, expectedNotices = []) {
    const notices = [];
    const theme = { fg: (_color, value) => value, bg: (_color, value) => value, bold: value => value };
    const ctx = {
        mode: "tui", sessionManager: sm,
        ui: {
            theme, notify: message => notices.push(message),
            custom: factory => new Promise(resolve => {
                const component = factory({ terminal: { rows: 40 }, requestRender() {} },
                    theme, { matches: () => false }, resolve);
                component.render(120);
                for (const key of keys) {
                    component.handleInput(key);
                    component.render(120);
                }
                component.handleInput("\r");
            }),
        },
    };
    const result = await showActionList(ctx, modify(makeActionItems(sm.getBranch())));
    assert.deepEqual(notices, expectedNotices, "tool dependencies must remain valid at confirmation");
    return result;
}

for (const [key, action] of [["p", "pick"], ["x", "remove"], ["m", "model"]]) {
    test(`changing a unified final response to ${key.toUpperCase()} preserves intermediates`, async () => {
        const initial = key === "m" ? "pick" : "model";
        const result = await select(fixture(), [key], items => items.map(item =>
            item.entry.type === "message" && item.entry.message.role !== "user"
                ? { ...item, action: initial } : item));
        assert.deepEqual(result.map(item => item.action), ["model", initial, initial, action]);
        assert.equal(result[1].groupId, result[2].groupId);
        assert.notEqual(result[2].groupId, result[3].groupId);
    });
}

test("intermediate edits stay grouped, preserve the final, and rejoin matching actions", async () => {
    const split = await select(fixture({ textEnvelope: true }), ["\x1b[A", "x"]);
    assert.deepEqual(split.map(item => item.action), ["model", "remove", "remove", "model"]);
    assert.equal(split[1].groupId, split[2].groupId);
    assert.notEqual(split[2].groupId, split[3].groupId);
    const joined = await select(fixture(), ["x", "\x1b[A", "x"]);
    assert.deepEqual(joined.map(item => item.action), ["model", "remove", "remove", "remove"]);
    assert.equal(joined[1].groupId, joined[3].groupId);
    // A rejoined turn should split again when only its final action changes.
    const resplit = await select(fixture(), ["x", "\x1b[A", "x", "\x1b[B", "p"]);
    assert.deepEqual(resplit.map(item => item.action), ["model", "remove", "remove", "pick"]);
});

test("a trailing text-bearing tool call is not detached from its results", async () => {
    const result = await select(fixture({ final: false, textEnvelope: true }), ["\x1b[A", "x"]);
    assert.deepEqual(result.map(item => item.action), ["model", "remove", "remove"]);
    assert.equal(result[1].groupId, result[2].groupId);
});

test("locked turns and single-message final turns retain their existing behavior", async () => {
    const locked = await select(fixture(), ["x"], items => items.map(item =>
        item.entry.type === "message" && item.entry.message.role !== "user"
            ? { ...item, protected: true, action: "pick" } : item), ["Locked: preserved"]);
    assert.deepEqual(locked.map(item => item.action), ["model", "pick", "pick", "pick"]);
    const sm = SessionManager.inMemory(process.cwd());
    sm.appendMessage(assistant([text("answer")]));
    const single = await select(sm, ["x", "p"]);
    assert.equal(single[0].action, "pick");
});
