# pi-treebase

Controlled, interactive context rewriting for pi 1.0, inspired by interactive
git rebase. The original branch remains available.

## Installation

```bash
pi install npm:@grayolson/pi-treebase
```

## Workflow

1. Run `/treebase`.
2. In the native tree view, select an entry in the current branch. Unrelated
   branches are rejected; the selected entry is included in the rewrite.
3. Classify the range through the current leaf:
   - **P — Pick:** keep the payload verbatim, in order.
   - **M — Model choice (default):** let the current agent retain, rewrite,
     consolidate, or remove it.
   - **X — Remove:** exclude it from the resulting branch.

   System/state records, structural reference targets, and inactive raw history
   are shown as **L — Locked** in a distinct color and preserved automatically.
   Locks extend only to actual tool-call/result dependencies, not the whole turn.
   Group navigation and tool dependency
   checks prevent contradictory P/X selections. Changing a final assistant
   response affects only that response; contiguous tool/intermediate messages
   stay grouped.
   System/bookkeeping and standalone records separate action groups; changing a
   group does not affect other groups across those boundaries. Tool dependencies
   across boundaries are checked rather than silently changing surrounding groups.
   Shift+Enter saves a raw/projected
   context preview and cancels selection.
4. The current agent edits ordered branch JSONL using its existing context and
   normal tools on a temporary branch. It receives schemas, a choices manifest,
   and editing instructions. No separate agent or restricted sandbox is used.
5. After successful settlement, treebase automatically attempts to apply the
   result from a deferred idle command context. It revalidates the files and
   creates/activates a fresh branch in the same session. Editing prompts and
   tool activity do not enter the final context.

Final activation is deferred outside pi's notification-only settled lifecycle
event until the command context is idle; there is no manual apply subcommand.
Interrupted or invalid runs are not applied. Use `/treebase resume` to
continue/repair, or `/treebase cancel` to return to the original branch. Reloaded
operations recover from persisted state but require `/treebase resume` to
confirm a fresh settled editing run before automatic activation; applying a
committed operation again is rejected.

## Artifacts and validation

The notified workspace directory retains `original.jsonl`, `context.jsonl`,
`context.schema.json`, `choices.json`, `choices.schema.json`, `instructions.md`,
and the completion signal `ready.json`. Retention is intentional, including on
failure/cancellation; delete these directories manually when no longer needed.
X is **not** a confidentiality boundary: originals, backups and the working
agent's context still contain that material.

The editable file contains only the current branch, one editing record per line,
in ancestor order. Line order determines parent relationships; treebase restores
native session metadata from the immutable snapshot. The pre-selection prefix
is read-only. No session header, parent links, or unrelated branches need editing.
`choices.json` lists only P/X overrides; unlisted selected IDs imply M.
Source-backed M records can be edited, removed, or reordered within P/locked
anchor boundaries. New synthesized context becomes a displayed custom message
with explicit M-source provenance.

Tool-result excerpts select inclusive, 1-based line ranges from original text
blocks. Treebase extracts those ranges itself, adds omission markers, and retains
the full original tool-call input, result identity/error status, and provenance.
Paraphrases belong in synthesized context, not purported verbatim excerpts.
Non-text result blocks remain unchanged; excerpt ranges select text only.
Multi-call envelopes still require a matching result for every call.

For example, an edited file can contain:

```jsonl
{"source":"original-call-id"}
{"kind":"tool-excerpt","callSource":"original-call-id","resultSource":"original-result-id","keep":[{"block":0,"startLine":42,"endLine":57}]}
{"kind":"context","sources":["original-user-id"],"content":"Useful facts to retain"}
```

`block` is a zero-based original content-block index. Keep the call's source line
separately; an excerpt replaces only its result, not its input envelope. Source
lines without an editable field retain the exact original payload. Read-only
source payloads can be inspected in `original.jsonl`; detailed editing rules and
the available `content`/`output`/`summary` fields are in `instructions.md`.

Validation checks preserved payloads, references, tool pairing, native projection
and reconstruction before activating anything.
Effective-context token size is estimated, not inferred from JSONL file size.
The workspace records its fit/shrink acceptance policy.

Workspace formats are not versioned and have no compatibility readers. Finish or
cancel pending operations before updating to a changed format; old workspaces
cannot be resumed, but retained snapshots remain available for recovery.

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
