import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { prepareWorkspace, validateWorkspace } from "../extensions/treebase/rewrite-workspace.ts";
import { makeActionItems } from "../extensions/treebase/tree-utils.ts";

async function edit(workspace, change) {
    const records = (await readFile(workspace.contextPath, "utf8")).trim().split("\n").map(JSON.parse);
    await writeFile(workspace.contextPath, change(records).map(JSON.stringify).join("\n") + "\n");
}

test("choices stores only P/X overrides; implied M is editable but metadata remains protected", async () => {
    const sm = SessionManager.inMemory(process.cwd());
    const first = sm.appendMessage({ role: "user", content: "long ".repeat(100), timestamp: 1 });
    const second = sm.appendMessage({ role: "user", content: "second ".repeat(100), timestamp: 2 });
    const items = makeActionItems(sm.getBranch(), sm.buildSessionProjection());
    const workspace = await prepareWorkspace(sm, items);
    try {
        const manifest = JSON.parse(await readFile(workspace.choicesPath, "utf8"));
        assert.equal(manifest.version, 2);
        assert.deepEqual(manifest.selectedIds, [first, second]);
        assert.deepEqual(manifest.choices, []);
        assert.equal((await validateWorkspace(sm, workspace)).entries.length, 2);
        await edit(workspace, records => records.map(record => record.id === first ?
            { ...record, message: { ...record.message, content: "short" } } : record));
        assert.equal((await validateWorkspace(sm, workspace)).entries[0].message.content, "short");
        await edit(workspace, records => records.filter(record => record.id !== second));
        assert.equal((await validateWorkspace(sm, workspace)).entries.length, 1);
        await edit(workspace, records => records.map(record => record.id === first ?
            { ...record, message: { ...record.message, timestamp: 999 } } : record));
        await assert.rejects(validateWorkspace(sm, workspace), /metadata and type/);
    } finally { await rm(workspace.directory, { recursive: true, force: true }); }
    const overrides = await prepareWorkspace(sm, items.map((item, index) =>
        ({ ...item, action: index === 0 ? "pick" : "remove" })));
    try {
        assert.deepEqual(overrides.manifest.choices.map(c => [c.id, c.action]),
            [[first, "pick"], [second, "remove"]]);
    } finally { await rm(overrides.directory, { recursive: true, force: true }); }
});

test("all-X extraction is empty, immutable outside descendants survive, and tampered P fails", async () => {
    const sm = SessionManager.inMemory(process.cwd());
    const ancestor = sm.appendMessage({ role: "user", content: "outside", timestamp: 1 });
    const selected = sm.appendMessage({ role: "user", content: "remove", timestamp: 2 });
    const originalLeaf = sm.getLeafId();
    sm.branch(ancestor);
    const sibling = sm.appendMessage({ role: "user", content: "sibling", timestamp: 3 });
    sm.branch(originalLeaf);
    const items = makeActionItems(sm.getBranch().slice(1), sm.buildSessionProjection()).map(item => ({ ...item, action: "remove" }));
    const workspace = await prepareWorkspace(sm, items);
    try {
        await edit(workspace, records => records.filter(record => record.id !== selected));
        const result = await validateWorkspace(sm, workspace);
        assert.deepEqual(result.entries, []);
        assert.ok(result.estimatedTokens < workspace.manifest.originalEstimatedTokens);
        assert.equal(sm.getLeafId(), originalLeaf);
        assert.equal(sm.getEntry(sibling).message.content, "sibling");
        await edit(workspace, records => records.map(record => record.id === sibling ? { ...record, message: { ...record.message, content: "tamper" } } : record));
        await assert.rejects(validateWorkspace(sm, workspace), /Outside-range/);
    } finally { await rm(workspace.directory, { recursive: true, force: true }); }

    const pickWorkspace = await prepareWorkspace(sm, items.map(item => ({ ...item, action: "pick" })));
    try {
        await edit(pickWorkspace, records => records.map(record => record.id === selected ? { ...record, message: { ...record.message, content: "not verbatim" } } : record));
        await assert.rejects(validateWorkspace(sm, pickWorkspace), /P\/locked payload/);
    } finally { await rm(pickWorkspace.directory, { recursive: true, force: true }); }
});

test("context-edited and compacted-away entries remain locked; insertions cannot cross P anchors", async () => {
    const sm = SessionManager.inMemory(process.cwd());
    const gone = sm.appendMessage({ role: "user", content: "old", timestamp: 1 });
    const kept = sm.appendMessage({ role: "user", content: "effective".repeat(30), timestamp: 2 });
    sm.appendContextEdit(kept, { content: "changed".repeat(30) });
    sm.appendCompaction("summary", kept, 100);
    const items = makeActionItems(sm.getBranch(), sm.buildSessionProjection());
    assert.equal(items.find(item => item.id === gone).protected, true);
    assert.equal(items.find(item => item.id === kept).protected, true);
    await assert.rejects(prepareWorkspace(sm, items.map(item => item.id === gone ? { ...item, action: "remove" } : item)), /Locked/);
    const workspace = await prepareWorkspace(sm, items);
    try {
        const candidate = await validateWorkspace(sm, workspace);
        assert.equal(candidate.entries.length, items.length);
        await edit(workspace, records => records.filter(record => record.id !== gone));
        await assert.rejects(validateWorkspace(sm, workspace), /P\/locked/);
    } finally { await rm(workspace.directory, { recursive: true, force: true }); }

    const insertionSm = SessionManager.inMemory(process.cwd());
    const left = insertionSm.appendMessage({ role: "user", content: "left ".repeat(100), timestamp: 1 });
    const anchor = insertionSm.appendMessage({ role: "user", content: "P", timestamp: 2 });
    const right = insertionSm.appendMessage({ role: "user", content: "right ".repeat(100), timestamp: 3 });
    const insertionItems = makeActionItems(insertionSm.getBranch(), insertionSm.buildSessionProjection())
        .map(item => item.id === anchor ? { ...item, action: "pick" } : item);
    const insertionWorkspace = await prepareWorkspace(insertionSm, insertionItems);
    try {
        await edit(insertionWorkspace, records => [
            ...records.map(record => record.id === right ? { ...record, parentId: "new-context" } : record),
            { type: "custom_message", id: "new-context", parentId: anchor, timestamp: new Date().toISOString(),
                customType: "treebase.context", display: true, content: "concise",
                details: { treebaseSources: [left, right], treebaseAfter: right } },
        ]);
        await assert.rejects(validateWorkspace(insertionSm, insertionWorkspace), /cannot cross a P/);
        // The same slot with only right-side M provenance is valid even when
        // the source was deleted; extraction must not rely on mutable lines.
        const originalRecords = (await readFile(insertionWorkspace.originalPath, "utf8")).trim().split("\n").map(JSON.parse);
        await writeFile(insertionWorkspace.contextPath, [
            ...originalRecords.filter(record => record.id !== right),
            { type: "custom_message", id: "replacement", parentId: anchor, timestamp: new Date().toISOString(),
                customType: "treebase.context", display: true, content: "concise",
                details: { treebaseSources: [right], treebaseAfter: right } },
        ].map(JSON.stringify).join("\n") + "\n");
        const validated = await validateWorkspace(insertionSm, insertionWorkspace);
        assert.deepEqual(validated.entries.map(entry => entry.id), [left, anchor, "replacement"]);
    } finally { await rm(insertionWorkspace.directory, { recursive: true, force: true }); }
});
