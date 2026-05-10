# Token budget notes

Treebase has local token-estimation helpers in `extensions/treebase/summarize.ts`, but they are not currently an accurate or enforced budget.

## Current issues

- `prepareBranchEntries()` accepts a `tokenBudget` and returns `totalTokens`, but summary-message building calls it with the default `tokenBudget = 0`, so no local budget is actually enforced.
- The returned `totalTokens` is not used to decide whether to truncate, drop, warn, or split summarizer input.
- The estimate is incomplete for the current summarizer prompt shape. In particular, retained tool-use candidate blocks are serialized separately as `<tool-use-retention-candidate>` XML containing tool call and tool result content, but that serialized content is not included in `prepareBranchEntries()` / `estimateTokens()` accounting.
- `prepareBranchEntries()` also skips `toolResult` entries through `getMessageFromEntry()`, so tool result content is generally not represented in the existing local estimate even though retained candidates can include full tool results in the actual prompt.
- Therefore actual model context usage can be much larger than the local estimate suggests.

## Future improvement

Fix local budgeting so it accounts for the exact summarizer message that will be sent, including retained tool-use candidate XML and full retained tool results. Then use that accounting to enforce a real budget or at least warn/fail before sending an oversized summarizer request.
