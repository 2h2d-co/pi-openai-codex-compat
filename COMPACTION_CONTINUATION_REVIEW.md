# Compaction Continuation Incident Review

- Date: 2026-08-15
- Status: Root fix, regression coverage, diagnostics, and a 95% provider-boundary threshold implemented; recovery fallback skipped

## Dictionary

- **Pi-triggered remote compaction**: Pi decides that compaction is needed, then this extension handles `session_before_compact` and obtains a native OpenAI Codex checkpoint.
- **Provider-boundary percentage compaction**: This extension compacts inside `CodexProviderRuntime` immediately before a provider request when `autoCompactAtPercent` is configured.
- **Provider subrequest**: One OpenAI request made internally by the extension while producing one Pi assistant response. The extension may make multiple subrequests for response continuation or retry.
- **Threshold compaction**: Proactive Pi compaction after an agent run. Pi intentionally sets `willRetry: false`.
- **Overflow compaction**: Pi recovery after a recognized context-overflow or recoverable length response. Pi sets `willRetry: true` and continues the interrupted run.
- **Logical compaction**: One distinct compaction entry after de-duplicating entries copied into forked session files by entry ID and timestamp.

## Conclusion

The seven-day window contained exactly **four distinct matching stalls**. All had the same failure shape:

1. Codex emitted one or more tool calls at the effective context/output ceiling.
2. The extension made another provider subrequest after appending response items, but without a tool output for that call.
3. OpenAI rejected the subrequest with `No tool output found for function call ...` or `No tool output found for custom tool call ...`.
4. Pi did not classify that error as retryable or as context overflow.
5. Pi then performed a successful **threshold** compaction with `willRetry: false`, as designed.
6. The agent settled until Kaan restarted the work.

Three incidents were followed directly by `please continue`. In the fourth, the same logical session was resumed through a fork about 66 minutes later with `what's the issue`, followed by `ok, please proceed`.

The checkpoint compaction itself did not fail and was not the component that dropped a continuation. The run had already ended on a non-retryable provider error. Compaction was the last visible automatic action, which made the symptom look like a compaction continuation failure.

Pi 0.84.2 does **not** solve any of the four incidents. Its OpenAI `end_turn` change only preserves the value on `AssistantMessage` for diagnostics and explicitly does not affect control flow.

## Audit Scope

### Time window

The audit used entry timestamps, not file creation times or modification times:

```text
2026-08-08T20:23:24Z through 2026-08-15T20:23:24Z
```

Using entry timestamps includes sessions created before the window but still active during it.

### Coverage

- 64 session files contained entries in the window.
- Every JSONL line parsed successfully.
- 47 physical extension-provided native-compaction records were found in 10 session files.
- Forked sessions copy prior JSONL entries. De-duplicating by entry ID and timestamp reduced the 47 physical records to 40 logical compactions.
- 62 physical assistant-error records represented 54 distinct errors after de-duplication. Exactly 4 distinct errors used missing-tool-output wording; no other missing-result variant was found.
- 58 physical user-message records matched a broad continuation-language search, representing 44 distinct messages after the same de-duplication. Manual branch review reduced these to 4 relevant stall branches.

Session inventory by working directory:

| Working directory                                              | Sessions checked |
| -------------------------------------------------------------- | ---------------: |
| `/Users/kaan/dev/2h2d-co/pi-openai-codex-compat`               |               23 |
| `/Users/kaan/dev/2h2d-co`                                      |               13 |
| `/Users/kaan/dev/deltatre`                                     |                9 |
| `/Users/kaan/.pi/agent`                                        |                5 |
| `/Users/kaan/dev/personal-repositories/soc/sai-backend/main`   |                5 |
| `/Users/kaan/dev/personal-repositories/soc/soc-new-admin/main` |                3 |
| `/Users/kaan/dev/personal-repositories/trainwith.cc-next`      |                1 |
| `/Users/kaan/dev/2h2d-co/homebrew-safe`                        |                1 |
| `/Users/kaan/dev/2h2d-co/vscode-node-tests`                    |                1 |
| `/Users/kaan/.config/mise`                                     |                1 |
| `/Users/kaan/dev`                                              |                1 |
| `/Users/kaan`                                                  |                1 |

### Compaction outcome classification

Counts below use the 40 de-duplicated logical compactions.

| Outcome immediately around compaction                                      | Count | Classification                                               |
| -------------------------------------------------------------------------- | ----: | ------------------------------------------------------------ |
| Completed assistant response, then an ordinary later request or no child   |    17 | Expected; no unfinished run to continue                      |
| Recognized context overflow, then automatic assistant/tool activity        |    14 | Automatic continuation succeeded                             |
| Recognized context overflow, then a user message queued during compaction  |     1 | Not a post-compaction stall; message was appended 5 ms later |
| Aborted run, then a later user request                                     |     2 | User cancellation/abort, not automatic-continuation failure  |
| Model-switch boundary, then a user message queued during compaction        |     1 | Expected; the preceding assistant response had completed     |
| Tool-result boundary, then `please continue` queued during compaction      |     1 | Near-match, but not a post-compaction stall                  |
| Missing-tool-output error, threshold compaction, then a later user restart |     4 | Matching incidents                                           |

The excluded tool-result-boundary near-match was compaction `134df48f` on August 11. Its `please continue` entry was persisted only 5 ms after the compaction entry. A human could not have reacted after completion in that interval; the input was already queued while compaction was running. It therefore does not show that the completed compaction settled instead of continuing.

## Matching Incidents

### Incident overview

|   # | Assistant error                          | Native compaction             | Restart                                                                     | Tool kind                 |
| --: | ---------------------------------------- | ----------------------------- | --------------------------------------------------------------------------- | ------------------------- |
|   1 | `cb0f2bda` at `2026-08-10T21:02:06.395Z` | `daccf045` at `21:03:26.484Z` | Session resumed at `22:09:34.560Z`; `ok, please proceed` at `22:10:35.569Z` | `bash` function call      |
|   2 | `cf51a8a5` at `2026-08-12T08:30:44.803Z` | `9d2d8700` at `08:33:18.407Z` | `please continue` at `08:37:00.447Z`                                        | Two `bash` function calls |
|   3 | `6a141ac1` at `2026-08-13T08:45:46.724Z` | `73badf39` at `08:47:04.677Z` | `please continue` at `08:47:08.755Z`                                        | `apply_patch` custom call |
|   4 | `27371470` at `2026-08-13T20:27:37.247Z` | `1f0eb03a` at `20:29:02.835Z` | `please continue` at `20:30:45.891Z`                                        | `apply_patch` custom call |

All four assistant messages reported exactly `371,566` total tokens. Each contained the call ID named by OpenAI's missing-output error, and no preceding `toolResult` existed for that new call.

### Context-window percentages

The active `gpt-5.6-sol` model override set Pi's `contextWindow` to `372,000` tokens before these incidents. Pi and the extension calculate operational context percentages against that configured value, not the model's nominal `400,000`-token total capacity.

The pre-request values below reconstruct the context percentage available to provider-boundary compaction from each failed response's parent branch using Pi's `buildSessionContext()` and `estimateContextTokens()`. The post-error values are the later compaction entry's `tokensBefore` estimate and are included separately because they were not the value checked before the failed request.

| Assistant error | Pre-request Pi estimate | Failed response usage | Post-error compaction estimate |
| --------------- | ----------------------: | --------------------: | -----------------------------: |
| `cb0f2bda`      |    `370,524` — `99.60%` |  `371,566` — `99.88%` |           `370,954` — `99.72%` |
| `cf51a8a5`      |    `371,194` — `99.78%` |  `371,566` — `99.88%` |           `371,372` — `99.83%` |
| `6a141ac1`      |    `369,919` — `99.44%` |  `371,566` — `99.88%` |           `371,849` — `99.96%` |
| `27371470`      |    `371,069` — `99.75%` |  `371,566` — `99.88%` |           `371,433` — `99.85%` |

The previously reported approximately `92.9%` figure divided the response usage by the nominal `400,000`-token capacity. That figure is descriptive of nominal capacity but is not the percentage used by Pi or `autoCompactAtPercent`.

### Incident 1: August 10 function call

The original entries are in:

```text
~/.pi/agent/sessions/--Users-kaan-dev-2h2d-co--/
2026-08-10T13-53-54-997Z_019febf3-8d35-792a-b0c9-719222615a95.jsonl
```

They were copied into a resumed fork:

```text
2026-08-10T22-08-20-424Z_019fedb8-35c8-7d8e-8625-dacd01a7f8de.jsonl
```

Evidence:

- Assistant `stopReason`: `error`
- Error: `Codex error: No tool output found for function call ...`
- Assistant content included one `bash` call whose provider call ID matched the error.
- Assistant usage: `371,566` total tokens, including `977` output tokens.
- Compaction `tokensBefore`: `370,954`
- Provider diagnostics show full history growing from 665 to 668 items before transport recovery. The three additions were response items, including the new `bash` call; no corresponding function output was present.
- Compaction was extension-provided: `fromHook: true`, `details.kind: openai-codex-compat-remote-compaction`.
- The fork resumed from the same compaction ID about 66 minutes later. Kaan asked `what's the issue`, then sent `ok, please proceed`.

The repeated entries in the fork are one logical incident, not a second occurrence.

### Incident 2: August 12 function calls

This incident is in:

```text
~/.pi/agent/sessions/--Users-kaan-dev-deltatre--/
2026-08-11T07-41-14-828Z_019fefc4-b8cc-7fae-97da-b8c3191b6150.jsonl
```

Evidence:

- Assistant `stopReason`: `error`
- Error: `Codex error: No tool output found for function call ...`
- Assistant content included two `bash` calls; the first provider call ID matched the error.
- Assistant usage: `371,566` total tokens, including `258` output tokens.
- Compaction `tokensBefore`: `371,372`
- Provider diagnostics show full history growing from 541 to 544 items before transport recovery. The additions were reasoning and two function calls, with no corresponding outputs.
- `please continue` is the compaction's direct child.

### Incidents 3 and 4: August 13 custom calls

Both incidents are in:

```text
~/.pi/agent/sessions/--Users-kaan-dev-2h2d-co--/
2026-08-11T06-38-53-376Z_019fef8b-a1c0-70bb-a87c-6e22e87e077f.jsonl
```

Incident 3 evidence:

- Assistant `stopReason`: `error`
- Error: `Codex error: No tool output found for custom tool call ...`
- Assistant content included an `apply_patch` call whose provider call ID matched the error.
- Assistant usage: `371,566` total tokens, including `2,191` output tokens.
- Compaction `tokensBefore`: `371,849`
- Provider diagnostics show request history growing from 476 to 478 full input items. The additions were reasoning and the custom call, with no intervening Pi tool result.
- `please continue` is the compaction's direct child.

Incident 4 evidence:

- Assistant `stopReason`: `error`
- Error: `No tool output found for custom tool call ...`
- Assistant content included an `apply_patch` call whose provider call ID matched the error.
- Assistant usage: `371,566` total tokens, including `404` output tokens.
- Compaction `tokensBefore`: `371,433`
- Provider diagnostics show consecutive full SSE histories of 652 and 653 input items. The added item was the custom call, with no intervening Pi tool result.
- `please continue` is the compaction's direct child.

The identical `371,566` totals, low remaining output budgets, and added provider-history items strongly indicate that all four first subresponses reached the effective context/output ceiling while producing tool calls.

## Meaning of the Missing-Output Error

OpenAI's Responses protocol represents a tool invocation and its result as separate linked items:

- a `function_call` requires a later `function_call_output`;
- a `custom_tool_call` requires a later `custom_tool_call_output`.

`No tool output found ...` means the extension sent a provider request containing a call item without the required linked output item.

It does **not** mean Pi lost an already-recorded tool result in these incidents. The branch histories contain matching results for earlier tool calls. The call IDs named by the four errors first appear in the failed assistant messages, and those messages have `stopReason: "error"`. Pi never received a successful tool-use response for those calls, so it never executed them and could not produce their outputs.

## Root Cause

### 1. The session could reach the provider ceiling during one agent run

The active configuration was:

```json
{
  "autoCompactAtPercent": null
}
```

This disables the extension's provider-boundary percentage compaction and leaves threshold selection to Pi.

Pi 0.84.2 checks proactive threshold compaction after `agent_end`, not between every tool-calling turn in the same agent run. A long run can therefore be below the threshold when it starts, accumulate tool results over several turns, and exceed the safe request budget before `agent_end`.

That is what the token evidence indicates here: all four failed assistant messages reached `99.88%` of the configured context window and the reconstructed pre-request branches were already between `99.44%` and `99.78%`.

### 2. The extension continued a response after it contained a tool call

The relevant loop is in [`codex-provider.ts`](extensions/openai-codex-compat/codex-provider.ts):

1. `continueResponseBody()` appends `attemptItems` to the next provider request.
2. `retryableTerminal` treats every `response.incomplete`, and most `response.failed` results, as internally retryable.
3. That retry branch runs even when the attempt produced a tool call.
4. The `end_turn: false` branch has a tool-call guard, but the guard uses `completedContentIndexes` from streamed item lifecycle events rather than the terminal response's authoritative `attemptItems`.

The raw terminal event from the first subrequest was not persisted, so the sessions cannot prove whether each continuation selected:

- the unguarded `response.incomplete`/`response.failed` retry branch; or
- the `end_turn: false` branch after streamed completion bookkeeping failed to recognize a terminal-only tool item.

The first case is more likely because all four responses ended at the same token ceiling. Both cases have the same protocol defect: a provider subrequest must not replay a tool call that requires client execution before its corresponding tool output exists.

### 3. OpenAI correctly rejected the dangling tool calls

The extension's next provider histories contained emitted `bash` or `apply_patch` calls but no corresponding `function_call_output` or `custom_tool_call_output`. Pi had not received successful assistant tool-use responses yet, so it had no opportunity to execute those calls.

OpenAI rejected the malformed sequences with `No tool output found for function call ...` or `No tool output found for custom tool call ...`.

### 4. Pi correctly treated the subsequent compaction as non-continuing

Pi's [`AgentSession._checkCompaction()` at v0.84.2](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/core/agent-session.ts#L1950-L2203) distinguishes:

- recognized overflow/recoverable length: compact and retry;
- threshold pressure: compact with no retry.

`No tool output found ...` matches neither Pi's context-overflow patterns nor its transient retry patterns. Pi therefore:

1. retained the terminal error;
2. noticed the high estimated context;
3. ran threshold compaction;
4. passed `reason: "threshold"` and `willRetry: false` to the extension;
5. settled after the successful checkpoint.

Changing native compaction alone cannot make this path continue because the caller explicitly requested a non-retrying threshold compaction.

## Pi 0.84.2 `end_turn` Review

Latest Pi source inspected:

| Ref                         | Commit                                     | Date       |
| --------------------------- | ------------------------------------------ | ---------- |
| `v0.84.2`                   | `914cf1472e715297caa30db4b9535d534a9eb718` | 2026-08-14 |
| Latest `main` during review | `086c32e74530564922d011ade23ff582c9d63116` | 2026-08-15 |

The relevant change is [PR #7766](https://github.com/earendil-works/pi/pull/7766), commit `c3e7bc60a13b0a6fb80f7e8a867112ee4d10c92a`.

It:

- reads `response.end_turn` in Pi's built-in OpenAI Codex stream;
- stores it as `AssistantMessage.endTurn`;
- tests that SSE and WebSocket responses preserve `false`;
- documents the field as diagnostic only.

The type comment is explicit:

> Preserved for debugging and does not currently affect agent control flow.

Current Pi `main` still contains no `endTurn` references in `packages/agent`; [issue #7689](https://github.com/earendil-works/pi/issues/7689) remains open.

It solves **0 of the 4 incidents** because:

1. the observed terminal messages had `stopReason: "error"` and no `endTurn` value;
2. Pi 0.84.2 does not use `endTurn` to trigger another agent turn;
3. this extension owns a custom Codex provider and consumes raw `end_turn` internally without assigning `output.endTurn`;
4. even a future Pi fix for successful `endTurn === false` would not directly recover these persisted missing-tool-output errors.

The upstream change is still useful infrastructure. Once Pi implements #7689, the extension could expose `endTurn` and delegate no-tool follow-up control to the agent loop instead of owning that continuation inside one provider call.

## Potential Fixes for Review

### P0 implemented: Match Codex item commit and tool execution semantics

Internal response handling now uses the same item commit point as Codex:

> Only `response.output_item.done` commits a provider item. Terminal `response.output` snapshots are ignored.

The linked-output invariant remains:

> Never append a `function_call` or `custom_tool_call` to a new provider request until its required output item exists.

Implemented policy:

- A done tool call returns control to Pi as tool use regardless of whether the response later completes, becomes incomplete, or fails.
- Calls seen only through `response.output_item.added` or deltas are provisional, are removed from the final assistant message, and are never persisted as provider history.
- A mixed batch returns its done subset while discarding started-only siblings.
- Terminal-only calls are ignored, including non-empty terminal snapshots that disagree with streamed done items.
- An unsuccessful response after done calls is deferred until Pi records every linked tool output. Retryable failures then resample with the linked outputs; non-retryable failures surface without another provider request.
- WebSocket continuation state is built from done items rather than terminal output.

Regression coverage now includes:

- function and custom tool calls;
- streamed `response.output_item.done` items without completed status markers;
- terminal-only output items and conflicting terminal snapshots;
- terminal output that omits a streamed call;
- item-by-item handling for mixed done and partial call batches;
- `end_turn: false`;
- `response.incomplete` with `max_output_tokens`;
- retryable and non-retryable `response.failed` after linked tool execution;
- proof that a second provider request is not sent before tool output;
- a host-level Pi tool execution and linked-output round trip.

### P0 mitigation enabled: Provider-boundary percentage compaction

The active global configuration sets `autoCompactAtPercent` to 95.

This uses the existing `maybeCompactPercentage()` path before each provider request, including requests inside a long tool-calling run. It directly covers the gap in Pi's post-`agent_end` threshold timing.

All four reviewed requests were above 95% of Pi's configured `372,000`-token context window before they began, and all four branches satisfied the extension's requirement that a new assistant message exist after the latest checkpoint. The 95% provider-boundary threshold therefore would have triggered before each failed request. The implemented unresolved-tool-call invariant remains necessary because malformed continuation across a tool call is a protocol defect regardless of context pressure.

Trade-offs:

- more frequent native compactions;
- additional latency and compaction usage;
- the configured percentage needs operational validation;
- this reduces exposure but should not replace the unresolved-tool-call protocol fix.

### P1 skipped: Add a narrowly scoped recovery fallback

When all of the following hold:

- provider is this extension's `openai-codex`;
- error is `No tool output found ...`;
- the failed assistant contains the matching tool call;
- usage is at or above a reviewed near-context threshold;

normalize the failure into a bounded overflow-recovery signal so Pi compacts with `willRetry: true`.

This would have recovered all four observed incidents, but it was deliberately skipped after the root fix. A recurrence should remain visible as evidence of malformed history or an unrecognized protocol path rather than being automatically compacted away.

### P1 implemented: Persist safe continuation diagnostics

Nontrivial provider decisions now record content-free fields needed to distinguish future cases:

- terminal event type;
- incomplete reason;
- `end_turn`;
- committed done-item output type counts;
- streamed-started and streamed-done call counts;
- returned-call and discarded-partial-call counts;
- deferred post-tool disposition, when applicable;
- chosen continuation/retry branch;
- provider attempt number.

Native checkpoint details now also persist compaction reason and `willRetry`, including the distinct `provider-boundary` reason.

### P2: Follow upstream Pi #7689

If Pi's agent loop begins honoring successful `endTurn === false`:

1. assign the raw field to this extension's `AssistantMessage`;
2. remove or reduce duplicate provider-internal no-tool continuation;
3. retain explicit tool-use and length-stop behavior;
4. test that extension and Pi do not both continue the same response.

This is useful cleanup and protocol alignment, but it is not a direct fix for the four observed error messages.

### P2: Consider proactive compaction between Pi turns

An upstream Pi design could check context at the checkpoint between a tool batch and the next provider call rather than only after `agent_end`. The extension's percentage compaction already provides a provider-specific version of this behavior.

## Approaches to Avoid

- Do not automatically send a synthetic `continue` after every compaction. Most audited compactions correctly followed completed work or ordinary user prompts.
- Do not make every threshold compaction retry. Threshold compaction intentionally has no unfinished request to replay.
- Do not classify every missing-tool-output error as transient. Away from the context ceiling it is evidence of malformed history and should fail closed.
- Do not rely only on Pi 0.84.2's `endTurn` field. It is diagnostic and is not populated by the extension's custom provider.

## Implementation Status

1. Unresolved-tool-call invariant and incomplete-call handling: implemented.
2. Provider-boundary percentage compaction: enabled globally at 95%.
3. Narrow near-context missing-output recovery: skipped.
4. Permanent provider, stream, compaction, and host-level regression coverage: implemented.
5. Content-free response-decision and compaction diagnostics: implemented.
6. Delegation to Pi's agent loop: revisit only after upstream issue #7689 is implemented.
