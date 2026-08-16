# Auto-Continuation and Overflow Recovery Review

- Status: Decisions complete; implementation pending
- Scope: Output-limit continuation, committed-prefix overflow recovery, provider-subrequest compaction, and host-level regression coverage

## Dictionary

- **Provider subrequest**: One OpenAI request made internally while producing one Pi assistant response.
- **Provider item commit**: `response.output_item.done`; deltas and started-only items remain provisional.
- **Pi assistant outcome**: The final aggregate `AssistantMessage` returned to Pi after one or more provider subrequests.
- **Committed prefix**: The ordered provider items committed before a later subrequest fails.
- **Logical context**: The complete ordered history OpenAI reconstructs, independent of transport compression.
- **Transport suffix**: The smaller `input` sent with `previous_response_id` when WebSocket continuation can reuse a matching prefix.

## Symbol Legend

```text
H0   history before the current provider invocation
U    original user request
U2   later user request
B1   ordered committed output batch from provider subrequest 1
B2   ordered committed output batch from provider subrequest 2
R    completed reasoning item
A    completed assistant commentary/message
F    completed final-answer message
C    completed tool call
O    tool output linked to C
P    provisional item that never reached output_item.done
E    aggregate Pi assistant ending in an error
H    hidden output-limit continuation message
T    { type: "compaction_trigger" }
K    opaque native compaction checkpoint
```

`B1` can contain several item types:

```text
B1 = [R1, A1, R2, F1]
```

It does not mean only assistant text. Streaming deltas are accumulated into their item and become context only when the corresponding item reaches `response.output_item.done`.

## Shared Invariants

```text
Only output_item.done commits a provider item.
```

```text
Never send C in a new request unless its linked O is also present.
```

```text
Never carry P into provider history.
```

Terminal `response.output` snapshots do not commit regular response items.

## Decision Register

| Topic                                                               | Decision                                                                      |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Output-limit hidden-continuation chain limit                        | Leave unchanged; do not add a chain-wide bound                                |
| Context overflow after a committed prefix `B1`                      | Preserve validated `B1`, compact immediately, and retry automatically         |
| Percentage compaction before internal `end_turn:false` continuation | Implement Option B: proactive compaction with an explicit Pi history boundary |
| Successful compaction-to-hidden-continuation regression coverage    | Implement Option A: add focused unit and full host-level coverage             |

The selected changes must preserve the context and transcript layouts documented below.

## 1. Output-Limit Hidden-Continuation Chains

### Original concern

One Pi agent turn has a bounded provider retry budget, but an exhausted exact `max_output_tokens` result can create hidden continuation `H`. That starts another Pi turn with a fresh provider retry budget. Response-ID hashing prevents duplicate recovery of the same response but does not impose a chain-wide maximum across new response IDs.

The theoretical chain is:

```text
[U]
→ exhausted output-limit response
→ optional compaction K1
→ [K1, H1]
→ exhausted output-limit response
→ optional compaction K2
→ [K2, H2]
→ ...
```

### Realistic context-pressure path

Near the context ceiling, appending a committed batch is likely to produce a context-overflow error before many output-limit retries can accumulate:

```text
Request 1:
[U]

Response:
B1
response.incomplete(max_output_tokens)
```

The provider tries:

```text
Request 2:
[U, B1]
```

If OpenAI returns `context_length_exceeded`, the final Pi outcome is an error, not an exact output-limit length stop:

```text
Pi outcome:
E(B1)
stopReason = error
```

The hidden output-limit hook therefore does not schedule `H`.

Pi instead performs one bounded overflow compact-and-retry recovery. If the retry overflows again during the same user run, Pi stops rather than repeatedly compacting.

### Decision

Leave output-limit continuation chains unchanged.

Rationale:

- The concerning near-ceiling path naturally changes into bounded context-overflow recovery.
- Repeated hidden continuations remain useful for genuinely long output where requests continue fitting in the context window.
- A hard chain cap would trade autonomous completion for a low-probability protection.

## Selected Cross-Cutting Improvement: Preserve a Committed Prefix Across Context Overflow

### Current architecture

The provider can commit `B1` and then receive context overflow on its next internal request:

```text
Request 1:
[U]

Response:
B1 = [R1, A1, F1]
response.incomplete(max_output_tokens)
```

```text
Request 2:
[U, B1]

Response:
context_length_exceeded
```

Provider items in `B1` are committed, but Pi currently receives one aggregate failed assistant:

```text
Pi history:
[U, E(B1)]
```

Pi's generic overflow recovery removes the complete failed assistant, and the native compaction hook mirrors that removal:

```text
Current compaction:
[U, T]
```

Consequently, `B1` is omitted from the model-visible recovery context even though its items reached `output_item.done`.

### Selected behavior

Extract and validate the committed prefix, then compact:

```text
Desired compaction:
[U, B1, T]
```

After OpenAI returns `K`:

```text
Automatic retry:
[retained recent items, K]
```

No hidden continuation message is needed:

```text
Do not send:
[retained recent items, K, H]
```

### Validation requirements

Before preserving `B1`, recovery must prove:

1. Every retained item reached `response.output_item.done`.
2. No started-only item `P` is retained.
3. Every retained tool call `C` has a linked tool output `O`.
4. The prefix can be separated from the provider subrequest that produced the overflow error.
5. Native and canonical Pi history will not replay the same prefix twice after `K`.
6. Compaction and validation continue to fail closed.

If validation cannot prove a safe committed prefix, recovery must not construct a history containing an unresolved tool call.

### Official Codex CLI comparison

Official Codex records each done item directly into conversation history:

```text
History after Request 1:
[U, B1]
```

The later context-overflow error is a separate turn error rather than an aggregate assistant containing `B1`:

```text
Conversation history:
[U, B1]

Turn error:
context_length_exceeded
```

Official Codex stops the current turn. Before the next user request `U2`, it compacts:

```text
Compaction:
[U, B1, T]
```

Then samples:

```text
[retained recent items, K, U2]
```

The selected extension behavior combines:

```text
Official-style preservation of B1
+ immediate Pi overflow compaction
+ automatic retry of the interrupted turn
```

## 2. Percentage Compaction Before Internal Provider Continuations

### Precise case under review

The clearest gap is a successful no-tool response with:

```text
response.completed
end_turn = false
```

Suppose Pi's captured context is below the configured threshold:

```text
H0 = 94%
threshold = 95%
```

The extension checks once before Request 1:

```text
Request 1:
[H0]
```

OpenAI commits `B1` and requests continuation:

```text
Response:
B1
end_turn = false

Logical context:
[H0, B1] = 97%
```

### Current behavior

The internal loop immediately sends:

```text
Request 2:
[H0, B1]
```

`maybeCompactPercentage()` is not re-entered. Pi's captured percentage also remains stale because `B1` has not yet returned as a completed Pi assistant.

If Request 2 overflows, the newly selected committed-prefix recovery can react:

```text
[H0, B1]
→ context overflow
→ compact [H0, B1, T]
→ retry [K]
```

This preserves progress but sends one avoidable rejected request.

### Proactive target

```text
Request 1:
[H0]

Response:
B1
end_turn = false

Compaction:
[H0, B1, T]

Request 2:
[retained recent items, K]
```

### Tool-call contrast

A done tool call already returns control to Pi:

```text
Request 1:
[H0]

Response:
[R1, A1, C1]
```

Pi records `O1`, then starts a fresh provider invocation:

```text
[H0, R1, A1, C1, O1]
```

That invocation rechecks percentage compaction:

```text
Compaction:
[H0, R1, A1, C1, O1, T]
```

The remaining gap is therefore centered on internal no-tool continuation.

### Official Codex CLI comparison

Official Codex records `B1`, marks `needs_follow_up`, and checks context pressure after the successfully completed sampling response.

Below threshold:

```text
Request 2:
[H0, B1]
```

At or above threshold:

```text
Compaction:
[H0, B1, T]

Request 2:
[retained recent items, K]
```

### Implementation complication

Three different layouts must remain distinct.

The complete persisted session and TUI transcript should show the chronological audit trail:

```text
[H0, B1, K, B2]
```

Here, `K` is rendered as Pi's compaction marker rather than as its encrypted provider payload.

Because `K` supersedes the model-visible history before it, the active provider context for a later request should be:

```text
[retained recent items, K, B2]
```

It must not replay the pre-compaction prefix separately:

```text
Invalid provider duplication:
[retained recent items, K(B1), B1, B2]
```

The current provider API produces one aggregate Pi assistant for all internal subrequests. If `K` is appended while that assistant is still in progress and the final assistant contains both batches, a naive persisted transcript could instead become:

```text
[H0, K, Assistant(B1, B2)]
```

That is not the selected TUI/session layout. Option B therefore requires a real Pi history boundary:

```text
assistant before compaction: B1
compaction entry: K
assistant after compaction: B2
```

The implementation must preserve both views:

```text
TUI/session transcript:
[H0, B1, K, B2]

Active provider context:
[retained recent items, K, B2]
```

### Options considered

#### Option A: Reactive overflow recovery

```text
[H0, B1]
→ overflow
→ compact [H0, B1, T]
→ retry [K]
```

- Simpler.
- Preserves `B1` under the selected overflow policy.
- Sends an avoidable failed request and relies on overflow recognition.

#### Option B: Proactive internal compaction

```text
[H0]
→ B1 with end_turn:false
→ compact [H0, B1, T]
→ continue [K]
```

- Matches official mid-turn compaction more closely.
- Avoids the context-overflow request.
- Requires provider-usage accounting, exact native-history partitioning, and an explicit Pi assistant/compaction boundary.

Decision: selected.

#### Option C: Delegate `end_turn:false` to Pi

Architecturally:

```text
Provider returns B1 with endTurn:false
→ Pi checks compaction
→ Pi continues
```

Pi 0.84 preserves `endTurn` diagnostically but does not currently use it for agent control flow, so this is not sufficient yet.

#### Option D: Hidden continuation boundary

```text
Provider returns B1
→ Pi compacts
→ hidden H
→ [K, H]
```

This adds model-visible synthetic input and does not match official context:

```text
Official:
[K]

Hidden alternative:
[K, H]
```

This option is not preferred.

## 3. Successful Compaction-to-Hidden-Continuation Coverage

### Behavior under test

The output-limit continuation hook exists for an exact length result that Pi does not automatically retry:

```text
U    original user request
L    final Pi assistant with incomplete.max_output_tokens
T    compaction trigger
K    successful native compaction checkpoint
H    hidden continuation message
F    final successful assistant response
```

The target lifecycle is:

```text
[U]
→ L
→ compact [U, L, T]
→ install K
→ agent settles
→ add hidden H
→ sample [retained U, K, H]
→ F
```

This is threshold compaction with:

```text
reason = threshold
willRetry = false
```

Pi installs `K` but does not continue by itself. The output-limit hook waits for successful compaction and starts the hidden turn only at `agent_settled`.

The three observable layouts are:

```text
Persisted Pi session:
[U, L, K, H, F]

Visible TUI:
[U, L, K, F]

Active provider context for F:
[retained U, K, H]
```

`H` is persisted for deterministic replay but has `display: false`.

### Existing coverage

The current unit coverage verifies:

- exact output-limit classification;
- no-compaction continuation;
- duplicate suppression;
- cancellation;
- failed compaction;
- pending work and idle-state checks.

The current host integration recovers through provider resampling and then performs threshold compaction after successful completion. It asserts that no hidden continuation was required.

The missing host-level scenario is:

```text
exact output-limit length result
→ successful threshold compaction
→ agent_settled
→ hidden continuation starts
→ next provider request contains [K, H]
```

The former integration test for that exact path was replaced when provider-owned resampling was introduced.

### Missing focused unit case

The event harness does not directly exercise the successful state transition:

```text
agent_end(L)
→ session_before_compact
→ session_compact
→ agent_settled
→ H is sent
```

It covers no compaction, cancellation, and a compaction that starts but never emits `session_compact`; it does not cover:

```text
compaction = started
→ compaction = completed
→ continue
```

### Missing host case

The host regression must drive the complete integration:

```text
provider retry budget is exhausted
→ Pi receives L
→ Pi starts threshold compaction
→ native compaction returns K
→ Pi emits session_compact
→ Pi emits agent_settled
→ extension persists hidden H and triggers a turn
→ next provider request reconstructs [retained U, K, H]
→ provider returns F
```

It must assert:

1. The compaction request contains `T`.
2. The hidden continuation request contains `K` and `H`.
3. The hidden request does not replay the uncompacted full prefix.
4. The persisted order is `[U, L, K, H, F]`.
5. The visible continuation remains hidden through `display: false`.
6. Exactly one hidden continuation is recorded for the exhausted response.

The provider's default five-retry policy may require six incomplete mock responses before `L`. Test infrastructure may inject a zero delay, but production retry policy must not be weakened for test convenience.

### Options considered

#### Option A: Unit and host coverage

- Isolate the `started → completed → H` state transition.
- Prove real Pi event ordering and checkpoint reconstruction.
- Protect the exact user-facing behavior that motivated the hidden continuation.

Decision: selected.

#### Option B: Host coverage only

- Proves the integrated behavior.
- Makes state-machine failures slower and harder to diagnose.

#### Option C: Unit coverage only

- Fast and focused.
- Does not prove actual Pi lifecycle ordering or final provider context `[K, H]`.

#### Option D: Leave coverage unchanged

- Avoids a more involved fixture.
- Leaves the primary compaction-to-continuation behavior unverified end to end.

## Deferred Implementation Checklist

- [x] Leave output-limit hidden-continuation chaining unchanged.
- [x] Preserve a validated committed prefix `B1` during immediate overflow compaction.
- [x] Retry automatically from the installed checkpoint after preserving `B1`.
- [x] Use proactive internal compaction for `end_turn:false`.
- [ ] Preserve TUI/session order as `[H0, B1, K, B2]`.
- [ ] Preserve active provider context as `[retained recent items, K, B2]`.
- [x] Add both focused unit and full host coverage for successful compaction followed by hidden continuation.
- [ ] Verify hidden continuation persistence as `[U, L, K, H, F]`.
- [ ] Verify hidden continuation provider context as `[retained U, K, H]`.
- [ ] Implement all selected changes.
