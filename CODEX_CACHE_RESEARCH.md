# Codex caching and transport comparison

This document records the cache investigation comparing this extension with the official OpenAI Codex CLI. It distinguishes observed behavior from source-confirmed protocol behavior and from hypotheses that still need repeated live validation.

## Reference baseline

- Installed official release: `rust-v0.146.0` at `e363b08c9175ac1cbe5893615dd2cb9ddf95043b`.
- Reference checkout: `.reference/openai-codex`.
- Reference `origin/main` when inspected: `0bdce9f424eb9b39d7b3a8811742d10b6fbf8d54`.
- Post-`0.146.0` routing change: `270d93268ce97e8c5606a6cf12b4192d71b2581a`, “Send model routing hints to the Codex backend.”

The routing-hint change is not part of `0.146.0`. It is included here because it was added explicitly to steer first-party Codex requests by model and service tier and therefore may affect backend cache locality.

## Bottom line

1. Pi's cache reads **were increasing**. The small-turn tests hid this because reported reads moved in coarse token blocks.
2. The actual Pi-specific problem was intermittent **full misses or regressions to an older cached prefix**, even while one WebSocket and a valid `previous_response_id` chain were being reused.
3. Responses Lite did not eliminate those regressions. It changes the request envelope, not the backend placement identity.
4. Official Codex is **not immune**. A controlled official run regressed from 13,056 cached tokens to zero on turn 5 while its other two controlled runs did not regress.
5. Stock Codex usually hides full misses behind a large static floor. Its captured Responses Lite prewarm placed 23,345 bytes of tool declarations before base instructions, and stock runs retained at least 3,840 cached tokens even when a deeper prefix failed to advance.
6. A routing hint by itself did not fix Pi's regressions. Stable installation/window identity plus the hint also did not eliminate them across repeated post-change Lite trials; the first successful ordinary run was a favorable sample, not causal evidence.
7. Replaying Codex's exact captured static request shape through this extension's transport produced two monotonic runs and one regression to the same 3,840-token static floor. The WebSocket implementation is therefore not the primary explanation for the comparison gap.
8. The installed Codex `0.146.0` capture preserved direct top-level `function` and `custom` tools. Current upstream commit `f21dc46388` subsequently canonicalized those declarations under the same `functions` namespace already used by this extension. The direct-versus-grouped result is version skew, not a remaining extension defect.

Metadata does not itself add model-visible cached tokens. Installation, window, routing, session, and turn-state values can instead influence which backend route sees the request. Prewarm affects the model-visible prefix; affinity metadata affects the likelihood that subsequent requests reach the cache population that owns that prefix.

None of the controlled Pi runs received `x-codex-turn-state`, so their different trajectories cannot be attributed to server-issued turn state.

## Live cache trajectories

All values below are reported `cached_tokens` per generated turn.

### High-growth harness

The controlled high-growth setup used:

- `gpt-5.6-sol`;
- low reasoning and no reasoning summary;
- no model tools or resource files in the Pi run;
- a stable 9,299-byte system prompt;
- 10,549 bytes of inert user context added each turn;
- a required exact, short output such as `trajectory-01`;
- ten sequential turns;
- one cached WebSocket with a valid response-ID continuation chain.

| Client/request variant                | Cached-token trajectory                                            | Result                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Pi ordinary, before affinity metadata | `0, 3840, 5888, 0, 9984, 12032, 0, 16128, 18176, 20224`            | Prefix grew by roughly 2,048 tokens per turn, but turns 4 and 7 were full misses.       |
| Pi Responses Lite, before metadata    | `0, 3840, 5888, 7936, 9984, 0, 14080, 12032, 18176, 20224`         | Turn 6 was a full miss; turn 8 regressed to an older 12,032-token prefix.               |
| Pi ordinary, routing hint only        | `0, 0, 0, 3840, 9984, 5888, 12032, 16128, 14080, 20224`            | Routing hint alone still allowed full and stale-prefix regressions.                     |
| Pi ordinary, installation/window/hint | `0, 0, 5888, 7936, 9984, 12032, 14080, 16128, 18176, 20224`        | Monotonic after caching began on turn 3.                                                |
| Official Codex app-server control     | `0, 15104, 18176, 20224, 22272, 24320, 26368, 28416, 30464, 32512` | Monotonic after turn 1, with approximately 2,048 additional cached tokens on each turn. |

The official control used the same base-instruction and per-turn user text, but its normal built-in tools and environment context remained enabled. Absolute token totals are therefore not directly comparable; monotonicity and per-turn growth are the useful comparison.

### Harness-normalized follow-up

The follow-up used three independent ten-turn trials per client with:

- exactly 9,299 bytes of base instructions;
- exactly 10,549 bytes in every user turn;
- a per-run isolation value near the start of the base instructions;
- low reasoning, no reasoning summary, low text verbosity, and no selected service tier;
- exact short outputs;
- alternating client order;
- a persistent installation ID but a new session/thread/cache key per trial.

| Client/request shape                     | Trial | Cached-token trajectory                                              |
| ---------------------------------------- | ----- | -------------------------------------------------------------------- |
| Pi Responses Lite, no tools              | 1     | `0, 0, 3840, 5888, 7936, 9984, 14080, 16128, 18176, 20224`           |
| Pi Responses Lite, no tools              | 2     | `0, 3840, 0, 5888, 9984, 12032, 14080, 16128, 7936, 20224`           |
| Pi Responses Lite, no tools              | 3     | `0, 0, 3840, 7936, 9984, 5888, 12032, 14080, 16128, 18176`           |
| Official Codex, minimized environment    | 1     | `0, 6912, 11008, 13056, 0, 15104, 17152, 19200, 23296, 25344`        |
| Official Codex, minimized environment    | 2     | `0, 0, 0, 11008, 15104, 17152, 19200, 21248, 23296, 25344`           |
| Official Codex, minimized environment    | 3     | `0, 6912, 11008, 13056, 15104, 17152, 19200, 21248, 23296, 25344`    |
| Official Codex, stock tools/environment  | 1     | `3840, 9984, 14080, 16128, 18176, 20224, 22272, 24320, 26368, 28416` |
| Official Codex, stock tools/environment  | 2     | `3840, 9984, 14080, 16128, 18176, 20224, 22272, 24320, 26368, 28416` |
| Official Codex, stock tools/environment  | 3     | `3840, 3840, 14080, 16128, 18176, 20224, 22272, 24320, 26368, 28416` |
| Codex request shape through Pi transport | 1     | `3840, 9984, 12032, 14080, 16128, 18176, 20224, 22272, 24320, 26368` |
| Codex request shape through Pi transport | 2     | `3840, 9984, 12032, 14080, 16128, 18176, 20224, 22272, 24320, 26368` |
| Codex request shape through Pi transport | 3     | `3840, 9984, 12032, 14080, 3840, 18176, 20224, 22272, 24320, 26368`  |

The minimized official arm was useful for disproving immunity but was not a byte-identical no-tool control. A direct wire capture found three remaining wrapper/namespace tool entries, and its prewarm and generated-turn tool JSON differed, causing the captured generated request to bypass `previous_response_id`. It must not be used to attribute differences to transport.

The stock arm captured the actual official behavior:

- prewarm used Responses Lite with `generate: false`;
- `additional_tools` contained four direct declarations totaling 23,345 JSON bytes;
- the generated request reused the prewarm response ID;
- five dynamic input messages followed the prewarmed prefix;
- the stable tool prefix preceded the per-run-isolated base instructions.

This explains the visual difference. Stock Codex trial 3 did not extend its deeper cached prefix on turn 2, but its large prewarmed/shared prefix still reported 3,840 cached tokens. A comparable Pi request with a much smaller static prefix can report zero for the same class of backend miss.

The exact-shape replay retained Codex's captured tool declarations and initial context while using this package's `CodexTransport`. Its one regression landed on the same 3,840-token floor. That result isolates provider prompt construction from transport and shows that the current WebSocket continuation implementation can reproduce Codex's cache trajectory when given Codex's model-visible prefix.

### Earlier low-growth runs

Small prompts often remained inside one reported cache block for several turns:

| Variant      | Run | Cached-token trajectory                                              |
| ------------ | --- | -------------------------------------------------------------------- |
| Pi ordinary  | A   | `0, 0, 2816, 2816, 2816, 2816, 3840, 3840, 3840, 3840`               |
| Pi Lite      | A   | `0, 2816, 2816, 2816, 2816, 0, 0, 3840, 3840, 3840`                  |
| Pi ordinary  | B   | `0, 6912, 7936, 7936, 7936, 7936, 7936, 7936, 7936, 7936`            |
| Pi Lite      | B   | `0, 6912, 0, 7936, 7936, 7936, 7936, 7936, 0, 7936`                  |
| Official Sol | —   | `3840, 8960, 11008, 11008, 11008, 11008, 11008, 11008, 11008, 11008` |

These runs show why “cache reads are not increasing” was initially plausible but incomplete: token accounting is quantized, while the full misses remain visible as zeros.

## End-to-end request comparison

### Shared logical request

Both ordinary Responses and Responses Lite now send or derive:

- `model`;
- `store`;
- `stream`;
- full logical conversation `input`;
- `tool_choice`;
- `parallel_tool_calls`;
- `reasoning`;
- `include: ["reasoning.encrypted_content"]`;
- `service_tier` only when selected;
- `prompt_cache_key`;
- `text`;
- `client_metadata`;
- an explicit ordinary `tools` array, including `[]`;
- no default-only `reasoning.mode`.

Official Codex sends base `instructions` on every **ordinary logical request**. That is intentional and source-confirmed. WebSocket continuation can still avoid retransmitting old conversation input by sending only the input delta with `previous_response_id`; the other request properties remain part of the logical request and are checked for continuation compatibility.

### Ordinary Responses

- Base instructions remain in top-level `instructions`.
- Tools remain in top-level `tools`, including an empty array.
- `parallel_tool_calls` follows model/tool capability.
- The reasoning context field is omitted so the Responses default applies.
- Prewarm uses the same static request properties with empty `input` and `generate: false`.

### Responses Lite

- Top-level instructions become a leading developer message.
- Top-level tools become a leading `additional_tools` developer item.
- Top-level `instructions` and `tools` are omitted.
- `parallel_tool_calls` is `false`.
- `reasoning.context` is `"all_turns"`.
- Input-image `detail` is omitted.
- HTTP/SSE carries `x-openai-internal-codex-responses-lite: true`.
- WebSocket carries the equivalent
  `client_metadata.ws_request_header_x_openai_internal_codex_responses_lite = "true"`.
- Prewarm sends only the `additional_tools` and developer-instruction prefix with
  `generate: false`; the first generated request continues from that response ID with dynamic input.

Installed Codex `0.146.0` serializes direct `function` and `custom` declarations directly inside `additional_tools` and preserves real namespace declarations. Current upstream changed this in `f21dc46388`, “Canonicalize default tools under the `functions` namespace”: it now groups flat declarations exactly as this extension does and normalizes missing, empty, and explicit `functions` call identities. The extension follows current upstream and is intentionally not byte-identical to the older installed CLI's static tool prefix.

Responses Lite therefore changes where the stable prefix is represented, but it does not guarantee a different cache-placement policy. Its practical stock-Codex advantage in these runs came from placing a very large, reusable tool prefix before base instructions.

## Cache and routing identities

For a root Pi session, `session_id`, `thread_id`, `prompt_cache_key`, and the relevant session/thread headers use the same stable Pi session UUID, subject to the API's 64-character cache-key limit.

### `client_metadata`

The extension now sends the official flat projections:

- `x-codex-installation-id`: a stable UUID persisted across Pi sessions;
- `session_id`;
- `thread_id`;
- `turn_id`;
- `x-codex-window-id`, initially `<thread-id>:0`;
- `x-codex-turn-metadata`, a JSON snapshot.

The turn-metadata snapshot includes:

- `installation_id`;
- `session_id`;
- `thread_id`;
- `turn_id`;
- `window_id`;
- `request_kind`: `prewarm`, `turn`, or `compaction`;
- `thread_source: "user"` for normal Pi sessions;
- `sandbox: "none"`, reflecting the extension's actual execution model;
- `turn_started_at_unix_ms`.

The window number advances after a successful native compaction. Pi still does not collect Codex's per-turn workspace Git metadata or represent all Codex subagent/fork lineage.

### HTTP/SSE headers

The first-party Responses request carries:

- `session-id`;
- `thread-id`;
- `x-codex-window-id`;
- `x-codex-turn-metadata`;
- `x-client-request-id`, equal to the thread id;
- `x-codex-routing-hint`;
- `x-codex-turn-state` after the server provides it during the current agent turn;
- the Responses Lite marker when Lite is enabled.

Official Responses HTTP sets `x-client-request-id` to the thread id. The extension does the same and reports cache affinity as aligned only when `prompt_cache_key`, `session-id`, `thread-id`, and `x-client-request-id` all agree.

### WebSocket handshake and body

The handshake carries:

- `session-id`;
- `thread-id`;
- `x-client-request-id`;
- `x-codex-window-id`;
- `x-codex-turn-metadata`;
- `x-codex-routing-hint`;
- the Responses WebSocket beta header.

Each `response.create` body carries `client_metadata`. Turn state is replayed in WebSocket client metadata once received. The routing hint is a handshake header:

```text
model=<model>
model=<model>;tier=<service-tier>
```

The hint is sent only on this package's first-party `openai-codex` Responses path. It is not added to sibling image-generation or standalone-search requests.

The live 0.146 capture also found non-model-visible metadata differences. The extension now matches
the first three captured fields:

- prewarm uses an empty-string `turn_id`;
- prewarm omits `turn_started_at_unix_ms`;
- every WebSocket body includes `x-codex-ws-stream-request-start-ms`;

Other differences remain:

- official Code Mode included a large `code_mode_tool_names` map in turn metadata;
- the captured official sandbox label was `seatbelt`, while the extension accurately reports Pi's unsandboxed execution as `none`;
- the official handshake included client-specific `version`, `originator`, and beta-feature headers and, as expected for 0.146, no post-release routing hint.

These fields remain compatibility differences, but the exact-shape replay replaced official identity metadata and handshake headers with Pi's while retaining the official model-visible prefix. It still reproduced the stock cache trajectory and static-floor regression, so the captured metadata differences do not explain the main gap.

## WebSocket continuation and recovery

Both implementations:

- retain one healthy session WebSocket across turns;
- prewarm with `generate: false`;
- retain the completed response ID and output items;
- send `previous_response_id` plus only newly appended input when the next logical request is a strict extension;
- ignore `client_metadata` and response-delivery-only `stream_options` when deciding whether the previous response remains compatible;
- ignore internal chat-item passthrough metadata when comparing history items;
- fall back to full context when request properties or history change;
- retry retryable stream failures with 200 ms exponential backoff and ±10% jitter;
- use a five-retry stream budget by default;
- make HTTP fallback sticky for the session after WebSocket retry exhaustion.

The extension additionally records the exact response ID, turn state, request mode, cache identity, request sizes, and retry sequence in the Pi assistant message diagnostics.

After aligning current upstream's default `functions` namespace, live Lite function-tool turns
preserved the server's flat default call identity. Subsequent requests remained WebSocket deltas
containing only the tool result and new user message. Adding `namespace: "functions"` to those
replayed calls had previously caused a local history-prefix mismatch despite equivalent tool
identity.

The extension still fails closed on transport failures after model-visible output because retrying the same transport request could duplicate text or tool calls. Explicit retryable `response.failed` and `response.incomplete` terminals return to a provider-owned sampling loop instead: completed native output items are appended to the next logical request, unfinished attempt content is excluded, and usage is accumulated. `response.completed.end_turn: false` uses the same history-preserving loop without consuming the retry budget or adding synthetic input.

## SSE behavior

- SSE always sends full logical context; it does not use `previous_response_id`.
- Request-body compression is zstd when the Node runtime supports it.
- The same prompt-cache/session/account/installation/window identities survive WebSocket-to-SSE fallback.
- A retryable HTTP failure or dropped SSE stream is resampled up to five times only when no model-visible output has been emitted.
- A protocol error or a drop after visible output fails closed.

## What most likely explained the cache gap

The evidence supports a model-visible-prefix plus backend-variance explanation:

1. The Pi request prefix was valid because cache reads grew by the expected block size on successful turns.
2. A valid WebSocket continuation did not prevent a zero or stale-prefix read, so `previous_response_id` alone was not sufficient to guarantee cache locality.
3. Official Codex itself produced a full zero-cache turn after earlier hits when its static prefix was reduced.
4. Stock Codex's 23,345-byte tool declaration prefix created a 3,840-token floor that masked deeper misses.
5. The exact Codex request shape produced equivalent behavior through the Pi transport.
6. Responses Lite changed prompt representation but did not stabilize locality when the tool prefix was empty or small.
7. Installation/window/routing identity may still influence placement, but repeated post-change regressions show that the earlier one-run improvement did not establish causality.

Backend load, asynchronous cache propagation, account routing, and cache eviction remain unobservable from the client. The controlled runs do rule out the stronger claims that official Codex never misses or that Pi's WebSocket continuation is intrinsically unable to reproduce Codex's trajectory.

## Remaining differences that can affect absolute cache totals

- Pi and Codex have different system prompts, developer context, built-in tools, and tool schemas.
- Official Codex enriches turn metadata with Git workspace state; Pi currently does not.
- Official Codex owns parent/subagent lineage beyond Pi's host model. The extension persists branch-specific `/tree` thread UUIDs and `forked_from_thread_id` while retaining the root session/cache identity, and sends the same nested Responses Compaction v2 trigger, reason, implementation, phase, and strategy fields for Pi manual, threshold, provider-boundary, and overflow compaction.
- Installed Codex `0.146.0` uses direct function/custom declarations; current upstream and this extension use the canonical `functions` namespace.
- The stock official tool prefix and initial permissions/team/plugin context are substantially larger than Pi's no-tool comparison harness.
- Official model metadata controls Responses Lite automatically; this package keeps it behind the default-off `responsesLite` setting.
- Official Codex can enable sequential-cutoff reasoning-summary delivery through `stream_options`.
- Official Codex owns its retrying sampling loop directly. The extension now reproduces protocol-terminal and `end_turn: false` resampling from completed output, but transport failures after visible output still fail closed.
- Official Codex defaults to four lower-level HTTP request retries in addition to five stream resamples. Pi keeps its provider-level request budget under `retry.provider.maxRetries` (default `0`); this extension adds the five safe pre-output stream resamples without overriding that Pi setting.
- Codex attestation, originator/version headers, and some feature headers are client-specific and are not reproduced.
- Pi's canonical session/history model is not Codex's rollout store.

No explicit prompt-cache breakpoint was found in the inspected official source, and this extension intentionally does not add one.

## Pending validation

Next validation:

1. Repeat the three-way stock-Codex, Pi-host, and exact-shape transport trials against the same Codex source version; installed `0.146.0` and current upstream have different default-tool prefixes.
2. Compare equivalent tool-prefix byte sizes and initial-context ordering, not a no-tool Pi request against stock Codex.
3. Repeat after a deliberate WebSocket failure and after compaction to verify affinity survives transport and window transitions.
4. Keep tracking zero misses, stale-prefix regressions, and static-floor fallback separately.
