import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { makeActionItems } from "../extensions/treebase/tree-utils.ts";

const assistant = content => ({
    role: "assistant", content, api: "openai-completions", provider: "openai",
    model: "test", timestamp: 1, stopReason: "toolUse",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const call = id => ({ type: "toolCall", id, name: "read", arguments: { path: "file" } });
const result = id => ({
    role: "toolResult", toolCallId: id, toolName: "read",
    content: [{ type: "text", text: "result" }], isError: false, timestamp: 1,
});

test("omitted recovery attempt does not lock later calls or final response in the same turn", () => {
    const sm = SessionManager.inMemory(process.cwd());
    sm.appendMessage({ role: "user", content: "request", timestamp: 1 });
    const failed = sm.appendMessage(assistant([call("failed")]));
    const edit = sm.appendContextEdit(failed, null);
    const successful = sm.appendMessage(assistant([call("successful")]));
    const toolResult = sm.appendMessage(result("successful"));
    const final = sm.appendMessage({ ...assistant([{ type: "text", text: "done" }]), stopReason: "stop" });
    const items = makeActionItems(sm.getBranch(), sm.buildSessionProjection());
    const byId = new Map(items.map(item => [item.id, item]));
    assert.equal(byId.get(failed).protectedReason, "structural reference target");
    assert.equal(byId.get(edit).protected, true);
    for (const id of [successful, toolResult, final]) {
        assert.equal(byId.get(id).protected, false);
        assert.equal(byId.get(id).action, "model");
        assert.equal(byId.get(id).groupId, byId.get(failed).groupId);
    }
});

test("locking a tool result protects its envelope and sibling results, not other calls or final", () => {
    const sm = SessionManager.inMemory(process.cwd());
    sm.appendMessage({ role: "user", content: "request", timestamp: 1 });
    const envelope = sm.appendMessage(assistant([call("a"), call("b")]));
    const first = sm.appendMessage(result("a"));
    const second = sm.appendMessage(result("b"));
    sm.appendLabelChange(first, "important");
    const other = sm.appendMessage(assistant([call("other")]));
    const otherResult = sm.appendMessage(result("other"));
    const final = sm.appendMessage({ ...assistant([{ type: "text", text: "done" }]), stopReason: "stop" });
    const items = makeActionItems(sm.getBranch(), sm.buildSessionProjection());
    const byId = new Map(items.map(item => [item.id, item]));
    for (const id of [envelope, first, second]) assert.equal(byId.get(id).protected, true);
    assert.match(byId.get(envelope).protectedReason, new RegExp(`tool dependency on ${first}`));
    assert.match(byId.get(second).protectedReason, /structural reference target/);
    for (const id of [other, otherResult, final]) assert.equal(byId.get(id).protected, false);
});
