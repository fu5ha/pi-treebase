# From `/tree` to `/treebase`

_pi package design note_

A concise map of how pi’s built-in session tree navigation works today, and a practical route to build an interactive-rebase-style extension on top of the same ideas.

## How `/tree` currently works

1. **Open selector** — Interactive mode calls `showTreeSelector()`, reads `sessionManager.getTree()` and current leaf ID.
2. **Render tree** — `TreeSelectorComponent` flattens the entry tree, highlights active path nodes, supports search/fold/filter/labels.
3. **Choose entry** — Enter selects an entry; selecting the current leaf is a no-op.
4. **Optional summary** — User chooses no summary, default branch summary, or custom summary prompt.
5. **Navigate** — `AgentSession.navigateTree()` moves the leaf, optionally inserting a `branch_summary`.

## Core data model

- Sessions are JSONL trees. Entries have `id` and `parentId`.
- The current position is the session _leaf_.
- `getBranch(id)` walks root → selected entry.
- `buildSessionContext()` converts the active path into LLM messages.
- `branch(id)`, `resetLeaf()`, and `branchWithSummary()` rewrite only the current leaf, not history.

## Important implementation files

- `dist/modes/interactive/components/tree-selector.js` — tree UI.
- `dist/modes/interactive/interactive-mode.js` — `showTreeSelector()` command flow.
- `dist/core/agent-session.js` — `navigateTree()`.
- `dist/core/compaction/branch-summarization.js` — branch summary collection/generation.
- `dist/core/session-manager.js` — tree and leaf mutation APIs.

## What `/treebase` should reuse vs. replace

### Reuse

- The tree selector behavior: flattening, filtering, active-path marker, labels, keyboard affordances.
- Session APIs: `getTree()`, `getBranch()`, `getEntry()`, `branchWithSummary()`, `collectEntriesForBranchSummary`.
- Branch summary hooks/patterns: model call, abort loader, extension-safe command handler.

### Replace

- The single “summarize branch?” prompt becomes an editable action list.

## Action semantics

- `pick` (`P`): copy original entries into the rewritten context.
- `sumarize-high` (`H`): detailed summary preserving goals, decisions, file paths, etc based on the native summarization prompt.
- `summarize-low` (`L`): short summary, enough to preserve chronology but not details.
- `drop` (`D`): omit entirely; disallow invalid partial drops unless the turn is expanded.

## Proposed `/treebase` flow

1. Register an extension command `treebase`.
2. Wait until idle with `ctx.waitForIdle()`.
3. Show a copied/adapted `TreeSelectorComponent` to pick the target entry. Avoid importing internal `dist/...` paths in a package; copy the code or rebuild with public TUI components.
4. Compute a chronolocial, flat list from the current leaf to target. Use existing `collectEntriesForBranchSummary` to do this if possible.
5. Show an action editor with options in a gutter to the left of each flattened node: `pick` (`P`), `sumarize-high` (`H`), `summarize-low` (`L`), `drop` (`D`).
6. Apply whole-turn defaults: a user message, assistant response, tool calls, and tool results move together unless expanded.
7. Omit `drop` nodes
8. Create a marked-up version of the remaining history, wrapping groups of nodes in semantic html-like tags of their priority (keep/summarize-low/summarize-high) and feed it to summarizer with an expected output format that will allow extraction of summary groups that can be interleaved with explicitly `pick`-ed nodes
9. Fork and add a new synthetic branch with synthetic result: insert chronologically all `pick`ed nodes interleaved with the extracted summary entries

## Implementation plan for this package

1. Create `package.json` with `keywords:["pi-package"]` and `pi.extensions:["./extensions"]`.
2. Create `extensions/treebase/index.ts` registering `/treebase`.
3. Port the tree selector into `extensions/treebase/tree-selector.ts`, changing callbacks to return the selected ID.
4. Add `action-list.ts`: custom TUI component using arrows, Enter/cycle, Space, Escape, and confirmation.
5. Add `tree-utils.ts`: path/LCA/turn grouping utilities.
6. Add `summarize.ts`: summarization using the algorithm detailed in step 8 above and include abort handling.


> **Key caution:** pi exposes `ctx.navigateTree()`, but not a public “append arbitrary message at arbitrary parent” API from command contexts. For the initial version, do a hacky cast from ReadOnlySessionManager to regular SessionManager with write ability.

