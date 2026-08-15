# Compaction Continuation Incident Review

- Date: 2026-08-15
- Status: Review only; no runtime or test fixes implemented

## Dictionary

- **Pi-triggered remote compaction**: Pi decides that compaction is needed, then this extension handles `session_before_compact` and obtains a native OpenAI Codex checkpoint.
- **Provider-boundary percentage compaction**: This extension compacts inside `CodexProviderRuntime` immediately before a provider request when `autoCompactAtPercent` is configured.
- **Provider subrequest**: One OpenAI request made internally by the extension while producing one Pi assistant response. The extension may make multiple subrequests for response continuation or retry.
- **Threshold compaction**: Proactive Pi compaction after an agent run. Pi intentionally sets `willRetry: false`.
- **Overflow compaction**: Pi recovery after a recognized context-overflow or recoverable length response. Pi sets `willRetry: true` and continues the interrupted run.

## Conclusion

The three-day window contained exactly **two matching stalls**. Both occurred in the same long-running session and had the same failure shape:

1. Codex emitted an `apply_patch` tool call at the effective context/output ceiling.
2. The extension made another provider subrequest after appending response items, but without a tool output for that call.
3. OpenAI rejected the subrequest with `No tool output found for custom tool call ...`.
4. Pi did not classify that error as retryable or as context overflow.
5. Pi then performed a successful **threshold** compaction with `willRetry: false`, as designed.
6. The agent settled until Kaan sent `please continue`.

The checkpoint compaction itself did not fail and was not the component that dropped a continuation. The run had already ended on a non-retryable provider error. Compaction was the last visible automatic action, which made the symptom look like a compaction continuation failure.

Pi 0.84.2 does **not** solve either incident. Its OpenAI `end_turn` change only preserves the value on `AssistantMessage` for diagnostics and explicitly does not affect control flow.

## Audit Scope

### Time window

The audit used entry timestamps, not file creation times or modification times:

```text
2026-08-12T19:30:46Z through 2026-08-15T19:30:46Z
```

Using entry timestamps includes sessions created before the window but still active during it.

### Coverage

- 34 session files contained entries in the window.
- Every JSONL line parsed successfully.
- 19 extension-provided native compactions were found.
- The 19 compactions occurred in 3 session files.
- 10 user messages matched a broad continuation-language search. Manual branch review reduced these to 2 messages that directly followed compaction and existed only to restart stalled work.

Session inventory by working directory:

| Working directory                                            | Sessions checked |
| ------------------------------------------------------------ | ---------------: |
| `/Users/kaan/dev/2h2d-co/pi-openai-codex-compat`             |               18 |
| `/Users/kaan/dev/2h2d-co`                                    |                5 |
| `/Users/kaan/.pi/agent`                                      |                4 |
| `/Users/kaan/dev/deltatre`                                   |                3 |
| `/Users/kaan/dev/personal-repositories/soc/sai-backend/main` |                2 |
| `/Users/kaan/dev/personal-repositories/trainwith.cc-next`    |                1 |
| `/Users/kaan`                                                |                1 |

### Compaction outcome classification

| Outcome immediately around compaction                                     | Count | Classification                                              |
| ------------------------------------------------------------------------- | ----: | ----------------------------------------------------------- |
| Completed assistant response, then an ordinary later user request         |     8 | Expected; no unfinished run to continue                     |
| Recognized context overflow, then automatic assistant/tool activity       |     6 | Automatic continuation succeeded                            |
| Recognized context overflow, then a user message queued during compaction |     1 | Not a stall; message was appended 5 ms after compaction     |
| Aborted run, then a later user request                                    |     2 | User cancellation/abort, not automatic-continuation failure |
| Missing-tool-output error, threshold compaction, then `please continue`   |     2 | Matching incidents                                          |

## Matching Incidents

Both incidents are in:

```text
~/.pi/agent/sessions/--Users-kaan-dev-2h2d-co--/
2026-08-11T06-38-53-376Z_019fef8b-a1c0-70bb-a87c-6e22e87e077f.jsonl
```

### Incident 1

| Event             | UTC timestamp              | Entry                          |
| ----------------- | -------------------------- | ------------------------------ |
| Assistant error   | `2026-08-13T08:45:46.724Z` | `6a141ac1`                     |
| Native compaction | `2026-08-13T08:47:04.677Z` | `73badf39`                     |
| User restart      | `2026-08-13T08:47:08.755Z` | `c6f90bbc` (`please continue`) |

Evidence:

- Assistant `stopReason`: `error`
- Error: `Codex error: No tool output found for custom tool call ...`
- Assistant content included an `apply_patch` tool call whose provider call ID matched the error.
- Assistant usage: exactly `371,566` total tokens, including `2,191` output tokens.
- Compaction `tokensBefore`: `371,849`
- Provider diagnostics show the request history growing from 476 to 478 full input items. The two added items correspond to the response's reasoning and tool-call items, but there was no intervening Pi tool result.
- Compaction was extension-provided: `fromHook: true`, `details.kind: openai-codex-compat-remote-compaction`.

### Incident 2

| Event             | UTC timestamp              | Entry                          |
| ----------------- | -------------------------- | ------------------------------ |
| Assistant error   | `2026-08-13T20:27:37.247Z` | `27371470`                     |
| Native compaction | `2026-08-13T20:29:02.835Z` | `1f0eb03a`                     |
| User restart      | `2026-08-13T20:30:45.891Z` | `b35d69bb` (`please continue`) |

Evidence:

- Assistant `stopReason`: `error`
- Error: `No tool output found for custom tool call ...`
- Assistant content included an `apply_patch` tool call whose provider call ID matched the error.
- Assistant usage: exactly `371,566` total tokens, including `404` output tokens.
- Compaction `tokensBefore`: `371,433`
- Provider diagnostics show consecutive full SSE histories of 652 and 653 input items. The added item was the tool call, with no intervening Pi tool result.
- Compaction was extension-provided with the same checkpoint kind as incident 1.

The identical `371,566` totals, low remaining output budgets, and added provider-history items strongly indicate that both first subresponses reached the effective context/output ceiling while producing a tool call.

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

That is what the token evidence indicates here: both failed assistant messages reached the same effective total-token ceiling.

### 2. The extension continued a response after it contained a tool call

The relevant loop is in [`codex-provider.ts`](extensions/openai-codex-compat/codex-provider.ts):

1. `continueResponseBody()` appends `attemptItems` to the next provider request.
2. `retryableTerminal` treats every `response.incomplete`, and most `response.failed` results, as internally retryable.
3. That retry branch runs even when the attempt produced a tool call.
4. The `end_turn: false` branch has a tool-call guard, but the guard uses `completedContentIndexes` from streamed item lifecycle events rather than the terminal response's authoritative `attemptItems`.

The raw terminal event from the first subrequest was not persisted, so the sessions cannot prove whether each continuation selected:

- the unguarded `response.incomplete`/`response.failed` retry branch; or
- the `end_turn: false` branch after streamed completion bookkeeping failed to recognize a terminal-only tool item.

The first case is more likely because both responses ended at the same token ceiling. Both cases have the same protocol defect: a provider subrequest must not replay a tool call that requires client execution before its corresponding tool output exists.

### 3. OpenAI correctly rejected the dangling custom tool call

The extension's next provider history contained the emitted `apply_patch` call but no `custom_tool_call_output`. Pi had not received a successful assistant tool-use response yet, so it had no opportunity to execute `apply_patch`.

OpenAI rejected the malformed sequence with `No tool output found for custom tool call ...`.

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

It solves **0 of the 2 incidents** because:

1. the observed terminal messages had `stopReason: "error"` and no `endTurn` value;
2. Pi 0.84.2 does not use `endTurn` to trigger another agent turn;
3. this extension owns a custom Codex provider and consumes raw `end_turn` internally without assigning `output.endTurn`;
4. even a future Pi fix for successful `endTurn === false` would not directly recover these persisted missing-tool-output errors.

The upstream change is still useful infrastructure. Once Pi implements #7689, the extension could expose `endTurn` and delegate no-tool follow-up control to the agent loop instead of owning that continuation inside one provider call.

## Potential Fixes for Review

### P0: Prevent provider continuation across unresolved tool calls

Change all internal response continuation/retry decisions to inspect authoritative response items, not only streamed content indexes.

Required invariant:

> Never append a `function_call` or `custom_tool_call` to a new provider subrequest until its required output item exists.

Cases to define:

- `response.completed`, `end_turn: false`, tool call present: return control to Pi as tool use; Pi executes the tool and naturally performs the next model turn.
- `response.incomplete`, complete tool call present: do not internally replay it without output. Decide whether a fully completed call is safe to execute or should follow Pi's truncated-tool-call failure path.
- `response.failed`, tool call present: preserve the original provider failure and do not replay a dangling call.

Regression coverage should include:

- function and custom tool calls;
- streamed `response.output_item.done` items;
- terminal-response-only output items;
- `end_turn: false`;
- `response.incomplete` with `max_output_tokens`;
- retryable `response.failed`;
- proof that the second request is not sent before tool output.

### P0 mitigation: Enable provider-boundary percentage compaction

Set `autoCompactAtPercent` to a reviewed value such as 80 or 85 instead of `null`.

This uses the existing `maybeCompactPercentage()` path before each provider request, including requests inside a long tool-calling run. It directly covers the gap in Pi's post-`agent_end` threshold timing.

Trade-offs:

- more frequent native compactions;
- additional latency and compaction usage;
- the configured percentage needs operational validation;
- this reduces exposure but should not replace the unresolved-tool-call protocol fix.

### P1: Add a narrowly scoped recovery fallback

When all of the following hold:

- provider is this extension's `openai-codex`;
- error is `No tool output found ...`;
- the failed assistant contains the matching tool call;
- usage is at or above a reviewed near-context threshold;

normalize the failure into a bounded overflow-recovery signal so Pi compacts with `willRetry: true`.

This would have recovered both observed incidents. It must remain narrow because a missing tool output at ordinary context usage usually indicates deterministic history corruption, not transient overflow.

### P1: Persist safe continuation diagnostics

Record content-free fields needed to distinguish future cases:

- terminal event type;
- incomplete reason;
- `end_turn`;
- output item types and count;
- chosen continuation/retry branch;
- whether a call item lacked an output;
- compaction reason and `willRetry`.

The current session evidence proves the malformed replay but cannot identify the exact first-terminal branch because that terminal metadata was not persisted.

### P2: Follow upstream Pi #7689

If Pi's agent loop begins honoring successful `endTurn === false`:

1. assign the raw field to this extension's `AssistantMessage`;
2. remove or reduce duplicate provider-internal no-tool continuation;
3. retain explicit tool-use and length-stop behavior;
4. test that extension and Pi do not both continue the same response.

This is useful cleanup and protocol alignment, but it is not a direct fix for the two observed error messages.

### P2: Consider proactive compaction between Pi turns

An upstream Pi design could check context at the checkpoint between a tool batch and the next provider call rather than only after `agent_end`. The extension's percentage compaction already provides a provider-specific version of this behavior.

## Approaches to Avoid

- Do not automatically send a synthetic `continue` after every compaction. Most audited compactions correctly followed completed work or ordinary user prompts.
- Do not make every threshold compaction retry. Threshold compaction intentionally has no unfinished request to replay.
- Do not classify every missing-tool-output error as transient. Away from the context ceiling it is evidence of malformed history and should fail closed.
- Do not rely only on Pi 0.84.2's `endTurn` field. It is diagnostic and is not populated by the extension's custom provider.

## Recommended Review Order

1. Approve the unresolved-tool-call invariant and exact handling for incomplete tool-call responses.
2. Decide whether to enable `autoCompactAtPercent` as an immediate configuration mitigation and choose the threshold.
3. Decide whether the narrow near-context recovery fallback is worthwhile after the root fix.
4. Approve the safe diagnostics needed to validate future incidents.
5. Revisit delegation to Pi after upstream issue #7689 is implemented.
