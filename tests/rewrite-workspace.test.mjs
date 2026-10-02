import assert from "node:assert/strict";
import { readFile, writeFile, rm, mkdtemp, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { prepareWorkspace, loadWorkspace, validateWorkspace } from "../extensions/treebase/rewrite-workspace.ts";
import { makeActionItems } from "../extensions/treebase/tree-utils.ts";
import { BranchWriter } from "../extensions/treebase/session-writer.ts";

const read = async work => (await readFile(work.contextPath, "utf8"))
    .split(/\r?\n/).filter(line => line.trim()).map(JSON.parse);
const write = (work, records) => writeFile(work.contextPath, records.map(JSON.stringify).join("\n") + "\n");
const cleanup = work => rm(work.directory, { recursive: true, force: true });
const items = sm => makeActionItems(sm.getBranch(), sm.buildSessionProjection());
const usage = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = content => ({
    role: "assistant", content, api: "openai-completions", provider: "openai", model: "test",
    usage, stopReason: "toolUse", timestamp: 1,
});
const call = (id, name = "grep") => ({ type: "toolCall", id, name, arguments: { pattern: "useful", path: "." } });
const result = (id, text, extra = {}) => ({
    role: "toolResult", toolCallId: id, toolName: "grep",
    content: [{ type: "text", text }], isError: false, timestamp: 2, ...extra,
});

test("ordered source JSONL exports one branch, implies M, and restores metadata/parent links", async () => {
    const sm = SessionManager.inMemory(process.cwd());
    const first = sm.appendMessage({ role: "user", content: "long ".repeat(100), timestamp: 1 });
    const second = sm.appendMessage({ role: "user", content: "second ".repeat(100), timestamp: 2 });
    sm.branch(first);
    const sibling = sm.appendMessage({ role: "user", content: "unrelated", timestamp: 3 });
    sm.branch(second);
    const work = await prepareWorkspace(sm, items(sm));
    try {
        assert.equal("version" in work.manifest, false);
        assert.deepEqual(work.choices, []);
        assert.deepEqual(JSON.parse(await readFile(work.choicesPath, "utf8")), []);
        assert.equal("choices" in work.manifest, false);
        assert.equal(typeof work.manifest.choicesHash, "string");
        assert.deepEqual(work.manifest.selectedIds, [first, second]);
        const exported = await read(work);
        assert.deepEqual(exported.map(e => e.source), [first, second]);
        assert.ok(exported.every(e => !("parentId" in e) && !("timestamp" in e)));
        assert.ok((await readFile(work.originalPath, "utf8")).includes(sibling));
        await write(work, [{ source: second, content: "short" }, { source: first }]);
        const validated = await validateWorkspace(sm, work);
        assert.deepEqual(validated.entries.map(e => e.id), [second, first]);
        assert.equal(validated.entries[0].parentId, null);
        assert.equal(validated.entries[1].parentId, second);
        assert.equal(validated.entries[0].message.timestamp, 2);
        assert.equal(validated.entries[0].message.content, "short");
        await write(work, [{ source: first, content: "short", timestamp: 999 }]);
        await assert.rejects(validateWorkspace(sm, work));
        await write(work, [{ source: first }, { source: first }]);
        await assert.rejects(validateWorkspace(sm, work), /[Dd]uplicate/);
        await write(work, [{ source: sibling }]);
        await assert.rejects(validateWorkspace(sm, work));
    } finally { await cleanup(work); }
});

test("X is absent, prefix read-only, P source-only, and empty selected extraction is valid", async () => {
    const sm = SessionManager.inMemory(process.cwd());
    const prefix = sm.appendMessage({ role: "user", content: "prefix", timestamp: 1 });
    const selected = sm.appendMessage({ role: "user", content: "selected", timestamp: 2 });
    const selection = items(sm).slice(1);
    const work = await prepareWorkspace(sm, selection.map(e => ({ ...e, action: "remove" })));
    try {
        assert.deepEqual(await read(work), [{ source: prefix }]);
        assert.deepEqual((await validateWorkspace(sm, work)).entries, []);
        await write(work, [{ source: prefix }, { source: selected }]);
        await assert.rejects(validateWorkspace(sm, work), /X|exclude|remove/i);
        await write(work, [{ source: prefix, content: "changed" }]);
        await assert.rejects(validateWorkspace(sm, work));
        await write(work, []);
        await assert.rejects(validateWorkspace(sm, work));
    } finally { await cleanup(work); }
    const pickWork = await prepareWorkspace(sm, selection.map(e => ({ ...e, action: "pick" })));
    try {
        assert.deepEqual(await read(pickWork), [{ source: prefix }, { source: selected }]);
        await write(pickWork, [{ source: prefix }, { source: selected, content: "tampered" }]);
        await assert.rejects(validateWorkspace(sm, pickWork));
        await write(pickWork, [{ source: prefix }]);
        await assert.rejects(validateWorkspace(sm, pickWork));
    } finally { await cleanup(pickWork); }
});

test("context-edit/compaction effects stay locked and native roundtrip works", async () => {
    const sm = SessionManager.inMemory(process.cwd());
    const gone = sm.appendMessage({ role: "user", content: "old", timestamp: 1 });
    const kept = sm.appendMessage({ role: "user", content: "effective".repeat(30), timestamp: 2 });
    sm.appendContextEdit(kept, { content: "changed".repeat(30) });
    sm.appendCompaction("summary", kept, 100);
    const selection = items(sm);
    assert.equal(selection.find(e => e.id === gone).protected, true);
    assert.equal(selection.find(e => e.id === kept).protected, true);
    await assert.rejects(prepareWorkspace(sm, selection.map(e => e.id === gone ? { ...e, action: "remove" } : e)), /Locked/);
    const work = await prepareWorkspace(sm, selection);
    try {
        assert.equal((await validateWorkspace(sm, work)).entries.length, selection.length);
        await write(work, (await read(work)).filter(e => e.source !== gone));
        await assert.rejects(validateWorkspace(sm, work));
    } finally { await cleanup(work); }
});

test("synthesis and reordered M stay in their P-anchor interval", async () => {
    const sm = SessionManager.inMemory(process.cwd());
    const left = sm.appendMessage({ role: "user", content: "left ".repeat(100), timestamp: 1 });
    const anchor = sm.appendMessage({ role: "user", content: "P", timestamp: 2 });
    const right = sm.appendMessage({ role: "user", content: "right ".repeat(100), timestamp: 3 });
    const work = await prepareWorkspace(sm, items(sm).map(e => e.id === anchor ? { ...e, action: "pick" } : e));
    try {
        await write(work, [{ source: left }, { source: anchor },
            { kind: "context", sources: [right], content: "concise" }]);
        const validated = await validateWorkspace(sm, work);
        assert.equal(validated.entries[2].type, "custom_message");
        assert.equal(validated.entries[2].customType, "treebase.context");
        assert.equal(validated.entries[2].display, true);
        assert.deepEqual(validated.entries[2].details.treebaseSources, [right]);
        assert.equal(validated.entries[2].parentId, anchor);
        await write(work, [{ source: right }, { source: anchor }, { source: left }]);
        await assert.rejects(validateWorkspace(sm, work), /anchor|interval/i);
        await write(work, [{ source: anchor }, { kind: "context", sources: [left, right], content: "bad" }]);
        await assert.rejects(validateWorkspace(sm, work), /anchor|interval/i);
        await write(work, [{ source: left }, { source: anchor },
            { kind: "context", sources: [anchor], content: "bad" }]);
        await assert.rejects(validateWorkspace(sm, work));
    } finally { await cleanup(work); }
});

test("choices are a plain sparse P/X array with a minimal schema and separate manifest", async () => {
    const sm = SessionManager.inMemory(process.cwd());
    const pick = sm.appendMessage({ role: "user", content: "pick", timestamp: 1 });
    const model = sm.appendMessage({ role: "user", content: "model", timestamp: 2 });
    const remove = sm.appendMessage({ role: "user", content: "remove", timestamp: 3 });
    const work = await prepareWorkspace(sm, items(sm).map(e => ({
        ...e, action: e.id === pick ? "pick" : e.id === remove ? "remove" : "model",
    })));
    try {
        const expected = [{ id: pick, action: "P" }, { id: remove, action: "X" }];
        assert.deepEqual(work.choices, expected);
        assert.deepEqual(JSON.parse(await readFile(work.choicesPath, "utf8")), expected);
        assert.ok(!work.choices.some(e => e.id === model));
        const schema = JSON.parse(await readFile(join(work.directory, "choices.schema.json"), "utf8"));
        assert.equal(schema.type, "array");
        assert.equal(schema.items.type, "object");
        assert.equal(schema.items.additionalProperties, false);
        assert.deepEqual([...schema.items.required].sort(), ["action", "id"]);
        assert.deepEqual(Object.keys(schema.items.properties).sort(), ["action", "id"]);
        assert.deepEqual(schema.items.properties.action.enum, ["P", "X"]);
        assert.deepEqual(JSON.parse(await readFile(work.manifestPath, "utf8")), work.manifest);
        assert.equal("choices" in work.manifest, false);
        assert.equal("version" in work.manifest, false);
        const loaded = await loadWorkspace(work.directory, work.manifestHash);
        assert.deepEqual(loaded.choices, expected);
        assert.deepEqual(loaded.manifest, work.manifest);
    } finally { await cleanup(work); }
});

test("workspace snapshot hashes and no-legacy contract are enforced", async () => {
    const sm = SessionManager.inMemory(process.cwd());
    sm.appendMessage({ role: "user", content: "original", timestamp: 1 });
    const work = await prepareWorkspace(sm, items(sm));
    try {
        const snapshot = await readFile(work.originalPath, "utf8");
        await write(work, snapshot.trim().split("\n").map(JSON.parse));
        await assert.rejects(validateWorkspace(sm, work));
        await chmod(work.originalPath, 0o600);
        await writeFile(work.originalPath, snapshot + "\n");
        await assert.rejects(validateWorkspace(sm, work), /snapshot integrity/);
    } finally { await cleanup(work); }
});

test("loadWorkspace checks manifest integrity before choices integrity", async () => {
    const sm = SessionManager.inMemory(process.cwd());
    sm.appendMessage({ role: "user", content: "original", timestamp: 1 });
    const work = await prepareWorkspace(sm, items(sm));
    try {
        await writeFile(work.manifestPath, "{}");
        await assert.rejects(loadWorkspace(work.directory, work.manifestHash), /manifest\.json changed/);
        await writeFile(work.choicesPath, "{}");
        await assert.rejects(loadWorkspace(work.directory, work.manifestHash), /manifest\.json changed/);
    } finally { await cleanup(work); }
});

test("loadWorkspace checks choices integrity independently of the manifest", async () => {
    const sm = SessionManager.inMemory(process.cwd());
    sm.appendMessage({ role: "user", content: "original", timestamp: 1 });
    const work = await prepareWorkspace(sm, items(sm));
    try {
        await writeFile(work.choicesPath, "{}");
        await assert.rejects(loadWorkspace(work.directory, work.manifestHash), /choices\.json changed/);
    } finally { await cleanup(work); }
});

test("reconstructed native effective context must shrink and fit the model budget", async () => {
    const sm = SessionManager.inMemory(process.cwd());
    const source = sm.appendMessage({ role: "user", content: "original ".repeat(100), timestamp: 1 });
    const work = await prepareWorkspace(sm, items(sm));
    try {
        await write(work, [{ source, content: "bigger ".repeat(1000) }]);
        await assert.rejects(validateWorkspace(sm, work), /grew/);
        await write(work, [{ source, content: "retained ".repeat(30) }]);
        await assert.rejects(validateWorkspace(sm, work, 1), /90% model budget/);
        await write(work, [{ source, content: "short" }]);
        assert.ok((await validateWorkspace(sm, work, 1000)).estimatedTokens <
            work.manifest.originalEstimatedTokens);
    } finally { await cleanup(work); }
});

test("tool excerpt preserves full call input and extracts exact lines with durable provenance", async () => {
    const sm = SessionManager.inMemory(process.cwd());
    const input = call("grep-1");
    const envelope = sm.appendMessage(assistant([input]));
    const fullText = Array.from({ length: 50 }, (_, i) => `${i + 1}: ${"useful ".repeat(10)}`).join("\n");
    const priorProvenance = { resultSource: "earlier-source", keep: [] };
    const output = sm.appendMessage(result("grep-1", fullText, {
        details: { original: true, treebaseExcerpt: priorProvenance }, isError: true,
    }));
    const work = await prepareWorkspace(sm, items(sm));
    try {
        await write(work, [{ source: envelope },
            { kind: "tool-excerpt", callSource: envelope, resultSource: output,
                keep: [{ block: 0, startLine: 3, endLine: 4 }, { block: 0, startLine: 20, endLine: 20 }] }]);
        const validated = await validateWorkspace(sm, work);
        assert.deepEqual(validated.entries[0].message.content, [input]);
        const excerpt = validated.entries[1].message;
        const text = excerpt.content.map(b => b.text ?? "").join("\n");
        assert.ok(text.includes(fullText.split("\n").slice(2, 4).join("\n")));
        assert.ok(text.includes(fullText.split("\n")[19]));
        assert.ok(!text.includes(fullText.split("\n")[9]));
        assert.match(text, /omitt/i);
        assert.equal(excerpt.toolCallId, "grep-1");
        assert.equal(excerpt.toolName, "grep");
        assert.equal(excerpt.isError, true);
        assert.equal(excerpt.details.original, true);
        assert.ok(excerpt.details.treebaseExcerpt);
        assert.deepEqual(excerpt.details.treebaseExcerpt.previous, priorProvenance);
        assert.ok(validated.estimatedTokens < work.manifest.originalEstimatedTokens);
    } finally { await cleanup(work); }
});

test("excerpt can reference a protected prefix call and preserves CRLF bytes/non-text blocks", async () => {
    const sm = SessionManager.inMemory(process.cwd());
    const envelope = sm.appendMessage(assistant([call("grep-1")]));
    const image = { type: "image", data: "AA==", mimeType: "image/png" };
    const output = sm.appendMessage(result("grep-1", "", {
        content: [
            { type: "text", text: "discard ".repeat(100) + "\r\nfirst useful\r\nsecond useful\r\nlast" },
            image,
        ],
    }));
    const work = await prepareWorkspace(sm, items(sm).slice(1));
    const excerpt = { kind: "tool-excerpt", callSource: envelope, resultSource: output,
        keep: [{ block: 0, startLine: 2, endLine: 3 }] };
    try {
        await write(work, [{ source: envelope }, excerpt]);
        const validated = await validateWorkspace(sm, work);
        assert.equal(validated.entries.length, 1);
        assert.equal(validated.entries[0].parentId, envelope);
        assert.ok(validated.entries[0].message.content[0].text.includes("first useful\r\nsecond useful\r"));
        assert.deepEqual(validated.entries[0].message.content[1], image);
        await write(work, [{ source: envelope }, { ...excerpt, keep: [{ block: 1, startLine: 1, endLine: 1 }] }]);
        await assert.rejects(validateWorkspace(sm, work), /text blocks/);
    } finally { await cleanup(work); }
});

test("tool excerpts reject invalid ranges, mismatched/edited calls and protected results", async () => {
    const sm = SessionManager.inMemory(process.cwd());
    const envelope = sm.appendMessage(assistant([call("grep-1")]));
    const output = sm.appendMessage(result("grep-1", "one\ntwo\nthree"));
    const work = await prepareWorkspace(sm, items(sm));
    const excerpt = keep => ({ kind: "tool-excerpt", callSource: envelope, resultSource: output, keep });
    try {
        for (const keep of [
            [], [{ block: 0, startLine: 0, endLine: 1 }], [{ block: 0, startLine: 2, endLine: 4 }],
            [{ block: 1, startLine: 1, endLine: 1 }], [{ block: 0, startLine: 2, endLine: 1 }],
            [{ block: 0, startLine: 1.5, endLine: 2 }],
            [{ block: 0, startLine: 1, endLine: 2 }, { block: 0, startLine: 2, endLine: 3 }],
        ]) {
            await write(work, [{ source: envelope }, excerpt(keep)]);
            await assert.rejects(validateWorkspace(sm, work));
        }
        const valid = excerpt([{ block: 0, startLine: 1, endLine: 1 }]);
        await write(work, [{ source: envelope, content: [call("grep-1", "other")] }, valid]);
        await assert.rejects(validateWorkspace(sm, work));
        await write(work, [valid]);
        await assert.rejects(validateWorkspace(sm, work));
        await write(work, [{ source: envelope }, { ...valid, callSource: output }]);
        await assert.rejects(validateWorkspace(sm, work));
    } finally { await cleanup(work); }
    const pickWork = await prepareWorkspace(sm, items(sm).map(e => ({ ...e, action: "pick" })));
    try {
        await write(pickWork, [{ source: envelope }, excerpt([{ block: 0, startLine: 1, endLine: 1 }])]);
        await assert.rejects(validateWorkspace(sm, pickWork));
    } finally { await cleanup(pickWork); }
});

test("multi-call envelopes require all matching results and excerpts never duplicate the call", async () => {
    const sm = SessionManager.inMemory(process.cwd());
    const envelope = sm.appendMessage(assistant([call("a"), call("b")]));
    const a = sm.appendMessage(result("a", "long ".repeat(100) + "\nuseful"));
    const b = sm.appendMessage(result("b", "long ".repeat(100) + "\nuseful"));
    const work = await prepareWorkspace(sm, items(sm));
    const excerpt = resultSource => ({ kind: "tool-excerpt", callSource: envelope, resultSource,
        keep: [{ block: 0, startLine: 2, endLine: 2 }] });
    try {
        await write(work, [{ source: envelope }, excerpt(a), excerpt(b)]);
        const validated = await validateWorkspace(sm, work);
        assert.equal(validated.entries.length, 3);
        assert.equal(validated.entries.filter(e => e.message?.role === "assistant").length, 1);
        await write(work, [{ source: envelope }, excerpt(a)]);
        await assert.rejects(validateWorkspace(sm, work), /Missing tool results/);
    } finally { await cleanup(work); }
});

test("ordered import reconstructs excerpt and synthesis through native APIs and persisted reload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "treebase-excerpt-reload-"));
    let work;
    try {
        const sm = SessionManager.create(directory, directory);
        const envelope = sm.appendMessage(assistant([call("grep-1")]));
        const originalText = "discard ".repeat(100) + "\nuseful match";
        const output = sm.appendMessage(result("grep-1", originalText));
        const tail = sm.appendMessage({ role: "user", content: "verbose ".repeat(100), timestamp: 3 });
        work = await prepareWorkspace(sm, items(sm));
        await write(work, [{ source: envelope },
            { kind: "tool-excerpt", callSource: envelope, resultSource: output,
                keep: [{ block: 0, startLine: 2, endLine: 2 }] },
            { kind: "context", sources: [tail], content: "Useful follow-up" }]);
        const validated = await validateWorkspace(sm, work);
        sm.resetLeaf();
        const writer = new BranchWriter(sm);
        for (const entry of validated.entries) writer.append(entry);
        const projection = sm.buildSessionProjection().messages;
        const reloaded = SessionManager.open(sm.getSessionFile());
        assert.deepEqual(reloaded.buildSessionProjection().messages, projection);
        assert.equal(reloaded.getEntry(output).message.content[0].text, originalText);
        const importedResult = reloaded.getBranch().find(e => e.message?.role === "toolResult");
        assert.ok(importedResult.message.details.treebaseExcerpt);
        assert.equal(importedResult.parentId, writer.ids.get(envelope));
        assert.ok(reloaded.getBranch().some(e => e.type === "custom_message" &&
            e.customType === "treebase.context" && e.details.treebaseSources[0] === tail));
    } finally {
        if (work) await cleanup(work);
        await rm(directory, { recursive: true, force: true });
    }
});
