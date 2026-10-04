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
