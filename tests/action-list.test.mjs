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

async function select(sm, keys, modify = items => items, expectedNotices = [], capture = {}) {
    const notices = [];
    const theme = {
        fg: (color, value) => {
            capture.colors?.push({ color, value });
            return value;
        },
        bg: (_color, value) => value, bold: value => value,
    };
    const ctx = {
        mode: "tui", sessionManager: sm,
        ui: {
            theme, notify: message => notices.push(message),
            custom: factory => new Promise(resolve => {
                const component = factory({ terminal: { rows: 40 }, requestRender() {} },
                    theme, { matches: () => false }, resolve);
                const render = () => {
                    const lines = component.render(120);
                    capture.frames?.push(lines);
                };
                render();
                for (const key of keys) {
                    component.handleInput(key);
                    render();
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
    const lockedSm = fixture();
    const locked = await select(lockedSm, ["x"], items => items.map(item =>
        item.entry.type === "message" && item.entry.message.role !== "user"
            ? { ...item, protected: true, action: "pick" } : item), [`Locked ${lockedSm.getLeafId()}: preserved`]);
    assert.deepEqual(locked.map(item => item.action), ["model", "pick", "pick", "pick"]);
    const sm = SessionManager.inMemory(process.cwd());
    sm.appendMessage(assistant([text("answer")]));
    const single = await select(sm, ["x", "p"]);
    assert.equal(single[0].action, "pick");
});

const lockFirstToolPair = items => items.map((item, index) =>
    index === 1 || index === 2
        ? { ...item, protected: true, protectedReason: "reference target", action: "pick" }
        : item);

test("locked rows show L in a distinct color and mixed groups show editable actions", async () => {
    const capture = { frames: [], colors: [] };
    const result = await select(fixture(), ["x"], items =>
        lockFirstToolPair(items).map((item, index) => index === 0 ? { ...item, action: "pick" } : item),
        [], capture);
    assert.deepEqual(result.map(item => item.action), ["pick", "pick", "pick", "remove"]);
    const initial = capture.frames[0].join("\n");
    assert.match(initial, /\|L\|.*\[read: file\]/);
    assert.match(initial, /\[M\].*assistant: answer/);
    assert.match(capture.frames.at(-1).join("\n"), /\[X\].*assistant: answer/);
    assert.ok(capture.colors.some(({ color, value }) => color === "dim" && value === "|L|"));
    assert.ok(capture.colors.some(({ color, value }) => color === "warning" && value === "[P]"));
});

function mixedTurnFixture() {
    const sm = fixture({ final: false, textEnvelope: true });
    const secondCall = { ...call, id: "second-call", arguments: { path: "second" } };
    sm.appendMessage({ ...assistant([text("more work"), secondCall]), stopReason: "toolUse" });
    sm.appendMessage({ role: "toolResult", toolCallId: "second-call", toolName: "read",
        content: [text("second result")], isError: false, timestamp: 1 });
    sm.appendMessage(assistant([text("answer")]));
    return sm;
}

test("editable intermediate rows in a mixed locked turn stay paired and final stays isolated", async () => {
    const result = await select(mixedTurnFixture(), ["x", "\x1b[A", "p"], lockFirstToolPair);
    assert.deepEqual(result.map(item => item.action),
        ["model", "pick", "pick", "pick", "pick", "remove"]);
    assert.equal(result[1].groupId, result[2].groupId);
    assert.equal(result[3].groupId, result[4].groupId);
    assert.notEqual(result[4].groupId, result[5].groupId);
});

test("normalizing a mixed locked turn never changes locked actions or prevents another split", async () => {
    const capture = { frames: [] };
    const result = await select(mixedTurnFixture(),
        ["x", "\x1b[A", "x", "\x1b[B", "p"], lockFirstToolPair, [], capture);
    assert.deepEqual(result.map(item => item.action),
        ["model", "pick", "pick", "remove", "remove", "pick"]);
    assert.equal(result[1].groupId, result[2].groupId);
    assert.equal(result[3].groupId, result[4].groupId);
    assert.notEqual(result[4].groupId, result[5].groupId);
    assert.match(capture.frames[3].join("\n"), /\|L\|.*\[read: file\]/);
    assert.match(capture.frames[3].join("\n"), /\|X\|.*\[read: second\]/);
});

test("editing intermediates preserves a locked final response", async () => {
    const result = await select(fixture(), ["\x1b[A", "x"], items => items.map((item, index) =>
        index === 3 ? { ...item, protected: true, action: "pick" } : item));
    assert.deepEqual(result.map(item => item.action), ["model", "remove", "remove", "pick"]);
    assert.equal(result[1].groupId, result[2].groupId);
    assert.notEqual(result[2].groupId, result[3].groupId);
});
