# pi-treebase

A guided application of [context-language-models](https://github.com/facebookresearch/context-language-models/tree/main/clm/clm_harness) inspired by interactive git rebase.

## Installation

```bash
pi install npm:@grayolson/pi-treebase
```

## Workflow

1. Run `/treebase`.
2. In the native tree view, select an entry in the current branch. Everything between the current entry and the selected entry will be part of the context rewrite operation.
3. Classify the selected range:
   - **P — Pick:** keep verbatim, in order.
   - **M — Model choice (default):** let the current agent retain, rewrite,
     consolidate, or remove it.
   - **X — Remove:** exclude it from the resulting branch.

   System/state records, structural reference targets, and inactive raw history
   are shown as **L — Locked** and preserved automatically.
4. A linear history from root to current leaf is generated in a minimal JSONL format.
5. The current agent edits this new branch JSONL using its existing context and
   normal tools on a temporary branch. It receives schemas, sparse choices,
   and editing instructions. No separate agent or restricted sandbox is used.
6. After successful settlement, treebase automatically attempts to apply the
   result from a deferred idle command context. It revalidates the files and
   creates/activates a fresh branch in the same session. Editing prompts and
   tool activity do not enter the final context.

Interrupted or invalid runs are not applied. Use `/treebase resume` to
continue/repair, or `/treebase cancel` to return to the original branch.

## Automatic full-branch rewrite

Run `/treebase-auto "prompt"` to rewrite the current branch from its root to
the current leaf without the tree selector or P/M/X picker. All editable
entries default to model choice; locked entries remain preserved.
This command also works outside TUI mode (for example, in T3 Code), as do
`/treebase resume` and `/treebase cancel`. Interactive `/treebase` requires TUI mode.

The prompt gives the editing LLM user context about how the session will
continue, helping it decide what to retain or consolidate. It is guidance for
the rewrite, not a task to execute during editing. The same validation,
automatic activation, and resume/cancel workflow applies, and `/treebase resume`
retains this guidance.
