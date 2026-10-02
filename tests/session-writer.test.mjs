import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { BranchWriter } from "../extensions/treebase/session-writer.ts";

test("rewritten compaction remaps kept/edit boundaries and survives reload and retain-none compaction", () => {
    const directory = mkdtempSync(join(tmpdir(), "treebase-checkpoint-"));
    try {
        const sm = SessionManager.create(directory, directory);
        sm.appendMessage({
            role: "system", content: "", replace: true, sections: { policy: "initial" },
            toolsAdded: [{ name: "read", description: "Read", parameters: { type: "object" } }],
            timestamp: 1,
        });
        sm.appendMessage({ role: "user", content: "older", timestamp: 2 });
        const kept = sm.appendMessage({ role: "user", content: "raw", timestamp: 3 });
        sm.appendMessage({
            role: "system", content: "", sections: { policy: "updated" },
            toolsRemoved: [{ name: "read" }], timestamp: 4,
        });
        sm.appendContextEdit(kept, { content: "effective" });
        const compact = sm.appendCompaction("summary", kept, 100);
        const originalLeaf = sm.getLeafId();
        const originalPath = sm.getBranch();
        const effective = sm.buildSessionProjection().messages;
        sm.resetLeaf();
        const writer = new BranchWriter(sm);
        for (const entry of originalPath) writer.append(entry);
        const clonedCompaction = sm.getEntry(writer.ids.get(compact));
        assert.equal(clonedCompaction.firstKeptEntryId, writer.ids.get(kept));
        const edit = sm.getBranch().find(entry => entry.type === "context_edit");
        assert.equal(edit.targetId, writer.ids.get(kept));
        const normalize = messages => messages.map(message => ({ ...message, timestamp: 0 }));
        assert.deepEqual(normalize(sm.buildSessionProjection().messages), normalize(effective));
        assert.equal(sm.getEntry(kept).message.content, "raw");
        assert.equal(sm.getBranch(originalLeaf).at(-1).id, originalLeaf);

        // Native subsequent compaction snapshots rewritten effective prompt/tools
        // and uses its own new ID for a retain-none boundary.
        const none = sm.appendCompaction("retain none", null, 50);
        const noneEntry = sm.getEntry(none);
        assert.equal(noneEntry.firstKeptEntryId, none);
        assert.equal(getCurrentSystemMessage(sm.buildSessionProjection().messages).sections.policy, "updated");
        const writer2 = new BranchWriter(sm);
        writer2.append(noneEntry);
        assert.equal(sm.getLeafEntry().firstKeptEntryId, sm.getLeafId());
        const reloaded = SessionManager.open(sm.getSessionFile());
        assert.deepEqual(reloaded.buildSessionProjection().messages, sm.buildSessionProjection().messages);
        assert.equal(reloaded.getBranch(originalLeaf).at(-1).id, originalLeaf);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
