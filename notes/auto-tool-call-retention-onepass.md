# Auto Tool Call Retention One-pass Plan

## High-level outline

- During treebase rewrite construction, inspect entries marked `summarize-high` for assistant tool calls and matching tool results.
- Build one retention candidate per matched tool call/result pair, keyed by the actual tool call's session entry id.
- Do **not** make a separate ranking model call. Instead, inject candidates directly into the normal summarizer user message.
- Present candidates to the summarizer as XML-like `<tool-use-retention-candidate id="...">` blocks, not raw JSON, so code/output/diffs remain readable.
- Include the candidate blocks inline in the same chronological conversation stream used for summarization, surrounded by the same context that the summarizer already receives.
- Instruct the summarizer to add a machine-parseable retained-candidate list to its normal summary output.
- The summarizer should both:
  - produce the usual summaries for summary groups; and
  - return the tool use IDs that should be preserved verbatim.
- Treat retained tool call/result entries as auto-picked verbatim context when constructing the final synthesized branch:
  - duplicate them fully into the synthesized branch;
  - treat them like picked-verbatim context for any emitted summaries;
  - emit the resulting summary after the retained entries.
- Keep this distinct from explicit user `pick` actions by representing retained entries as `auto-pick` rewrite parts.

## Important types and signatures sketch

```ts
type ToolRetentionCandidate = {
    /** Actual tool call id from the assistant toolCall block and toolResult.toolCallId. */
    toolCallId: string;
    assistantItem: ActionItem;
    resultItem: ActionItem;
    toolName: string;
    preview: string;
};
```

```ts
export type RewritePart =
    | { kind: "pick"; item: ActionItem }
    | { kind: "auto-pick"; items: ActionItem[] }
    | {
          kind: "summary";
          text: string;
          sourceIds: string[];
          readFiles: string[];
          modifiedFiles: string[];
      };
```

```ts
function findHighToolRetentionCandidates(
    items: ActionItem[],
): ToolRetentionCandidate[];
```

```ts
export function buildSummarizerUserMessage(
    items: ActionItem[],
    options?: {
        /** Retention candidates to inject inline for one-pass summarization + retention. */
        toolRetentionCandidates?: ToolRetentionCandidate[];
        /** Entry ids to treat as verbatim context and exclude from summary groups. */
        verbatimIds?: Set<string>;
    },
): string;
```

```ts
function groupSummaries(
    items: ActionItem[],
    excludedIds?: Set<string>,
): Array<{ id: string; items: ActionItem[] }>;
```

## One-pass summarizer input shape

The summarizer input remains the chronologically ordered conversation being rewritten. Where a high-importance tool call/result pair is eligible for retention, replace or annotate the normal representation with a `<tool-use-retention-candidate>` block:

```xml
<tool-use-retention-candidate id="toolu_123">
<tool-call>
read(path="extensions/treebase/summarize.ts")
</tool-call>
<tool-result>
...tool result content/code/output...
</tool-result>
</tool-use-retention-candidate>
```

The summarizer instructions should say:

- Consider each `<tool-use-retention-candidate>` for verbatim retention.
- Keep candidates only when the exact tool call/result content is likely to remain useful in the rewritten history, such as important file contents, diffs, command output, diagnostics, or error messages that later reasoning depends on.
- Do not keep candidates merely because they occurred; prefer summaries unless verbatim detail matters.
- Still summarize the relevant history normally.
- Add a top-level retained tool use candidate list to the output.

## One-pass summarizer output shape

The summarizer response should include both the normal summary payload and retained tool IDs. For example:

```json
{
    "summary_groups":[{"id":"g1","summary":"..."}],
    "keep_tool_use_ids": ["toolu_123"]
}
```

`keep_tool_use_ids` is the machine-parseable list of `<tool-use-retention-candidate>` IDs to preserve verbatim.

## Integration sketch matching the current flow

Keep the integration centered on the existing `buildRewrite(ctx, items)` pipeline in `extensions/treebase/summarize.ts` and the existing application step in `extensions/treebase/index.ts`.

High-level flow:

1. `/treebase` computes the linear segment with `entriesBetweenAncestorAndLeaf(...)`, converts it to `ActionItem[]` with `makeActionItems(...)`, and lets the user edit actions in `showActionList(...)`.
2. `buildRewrite(ctx, edited)` remains the only place that calls the model.
3. At the start of `buildRewrite`, after `const groups = groupSummaries(items)`, find retention candidates from the same `items` list:
   - only consider items whose action is `summarize-high`;
   - match assistant `toolCall` blocks to later `toolResult` entries by `toolCallId`;
   - keep enough metadata to map a kept candidate back to the two original `ActionItem`s.
4. `buildSummarizerUserMessage(items, ...)` continues to emit the existing top-level sequence of:
   - `<picked-verbatim-group>` for consecutive `pick` items; and
   - `<summary-group id="gN">` for consecutive non-picked summary items.
5. When serializing high-importance summary content, inject matched tool uses as inline `<tool-use-retention-candidate id="...">` blocks inside the relevant `<importance level="high">` section instead of relying on the normal assistant-tool-call-only serialization, because current `getMessageFromEntry(...)` intentionally drops `toolResult` messages.
6. Update `SYSTEM_PROMPT` so the single JSON result includes both existing summaries and retention choices:

```json
{"summary_groups":[{"id":"g1","summary":"..."}],"keep_tool_use_ids":["toolu_123"]}
```

7. In `buildRewrite`, parse `keep_tool_use_ids` next to `summary_groups`, then map kept tool IDs back to retained entry IDs.
8. When building `RewritePart[]`, keep the current chronological pass over `items`, but add a branch before normal summary emission:
   - `pick` still becomes `{ kind: "pick", item }`;
   - retained assistant/tool-result items become `{ kind: "auto-pick", items: [...] }` or equivalent retained-entry parts;
   - summary groups are still emitted once per `groupSummaries(...)` group, using the summaries returned by the model.
9. In `applyRewrite(...)`, handle `auto-pick` the same way as explicit picks for cloning entries, but keep it as a separate `RewritePart` kind so the distinction is preserved in code and future metadata.

## Notes

- Because current summarization deliberately omits `toolResult` entries from ordinary conversation serialization, retained candidates need explicit block serialization of both the call and result.
