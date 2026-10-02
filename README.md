# pi-treebase

Controlled, interactive context rewriting for pi 1.0, inspired by interactive
git rebase. The original branch remains available.

## Installation

```bash
pi install npm:@grayolson/pi-treebase
```

## Workflow

1. Run `/pi-treebase` (`/treebase` is an alias).
2. In the native tree view, select an entry in the current branch. Unrelated
   branches are rejected; the selected entry is included in the rewrite.
3. Classify the range through the current leaf:
   - **P — Pick:** keep the payload verbatim, in order.
   - **M — Model choice (default):** let the current agent retain, rewrite,
     consolidate, or remove it.
   - **X — Remove:** exclude it from the resulting branch.

   System/state records, structural reference targets, and inactive raw history
   are locked and preserved automatically. Group navigation and tool dependency
   checks prevent contradictory P/X selections. Shift+Enter saves a raw/projected
   context preview and cancels selection.
4. The current agent edits a duplicate JSONL using its existing context and
   normal tools on a temporary branch. It receives schemas, a choices manifest,
   and editing instructions. No separate agent or restricted sandbox is used.
5. When notified that validation succeeded, run `/pi-treebase apply`.
   This revalidates the files and creates/activates a fresh branch in the same
   session. Editing prompts and tool activity do not enter the final context.

Final activation requires an idle command because pi's settled lifecycle event
is notification-only. Interrupted or invalid runs are not applied. Use
`/pi-treebase resume` to continue/repair, or `/pi-treebase cancel` to return to the
original branch. Reloaded operations recover from persisted state but require
`resume` to confirm a fresh settled editing run before activation; applying a
committed operation again is rejected.

## Artifacts and validation

The notified workspace directory retains `original.jsonl`, `context.jsonl`,
`session.schema.json`, `choices.json`, `choices.schema.json`, `instructions.md`,
and the completion signal `ready.json`. Retention is intentional, including on
failure/cancellation; delete these directories manually when no longer needed.
X is **not** a confidentiality boundary: originals, backups and the working
agent's context still contain that material.

Record IDs and M-source provenance identify replacements, not mutable line
numbers. New synthesized context uses custom messages; instructions define the
permitted insertion slots around P anchors. Outside-range records and unrelated
branches cannot change. Validation checks preserved payloads, references, tool
pairing, native projection and reconstruction before activating anything.
Effective-context token size is estimated, not inferred from JSONL file size.
The workspace records its fit/shrink acceptance policy.

## Limitations

Ancestor-only rewriting is supported. Structural records and reference targets
are intentionally conservative: they must survive, so existing compaction and
context-edit effects cannot accidentally reactivate old context. Unsupported
message shapes or checkpoints that pi's public APIs cannot reproduce fail
explicitly. Extension-private ID references inside opaque data/details are not
remapped automatically.

Commands narrow pi's read-only session-manager view to its actual writable
`SessionManager`. Reconstruction uses public append APIs and native navigation;
failed activation can leave abandoned append-only reconstruction entries, but
never intentionally activates an incomplete candidate.
