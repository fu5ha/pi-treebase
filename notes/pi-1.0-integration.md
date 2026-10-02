# pi 1.0 integration boundary

## Phase 1 implementation

- Development and peer dependencies target the coordinated 1.0.0 release exactly.
  Node minimum follows pi: 22.19.0. The lockfile records the inspected baseline.
- Native exported `TreeSelectorComponent` owns search, filters, folding, labels,
  focus and theme handling. The host's injected keybindings are scoped around its
  synchronous operations with public TUI APIs. Both screens require `mode: "tui"`.
- Classification shows raw history, including state-only records. System rows
  describe replacement, sections and tool changes without printing prompt bodies.
  Structural records, inactive raw context, and reference targets are P-only.
  State records do not sever assistant/tool action groups.
- Model input and its debug preview use `buildSessionProjection()` by source ID,
  including context-edit replacements/omissions and compaction. Picked entries
  still copy raw history. Native conversion and serialization replace vendored code.
- `BranchWriter` explicitly handles every 1.0 entry type. Unknown augmented
  message roles remain protected in the UI but fail preflight when there is no
  typed public append API. There are no private writes or live-file edits.
- Compaction kept IDs, self-ID retain-none boundaries, context-edit targets and
  labels are remapped. A copied checkpoint must match what public
  `appendCompaction` would regenerate; mismatches fail before live mutation.
- Picked summaries use public `branchWithSummary`, temporarily selecting their
  provenance leaf before appending at the desired parent. Generated summaries
  have `fromHook: true`; treebase explicitly carries file lists from both native
  and extension summaries and nested tool-call metadata.
- Summarization usage is appended once as a model-attributed `usage` record.
  Picked records retain their original usage. Pi counts *all raw history*, so
  copied usage increases the native all-history totals; it is not a new bill.
  Opaque extension `data`/`details` are cloned, not recursively rewritten:
  extensions with private ID references need their own remapping contract.
- A state-only `treebase.activation` anchor permits native navigation to refresh
  finalized context and active tools even for user/custom leaves or an empty
  result. No synthetic user draft is needed. The anchor is not model context.
  The original branch survives. A cancelled/failed activation restores its leaf;
  append-only abandoned reconstruction entries can remain in the tree.

## Public API limitations

1. Commands expose a read-only session manager. The adapter validates that the
   actual object is a `SessionManager` and narrows it in one location. A public
   command-scoped branch mutation API would remove this assumption.
2. `appendCompaction` regenerates the system checkpoint; it cannot accept a
   supplied checkpoint. Reconstruction works when the protected transcript
   recreates it. An explicit checkpoint append API is needed for arbitrary
   imported or rewritten checkpoints.
3. `appendSessionInfo(name: string)` cannot express legacy records with no name.
   Such records fail explicitly rather than being replaced with an empty string.
4. There is no arbitrary augmented-role append API or provenance-aware usage
   exclusion for copied records. Exact new IDs/timestamps are not caller-supplied.
5. Native `TreeSelectorComponent` has constructor-only height. Width changes,
   narrow rendering and invalidation use public APIs; changing viewport height
   while preserving search/fold/filter/label-editor state needs an upstream setter.

## Phase 2: agent-edited temporary branch

This is a same-session branch workflow, not a separate session file:

1. In a command, await `waitForIdle`, save original leaf/session identity, append
   a temporary branch's context and a state-only anchor, and `navigateTree` there.
   Moving the manager leaf alone does not refresh the running agent's tools.
2. Only after native activation should the command enqueue the editing prompt.
   Persist branch identity and progress in custom state records; reject stale
   completions after session replacement or reload.
3. `turn_end` and `agent_before_settle` can commit the documented boundary drafts
   (`custom`, `custom_message`, `context_edit`, `compaction`). They do not provide
   arbitrary message/model/system entry drafts or command-only navigation.
   `agent_end` is not final: retries, recovery, compaction and queued work can follow.
   `agent_settled` is final but notification-only.
4. Completion should record readiness at an actionable boundary, then notify the
   user at settlement. Final activation must happen from a fresh command context
   after `waitForIdle`, not by calling `navigateTree`/`waitForIdle` from a lifecycle
   hook. Those command-only calls can deadlock inside the run they await.
5. Idle command-scoped writable manager methods can append ordinary system,
   user, assistant, tool-result, bash and custom messages plus structural records.
   Exact arbitrary checkpoint/augmented-role commits have the gaps above.
   An upstream idle command-dispatch or transactional same-session branch API is
   needed for fully automatic, safe hook-to-activation handoff without a second
   user command. Do not silently substitute a separate session.

## Phase 2 implementation

- `/pi-treebase` and `/treebase` now classify with P/M/X. Unrelated tree
  destinations are rejected, not navigated to. Locked rows distinguish state,
  inactive raw history and structural reference targets.
- The workspace serializes the live manager before editing, including in-memory
  sessions. Snapshot and manifest hashes are checked on every validation.
  Extraction uses stable source IDs and explicit M insertion provenance;
  synthesized custom messages cannot cross ordered P/locked anchors.
- The same current agent receives a normal user prompt after native temporary
  branch activation. `ready.json` is an explicit completion request, not
  authorization to activate. A completed actionable boundary validates it and
  persists readiness; at most two repair continuations are requested.
- `agent_settled` only notifies and records an in-memory confirmation. Applying
  requires `/pi-treebase apply`, idle state, matching working ancestry, settlement
  confirmation, and fresh validation. After reload, `/pi-treebase resume` must
  produce a fresh settled run: persisted pre-settlement readiness alone is unsafe.
- Final reconstruction is preflighted on a detached manager and uses public
  append APIs plus native navigation. A session-wide committed receipt prevents
  duplicate application after revisiting the temporary branch. State-only
  provenance/activation records do not contribute model context.
- Effective model-context tokens use pi's estimator after native projection and
  conversion. Acceptance requires no estimated growth and, when known, a fit
  within 90% of the active model context window. This is not an exact provider
  token count or semantic proof that X facts cannot recur in new text.
- H/L grouping, importance prompts, separate summarizer calls and automatic
  tool-use retention have been removed.

## Verification

Executed against installed pi 1.0.0:

- `npm run typecheck`.
- One focused `npm test` regression: kept-boundary and context-edit ID remapping,
  prompt/tool checkpoint preservation, raw original-branch survival, native
  subsequent retain-none compaction, copied self-boundary, and persisted reload.
- Isolated SDK navigation smoke exercise: state-only anchor activation at a user
  leaf, custom-message leaf and empty result; finalized message/tool refresh and
  original entry survival. No model request or credentials were needed.
- `npm audit --omit=dev`: no vulnerabilities. Full development audit reports an
  upstream transitive `brace-expansion` advisory in pi's dependency tree.

Phase 2 verification also ran `npm run typecheck` and four focused tests: the
existing checkpoint/reload regression, aborted/unsettled readiness and duplicate
commit handling, empty X extraction/outside invariants/P tampering, and locked
context-edit/compaction effects plus accepted/rejected provenance insertions.
Lifecycle tests exercise the actual handlers with command/navigation doubles;
the Phase 1 native navigation smoke remains the integration evidence.

Not exercised here: actual terminal P/M/X interaction, a live current-agent
editing run, visual cancellation/search/folding, theme switching and terminal resize.
Those require an interactive pi session and should be checked before release;
the SDK smoke is not a substitute for that manual acceptance pass.
