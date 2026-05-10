# Auto Tool Call Retention Plan

## High-level outline

- During treebase rewrite construction, inspect entries marked `summarize-high` for assistant tool calls and matching tool results.
- Build one retention candidate per matched tool call/result pair, keyed by the actual tool call's session entry id.
- Before the normal summarization pass, ask the selected model which high-importance tool uses remain useful enough to preserve verbatim.
- Present candidates to the ranking model as XML-like `<tool-use-candidate id="...">` blocks, not raw JSON, so code/output/diffs remain readable.
- Include surrounding conversation context before/between/after candidates in `<conversation-context>` blocks so the model can judge continued usefulness relative to user goals, assistant reasoning, and later work. This should function similarly to how the `<picked-verbatim>` works in the summarization pass. The whole message should be the whole chronologically ordered conversation being rewritten
- Require the ranking model to return machine-parseable JSON containing only retained tool use IDs.
- Treat retained tool call/result entries as auto-picked verbatim context:
  - duplicate them fully into the synthesized branch;
  - treat them like picked-verbatim context for summarization;
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
          priority: "combined";
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
function buildToolRetentionUserMessage(
    items: ActionItem[],
    candidates: ToolRetentionCandidate[],
): string;
```

Example ranking input shape:

```xml
<conversation-context>
[user/assistant conversation]
</conversation-context>

<tool-use-candidate id="toolu_123">
<tool-call>
read(path="extensions/treebase/summarize.ts")
</tool-call>
<tool-result>
...tool result content/code/output...
</tool-result>
</tool-use-candidate>

<tool-use-candidate id="toolu_321">
<tool-call>
read(path="extensions/treebase/summarize.ts")
</tool-call>
<tool-result>
...tool result content/code/output...
</tool-result>
</tool-use-candidate>

<conversation-context>
[user/assistant conversation]
</conversation-context>

<tool-use-candidate id="toolu_58293">
<tool-call>
read(path="extensions/treebase/summarize.ts")
</tool-call>
<tool-result>
...tool result content/code/output...
</tool-result>
</tool-use-candidate>

<conversation-context>
[user/assistant conversation]
</conversation-context>
```

Ranking output shape:

```json
{"keepToolUseIds":["toolu_123"]}
```

```ts
async function rankHighToolRetentionCandidates(
    ctx: ExtensionCommandContext,
    items: ActionItem[],
    candidates: ToolRetentionCandidate[],
    signal?: AbortSignal,
): Promise<Set<string>>;
```

```ts
export function buildSummarizerUserMessage(
    items: ActionItem[],
    options?: {
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

## Integration sketch

```ts
const candidates = findHighToolRetentionCandidates(items);
const keptToolUseIds = await rankHighToolRetentionCandidates(
    ctx,
    items,
    candidates,
    loader.signal,
);

const retainedEntryIds = new Set<string>();
for (const candidate of candidates) {
    if (!keptToolUseIds.has(candidate.toolCallId)) continue;
    retainedEntryIds.add(candidate.assistantItem.id);
    retainedEntryIds.add(candidate.resultItem.id);
}

const summarizerBody = buildSummarizerUserMessage(items, {
    verbatimIds: retainedEntryIds,
});
```

When assembling `RewritePart[]`, emit retained entries in original order as `auto-pick` parts and skip them when emitting summary groups.
