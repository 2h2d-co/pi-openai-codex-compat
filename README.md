# pi-openai-codex-compat

OpenAI Codex compatibility for [Pi](https://github.com/earendil-works/pi-mono), combining priority fast mode, native Codex compaction, and Codex-optimized model features in one Pi package.

## Features

- **Request-level fast mode**: keeps the canonical `openai-codex` provider id and models selected while adding `service_tier: "priority"` at the request boundary.
- **Native compaction**: uses Codex `remote_compaction_v2` for `/compact`, Pi threshold compaction, context-overflow recovery, and an optional percentage threshold.
- **Codex `apply_patch`**: provides an optional patch tool with the Codex grammar, parser, fuzzy matcher, overwrite semantics, filesystem behavior, model-facing result format, structured history, and diff-oriented TUI rendering. Pi sends it as an OpenAI custom grammar tool when the model supports that protocol and as a normal function tool otherwise.
- **Standalone image generation**: exposes Pi's dotted `image_gen.imagegen` tool as a native Responses namespace and executes generation or edits through the Codex Images endpoints.
- **Standalone web search**: exposes Pi's dotted `web.run` tool as a native Responses namespace and executes search and browsing through Codex `alpha/search`.
- **Dedicated Codex tool UI**: renders `apply_patch`, `image_gen.imagegen`, and `web.run` on a shared configurable surface with compact summaries and `Ctrl+O` expansion.
- **Hosted web-search fallback**: injects native `web_search` only when `web.run` is inactive, with cached, indexed, or live modes.
- **Native request controls**: configures Responses API text verbosity, reasoning summaries, and GPT-5.6 standard/pro reasoning mode.
- **Session-local settings pane**: `/codex-settings` changes every compatibility setting for the current session; `Enter` persists and closes, `Escape` discards unsaved changes and closes, and `Ctrl+S` persists without closing.
- **Compact footer indicators**: non-default Codex request modes are appended to the model side of Pi's normal second footer line.

Pi provides the Codex OAuth flow and model catalog. At session start, this package overrides the built-in `openai-codex` runtime under the same provider id so ordinary responses and remote compaction share one transport, parser, native-history store, and sticky WebSocket session.

## Requirements

- Node.js 22.19 or newer
- Pi `>=0.84.0 <0.85.0`
- An OpenAI Codex login in Pi

Authenticate through Pi if needed:

```text
/login openai-codex
```

## Compatibility baseline and differences

The compatibility baseline is official Codex CLI `0.149.0`, released August 20, 2026, at commit `758ef40f50c1a458425c7cfbf1eb12cbc07af0b0`. It retains the `0.147.0` Responses Lite contract that groups direct function and custom declarations into one canonical `functions` namespace for namespace-capable providers. The `0.148.0`–`0.149.0` review adopted typed misalignment-policy failures while recording official unbounded connection recovery as an intentional bounded-transport deviation. The [official release compatibility log](OFFICIAL_CODEX_CLI_RELEASES.md) is the canonical release-by-release record of protocol and `apply_patch` alignment, intentional deviations, and excluded runtimes. This section is the package's user-facing compatibility contract. See the [Responses Lite compatibility report](RESPONSES_LITE_COMPATIBILITY.md) and [Codex caching and transport comparison](CODEX_CACHE_RESEARCH.md) for detailed request-path findings and live cache trajectories.

### Configurable defaults that differ from Codex

| Area                                          | This package by default                                                                                                                           | Official Codex                                                                                                                                | Configuration                                                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generated-image detail sent back to the model | Sends image tool-result content with `input_image.detail: "auto"`. On GPT-5.6, `auto` uses original-size image accounting.                        | Uses `high`.                                                                                                                                  | `imageDetail`: `auto`, `low`, `high`, or `original`.                                                                                                                        |
| Image-generation tool                         | Enabled whenever an `openai-codex` model is selected. Backend capability and account failures surface when the tool executes.                     | Stable and enabled by default, but additionally gated by plan, model, provider, authentication, image-generation, and namespace capabilities. | `imageGeneration`: boolean.                                                                                                                                                 |
| Standalone `web.run`                          | Disabled by default; when enabled, preferred over hosted `web_search` and sent with the complete reserved schema and description.                 | Enabled by default for `gpt-5.6-sol` through Responses Lite; otherwise subject to standalone-search feature and runtime gates.                | `webRun`: boolean.                                                                                                                                                          |
| Hosted web search                             | Disabled by default; when enabled, injected only for ordinary Responses while `web.run` is inactive. Responses Lite omits hosted tools.           | Omitted for `gpt-5.6-sol` while standalone `web.run` is available; otherwise defaults to cached mode when hosted search is supported.         | `webRun` and `webSearch`: `disabled`, `cached`, `indexed`, or `live`.                                                                                                       |
| Coding mutation tools                         | Enables `apply_patch` and suppresses Pi's active `edit` and `write` tools.                                                                        | Chooses its tool surface from model metadata and runtime capabilities; there are no Pi `edit` or `write` tools to suppress.                   | `applyPatch`: boolean.                                                                                                                                                      |
| `apply_patch` debug output                    | Disabled; collapsed results show the normal visual summary and instruction rows.                                                                  | Not applicable to Pi's tool-result renderer.                                                                                                  | `applyPatchDebug`: boolean.                                                                                                                                                 |
| Codex tool background                         | Uses a subtle theme-derived surface for extension-owned Codex tools.                                                                              | Uses Codex's own TUI activity cells rather than Pi tool rows.                                                                                 | `toolBackground`: `subtle`, `status`, or `none`.                                                                                                                            |
| Auto-compaction trigger                       | Relies on Pi's reserve-token threshold unless a percentage is configured.                                                                         | Tracks Codex's model/token-budget state before and between sampling steps.                                                                    | `autoCompactAtPercent`: percentage or unset. Mid-response percentage boundaries use Pi's bounded compact-and-continue lifecycle, so Pi auto-compaction must remain enabled. |
| Fast mode                                     | Uses the normal tier.                                                                                                                             | Uses the configured Codex service tier.                                                                                                       | `fastMode`: boolean; `true` requests the priority tier.                                                                                                                     |
| Responses Lite                                | Disabled; supported GPT-5.6 models use ordinary Responses.                                                                                        | Enabled according to Codex model metadata.                                                                                                    | `responsesLite`: boolean; `true` enables Responses Lite.                                                                                                                    |
| Text and reasoning request controls           | Sends low text verbosity and automatic reasoning summaries; omits the default GPT-5.6 standard mode and sends `reasoning.mode` only for pro mode. | Resolves these controls through Codex configuration, model metadata, and turn state.                                                          | `textVerbosity`, `reasoningSummary`, and `reasoningMode`.                                                                                                                   |

`web.run` is a reserved GPT-5.6 tool name. Its declaration therefore reproduces the complete current Codex post-normalization `SearchCommands` schema and official tool description instead of using Pi's normal compact tool schema. This intentionally omits generated annotations such as `format` and `minimum` that Codex removes before sending the declaration to Responses.

### Non-configurable implementation differences

| Area                        | Difference                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Session storage             | Pi remains the canonical session owner. Opaque Codex compaction checkpoints are stored in Pi `compaction` entries, and otherwise lossy Responses output is stored in sparse custom native-response entries. Official Codex owns a rollout/thread store directly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Branching                   | Checkpoints and native response overrides follow Pi's active session branch. Official Codex uses its own thread, turn, rollback, fork, and context-window lineage.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Model switching             | This package rejects model switches while the active Pi branch contains a native Codex checkpoint because the checkpoint is model-specific.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| System instructions         | Pi rebuilds the current system prompt. Responses Lite models prepend it as developer input after `additional_tools`; other models send it through Responses `instructions`. Normal Pi history does not store it as replayed system/developer input. `/reload` updates the next request without rewriting old checkpoints.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Turn metadata               | Requests send a persisted installation id plus Pi-derived session, thread, context-window, turn, source, sandbox, request-kind, and nested compaction-operation metadata in `client_metadata` and compatible headers. The in-memory context-window number advances after successful compaction. One turn id is reused throughout a Pi agent run, while prewarm has its own id. First-party requests also carry Codex's model-and-tier routing hint. The provider captures the server-issued `x-codex-turn-state` once per agent run, replays it on WebSocket retries, SSE requests, and WebSocket-to-SSE fallback, and records all identity values in transport diagnostics. Pi does not reconstruct prior window number after extension reload/session resume or reproduce workspace Git/parent/subagent/Code Mode metadata. Each marked Pi tree branch receives its own persisted thread UUID. |
| Cache preparation           | Before the first cache-enabled WebSocket turn, the package prewarms only the stable instruction/tool prefix: ordinary Responses uses empty `input`, while Responses Lite uses `additional_tools` plus the developer instructions. The first generated request then contributes only dynamic conversation input to the continuation. No explicit prompt-cache breakpoints are added.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Mid-turn compaction         | Provider-boundary percentage compaction preserves a successful `end_turn:false` prefix as its own Pi assistant message, installs a checkpoint, and continues without synthetic model input. Pi threshold compaction normally runs after the agent response; after Codex output-token truncation, the extension queues a hidden continuation so threshold compaction completes before sampling resumes. Official Codex owns this sampling and compaction loop directly.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Provider-owned follow-up    | Completed responses with `end_turn: false` continue immediately from completed native output without synthetic user input. Retryable `response.failed` and all `response.incomplete` events are resampled with the official five-retry stream budget, preserving completed output and cumulative usage while excluding unfinished attempt content. A `max_output_tokens` response that exhausts this budget still becomes Pi `stopReason: "length"` and uses the extension's unbounded host-level continuation recovery.                                                                                                                                                                                                                                                                                                                                                                         |
| Transport recovery          | WebSocket failures before model-visible output receive five fresh-connection retries before sticky SSE fallback; SSE transport failures receive five retries. Official Codex `0.149.0` separately retries sampling connection-establishment failures indefinitely with delays capped at 60 seconds. The package remains bounded because Fetch does not expose Reqwest's narrower connection-error category, and a phase-only approximation could indefinitely repeat requests that reached the server.                                                                                                                                                                                                                                                                                                                                                                                           |
| Compaction lifecycle events | Pre-turn percentage compaction writes through Pi's mutable session manager and cannot emit Pi's internal `session_compact` event through the public extension API. Mid-response percentage boundaries and manual, threshold, or overflow compactions initiated by Pi emit the normal lifecycle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Header hooks                | An internal percentage-compaction request reuses the already transformed provider headers. It cannot independently rerun Pi's `before_provider_headers` hook.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Native retained context     | Deliberately differs from current Codex. The package retains recent user/developer/system messages under the 64k budget before the opaque compaction item. Current Codex applies a second installed-history filter that drops developer/system wrappers and non-real-user messages, can retain eligible structured agent commentary, and trims oversized function outputs before compaction. Pi keeps its existing checkpoint shape by design.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Tool namespaces             | Responses Lite groups Pi's ordinary function/custom declarations into upstream's canonical `functions` namespace and maps that default namespace back to bare Pi names. Pi registers dotted names such as `web.run` as exact flat identifiers, so the provider converts only the fixed extension-owned allowlist into non-default Responses namespace/member identities and rejects unknown or ambiguously flat namespaced calls.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Capability gating           | Tool activation is based on the selected `openai-codex` provider plus package settings. It does not reproduce every official model-metadata, plan, feature-stage, executor, mode, or account gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Sandbox and approvals       | Pi extensions run with full process permissions. `apply_patch`, local image reads, generated-image writes, and sibling Codex endpoints do not use Codex's sandbox, permission-profile, or approval lifecycle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Image tool instructions     | The package retains the server-reserved image-generation schema while replacing Rust-specific path annotations and Codex Code Mode instructions with model-facing descriptions, a prompt snippet, and system-prompt guidelines. Image-count bounds and selector exclusivity are enforced before execution.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Image artifact hint         | When image saving succeeds, this package always returns the path hint, says “the generated image,” and has no 1,024-byte cutoff. Official Codex says “a generated image” and omits the hint when it exceeds 1,024 UTF-8 bytes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Image artifacts             | Generated files use Pi's agent directory and the Pi session/tool-call IDs. Official Codex uses its own artifact/output-directory lifecycle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Web references              | `web.run` structured results are retained branch-locally in Pi tool-result details rather than Codex extension events, and hosted native items are preserved for provider replay. Reference IDs are resolved remotely by `alpha/search`, as in Codex. Hosted citation annotations remain a separate unimplemented path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| UI                          | Pi renders its own conversation, footer, settings pane, branches, and compaction lifecycle. Extension-owned Codex tools have dedicated Pi renderers, but do not reproduce Codex app-server `WebSearchItem` or image-generation lifecycle notifications.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

Nested compaction metadata uses the official Responses Compaction v2 implementation and memento
strategy. Manual compaction is user-requested and standalone; threshold and provider-boundary
compaction are automatic context-limit operations in the pre-turn phase; overflow recovery is the
corresponding mid-turn operation.

When a finalized user prompt creates a new `/tree` branch, the extension inserts a hidden,
context-free custom marker as that prompt's parent. Navigation alone writes nothing. The marker is
hidden by Pi's default, no-tools, and user-only tree filters and appears only in the all-entries
filter. Root `session_id` and `prompt_cache_key` remain stable, while the branch gets a UUID
`thread_id`, `forked_from_thread_id`, and thread-scoped window number. Switching threads closes the
old WebSocket and discards its incompatible `previous_response_id` baseline; the new full-history
request remains eligible to reuse the common backend-cached prefix under the unchanged cache key.

### Tool and runtime coverage

The package implements the Codex-specific pieces that fit a provider compatibility extension:

- native Responses transport and history;
- remote compaction v2;
- `apply_patch`;
- hosted `web_search`;
- `web.run`;
- `image_gen.imagegen`;
- namespaced tool serialization;
- text verbosity, reasoning summaries/mode, and priority service tier.

The following official Codex facilities are not exact equivalents in this package:

| Official Codex facility                                                 | Pi/package behavior                                                                                                                                              |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exec_command` and `write_stdin` persistent PTY sessions                | Pi `bash` is a one-shot command tool; no persistent PTY/session protocol is implemented.                                                                         |
| Legacy `shell_command`                                                  | Pi uses `bash`; the Codex schema and execution/approval envelope are not reproduced.                                                                             |
| `view_image`                                                            | Pi `read` already accepts images; no canonical `view_image` alias is registered.                                                                                 |
| `update_plan`, `request_user_input`, permissions, and environment tools | Not implemented by this package.                                                                                                                                 |
| Context-window and clock tools                                          | Not implemented. Compaction remains host/provider managed rather than model managed.                                                                             |
| MCP resources and dynamic MCP tools                                     | Pi does not provide this package with Codex's MCP runtime.                                                                                                       |
| Plugin/connector installation                                           | Not implemented; package installation remains an explicit Pi/user operation.                                                                                     |
| Searchable `tool_search` catalog                                        | Pi can replay additive tool-search history for capable models, but this package does not implement Codex's searchable deferred-tool catalog and ranking runtime. |
| Multi-agent V1/V2 coordination                                          | Out of scope; no Codex agent tree, mailbox, task-path, or fork-depth runtime is implemented.                                                                     |
| JavaScript Code Mode and yielded cells                                  | Out of scope; no V8 isolate, nested tool namespace, cell storage, or `wait` lifecycle is implemented.                                                            |
| Goals, memories, and remote skill-resource tools                        | Not implemented; Pi's sessions, files, and native skills remain separate systems.                                                                                |
| Remote/deferred execution environments                                  | Not implemented.                                                                                                                                                 |

See [`OFFICIAL_CODEX_CLI_TOOL_CATALOG.md`](OFFICIAL_CODEX_CLI_TOOL_CATALOG.md) for the complete researched Codex tool inventory, and [`CUSTOM_CODEX_PROVIDER_WEB_REFERENCES.md`](CUSTOM_CODEX_PROVIDER_WEB_REFERENCES.md) for the unimplemented citation/reference design.

## Install

From npm after a release is published:

```bash
pi install npm:pi-openai-codex-compat
```

From a local checkout:

```bash
pi install .
```

For a temporary development run:

```bash
pi --no-extensions -e .
```

## Fast mode

Keep using an `openai-codex` model and enable **Fast mode** in `/codex-settings`. The extension adds `service_tier: "priority"` to ordinary and native-compaction requests without introducing another provider id or changing the selected model.

Fast mode applies to whichever built-in `openai-codex` model is selected. Priority-tier costs are reflected in Pi's usage totals, including when Codex echoes `service_tier: "default"` in its response.

## Configuration

Create a global configuration file at:

```text
~/.pi/agent/openai-codex-compat.json
```

The extension also creates `openai-codex-compat-installation-id` in the active Pi agent directory. It contains the stable UUID used for official Codex installation metadata and is reused across sessions.

A trusted project can override it at:

```text
<project>/.pi/openai-codex-compat.json
```

Each session inherits the effective file-backed settings. Open `/codex-settings` to make immediate session-local changes. Press `Enter` to persist and close, `Escape` to discard unsaved changes and close, or `Ctrl+S` to persist without closing. The global file is the normal save target, while an existing trusted project override remains the target for that project. After `Ctrl+S`, later unsaved changes can still be discarded back to the values from that save.

The effective settings are printed once when a TUI session starts. The footer shows `fast` and `pro` only when enabled, and shows text verbosity or reasoning summary only when they differ from their defaults.

Example:

```json
{
  "fastMode": true,
  "responsesLite": true,
  "toolBackground": "subtle",
  "applyPatch": true,
  "applyPatchDebug": false,
  "imageGeneration": true,
  "imageDetail": "auto",
  "webRun": false,
  "autoCompactAtPercent": 90,
  "webSearch": "disabled",
  "textVerbosity": "low",
  "reasoningSummary": "auto",
  "reasoningMode": "standard"
}
```

Defaults:

| Setting                | Values                                               | Default    | Behavior                                                                                                                                                                                                                                  |
| ---------------------- | ---------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fastMode`             | boolean                                              | `false`    | Adds `service_tier: "priority"` to requests while retaining the current `openai-codex` provider and model.                                                                                                                                |
| `responsesLite`        | boolean                                              | `false`    | Uses Codex's Responses Lite input envelope on supported GPT-5.6 models when enabled. By default, those models use ordinary Responses instructions and tools.                                                                              |
| `toolBackground`       | `subtle`, `status`, `none`                           | `subtle`   | Controls the shared self-rendered background for `apply_patch`, `image_gen.imagegen`, and `web.run`. `status` uses Pi's pending/success/error backgrounds; `none` keeps the custom layout transparent.                                    |
| `applyPatch`           | boolean                                              | `true`     | On selected `openai-codex` models, uses the extension's `apply_patch` tool instead of Pi's active `edit` and `write` tools. Other providers always use their normal Pi tool set.                                                          |
| `applyPatchDebug`      | boolean                                              | `false`    | Shows the exact model-facing tool result while a completed `apply_patch` result is collapsed. Expanded results continue to show the normal visual summary and complete diffs.                                                             |
| `imageGeneration`      | boolean                                              | `true`     | Enables the extension-owned `image_gen.imagegen` tool on selected `openai-codex` models.                                                                                                                                                  |
| `imageDetail`          | `auto`, `low`, `high`, `original`                    | `auto`     | Sets `input_image.detail` when an image tool result is sent back to the model. It does not change `gpt-image-2` generation quality.                                                                                                       |
| `webRun`               | boolean                                              | `false`    | Enables the extension-owned `web.run` tool on selected `openai-codex` models. When active, it replaces hosted `web_search` in the Responses tool list.                                                                                    |
| `autoCompactAtPercent` | number greater than `0` and at most `100`, or `null` | unset      | Adds provider-boundary compaction independently of Pi's normal reserve-token threshold. Mid-response boundaries require Pi auto-compaction. A project value of `null` disables a global percentage threshold.                             |
| `webSearch`            | `disabled`, `cached`, `indexed`, `live`              | `disabled` | Controls hosted search and standalone-search external access. `disabled` removes hosted search but leaves an independently enabled `web.run` in cached-only mode; `indexed` prefers indexed content; `live` permits live external access. |
| `textVerbosity`        | `low`, `medium`, `high`                              | `low`      | Sets Responses API `text.verbosity`.                                                                                                                                                                                                      |
| `reasoningSummary`     | `auto`, `concise`, `detailed`, `off`                 | `auto`     | Sets `reasoning.summary` when reasoning is enabled; `off` omits the summary parameter.                                                                                                                                                    |
| `reasoningMode`        | `standard`, `pro`                                    | `standard` | Controls GPT-5.6 execution mode independently of Pi's reasoning-effort control. The default omits `reasoning.mode`; `pro` sends `reasoning.mode: "pro"`.                                                                                  |

Invalid JSON setting values are ignored and invalid JSON does not prevent Pi from starting. The settings pane never writes on ordinary changes, refuses to overwrite invalid JSON when `Enter` or `Ctrl+S` attempts to save, and retains unknown keys when saving. Project configuration is read only when the project is trusted.

Every setting can also be overridden for one Pi process with an environment variable:

| Setting                | Environment variable                             |
| ---------------------- | ------------------------------------------------ |
| `fastMode`             | `PI_OPENAI_CODEX_COMPAT_FAST_MODE`               |
| `responsesLite`        | `PI_OPENAI_CODEX_COMPAT_RESPONSES_LITE`          |
| `toolBackground`       | `PI_OPENAI_CODEX_COMPAT_TOOL_BACKGROUND`         |
| `applyPatch`           | `PI_OPENAI_CODEX_COMPAT_APPLY_PATCH`             |
| `applyPatchDebug`      | `PI_OPENAI_CODEX_COMPAT_APPLY_PATCH_DEBUG`       |
| `imageGeneration`      | `PI_OPENAI_CODEX_COMPAT_IMAGE_GENERATION`        |
| `imageDetail`          | `PI_OPENAI_CODEX_COMPAT_IMAGE_DETAIL`            |
| `webRun`               | `PI_OPENAI_CODEX_COMPAT_WEB_RUN`                 |
| `autoCompactAtPercent` | `PI_OPENAI_CODEX_COMPAT_AUTO_COMPACT_AT_PERCENT` |
| `webSearch`            | `PI_OPENAI_CODEX_COMPAT_WEB_SEARCH_MODE`         |
| `textVerbosity`        | `PI_OPENAI_CODEX_COMPAT_TEXT_VERBOSITY`          |
| `reasoningSummary`     | `PI_OPENAI_CODEX_COMPAT_REASONING_SUMMARY`       |
| `reasoningMode`        | `PI_OPENAI_CODEX_COMPAT_REASONING_MODE`          |

Environment variables have the highest precedence: defaults < global JSON < trusted-project JSON < environment. Boolean values accept `true`/`false`, `1`/`0`, `on`/`off`, or `enabled`/`disabled`. Other settings use the values in the defaults table; `PI_OPENAI_CODEX_COMPAT_AUTO_COMPACT_AT_PERCENT=off` and `PI_OPENAI_CODEX_COMPAT_AUTO_COMPACT_AT_PERCENT=default` explicitly select Pi's default compaction lifecycle.

Environment-controlled rows are marked `(env)` and locked in `/codex-settings`. Saving the pane does not copy their effective values into JSON, so CLI overrides remain transient. Invalid environment values fail fast with the variable name and accepted values.

For example:

```bash
PI_OPENAI_CODEX_COMPAT_WEB_RUN=off \
PI_OPENAI_CODEX_COMPAT_RESPONSES_LITE=off \
PI_OPENAI_CODEX_COMPAT_IMAGE_DETAIL=high \
PI_OPENAI_CODEX_COMPAT_AUTO_COMPACT_AT_PERCENT=90 \
pi
```

## Native compaction

The extension handles native compaction for `openai-codex`. It follows the Codex v2 flow:

1. Send normal Responses history followed by `{ "type": "compaction_trigger" }`.
2. Validate the returned opaque `compaction` item.
3. Retain approximately 64,000 tokens of recent user, developer, and system context.
4. Persist the opaque checkpoint in the Pi session and replay it on later requests.

Ordinary responses and compaction use the same extension-managed SSE/WebSocket transport. Before the first WebSocket turn for a session and model, the provider performs a best-effort v2 `generate: false` prewarm of the static instruction/tool prefix, then generates the dynamic conversation input from its continuation. With `responsesLite: false`, supported GPT-5.6 models use the ordinary Responses envelope and receive their own ordinary-prefix prewarm.

Healthy session WebSockets remain available until the server closes them or Pi tears down the session. Retryable WebSocket failures before model-visible output receive up to five fresh-connection retries before the session switches to sticky SSE. Retryable SSE HTTP failures and dropped streams receive up to five same-request resampling attempts before model-visible output. Both transports use Codex-style exponential backoff with ±10% jitter and preserve the same prompt-cache, session, account, installation, and window identities. Server metadata is not considered model-visible output, so a routing-state-only response can still be retried safely. Transport failures after model-visible output fail closed rather than risk duplicate text or tool calls. Explicit retryable `response.failed`/`response.incomplete` protocol terminals instead return to the provider-owned sampling loop, which preserves completed output items as the next request's history.

The provider stores a native response override only when Pi's canonical assistant representation cannot round-trip the provider output exactly; normal text, reasoning, and tool responses therefore do not duplicate session data. Native overrides are associated with canonical assistants by response id and replayed only when they are present on the active Pi branch.

Transparent prewarm, requests, continuation, and transport recovery are recorded in the resulting assistant message's `diagnostics` array in Pi's session JSONL:

- `codex_transport_prewarm` records whether static prewarm completed, established continuation state, and received turn state.
- `codex_transport_request` records the selected transport, full/delta input counts and byte sizes, exact session/account/cache/turn/response/routing-state identifiers, static-prefix and request-template fingerprints, instruction/tool fingerprints, cache affinity, and reported cache read/write token usage.
- `codex_transport_recovery` identifies fresh-WebSocket and SSE retries, rejected or locally bypassed continuations, and WebSocket-to-SSE recovery, including the exact triggering error, attempted request modes, and whether cache and account affinity were preserved.

Diagnostics intentionally retain exact request, cache-affinity, response, account, and server routing identifiers so a local Pi session file contains enough information to trace retries and cache behavior directly. Prompt and tool contents are still represented by byte counts and SHA-256 fingerprints rather than duplicated into every diagnostic.

Any model switch is rejected while the active branch contains a native Codex checkpoint because checkpoints are model-specific. Navigate to a branch before the checkpoint or start a new session before switching. Toggling fast mode does not change the model id or invalidate the checkpoint.

Native compaction fails closed for Codex models: a failed compaction is cancelled instead of silently replacing the opaque state with a local text summary. Other providers continue to use Pi's default compaction behavior. `/tree` branch summarization is intentionally not intercepted.

When the active branch has no native Codex checkpoint, Pi model switching remains available. Selecting a provider other than `openai-codex` disables `apply_patch`, `image_gen.imagegen`, and `web.run`, and restores the Pi `edit` and `write` tools that `apply_patch` suppressed. Switching back to an `openai-codex` model reapplies the current session settings.

## `apply_patch`

The package registers an `apply_patch` tool using the Codex patch format:

```text
*** Begin Patch
*** Update File: src/example.ts
@@
-old value
+new value
*** End Patch
```

While `applyPatch` is enabled and an `openai-codex` model is selected, the extension temporarily disables Pi's active `edit` and `write` tools. Turning the setting off or selecting another provider restores only the tools that were active before `apply_patch` replaced them.

Supported operations:

- add files;
- update files with ordered context chunks;
- delete files;
- update and move a file in one instruction;
- move regular files or symlink entries without content changes;
- evaluate repeated and aliased paths sequentially;
- anchor updates at the end of a file.

Compatibility behavior:

- `*** Add File` overwrites an existing file, matching Codex.
- `*** Move to` overwrites an existing destination, matching Codex.
- Hunk matching retries exact text, trailing-whitespace-insensitive text, fully trimmed text, and Codex's Unicode punctuation normalization.
- Matching stops after the official Codex-compatible line matcher. There is no Tree-sitter, Markdown-table, code-fence, formatter-reflow, candidate-ranking, or output-equivalence fallback.
- Move identity and context chunks must match before the entry is moved; chunkless moves remain byte-opaque.
- The parser accepts Codex's lenient marker whitespace, blank update-context lines, and direct heredoc wrappers.
- Empty and identity updates, identical adds, absent deletes, self-moves, and same-patch fulfilled moves succeed with concise `NO CHANGE` results. Inapplicable operations are `SKIPPED` only when later operations deterministically make every effect unobservable.
- Repeated identical adds use source-ordered virtual content and exact
  spelling, so an earlier add or move can satisfy a later add without a
  redundant replacement.
- State-dependent `NO CHANGE` results retain source-ordered execution
  checkpoints without rereading the filesystem. A checkpoint after an earlier
  failure is `NOT RUN`; empty updates, identity updates without moves, and
  chunkless lexical self-moves remain unconditional.
- Model-facing results retain the aggregate A/M/D summary. When any instruction is not applied or an applied instruction has feedback, they list every source-ordered instruction under `Patch instruction results:` as `N. [STATUS] operation`, without an instruction limit; ordinary all-applied results omit the ledger.
- Combined text updates and moves are labeled `Update & Move`; move-only operations remain `Move`.
- Replacement feedback always identifies the verified previous and resulting entry types. Symlink feedback also uses the raw target pathname stored in the symlink.
- Tool-result history stores per-file old/new content, display diffs, move destinations, overwrite information, per-instruction filesystem effects, and deterministic final-path inspection after runtime failures.
- Opaque moves and symlink deletions use path-only history, so binary bytes and link-target bytes are not serialized as textual deletions.
- The TUI retains Codex-style changed-file summaries and uses the same conditional instruction ledger; when present, `Ctrl+O` nests complete diffs beneath the instruction that produced them.
- With `applyPatchDebug` enabled, the tool title becomes `apply_patch (debug)` and a completed collapsed result shows the exact text returned to the model without an extra renderer-only heading; expanding it with `Ctrl+O` still shows the normal visual summary and complete diffs.
- Failed instruction feedback colocates its error, completed effects, and final path states without repeating patch text or using speculative language. Matching failures report the original context or expected-lines mismatch.

Filesystem behavior:

- Relative paths resolve from Pi's current working directory; absolute paths and `..` traversal are honored.
- `.git` paths are unrestricted.
- Text updates follow live symlinks; adds replace live or dangling symlinks without writing through them; deletes remove only the symlink; pure moves move the source symlink; and state-changing moves create a regular file at the destination without writing updated text through a source or destination symlink.
- Relative symlink targets, including targets containing `..`, resolve from
  the canonical directory containing the link even when the source or moved
  destination is reached through a symlink-parent alias.
- Entry-only operations and no-op updates do not dereference cyclic or inaccessible symlink targets during mutation-queue acquisition.
- Same-filesystem pure moves use native rename topology. Cross-filesystem moves copy through a temporary entry, create or replace the destination, and then unlink the source, producing an inode independent from remaining source hard links.
- Supplied identity or context chunks validate a pure move through the text matcher without rewriting the moved entry. A blank `@@` therefore requires valid UTF-8; omit chunks for arbitrary binary content.
- Strict edits preserve the matched region's local CRLF or mixed line endings.
- In-place text updates use a direct path write, following source symlinks and
  preserving normal hard-link visibility.
- Adds and text updates verify the complete expected final byte buffer
  byte-for-byte before succeeding. This is whole-file equality, not a
  substring search, so duplicate or unrelated regions cannot satisfy the
  postcondition. Deletes verify absence; moves verify their source,
  destination type, exact destination spelling, native identity where
  available, known bytes, and raw symlink target.
- The extension does not add path filtering, sandboxing, or approval prompts.
- Every hunk is parsed and validated before filesystem writes begin.
- No-change checkpoints are interleaved with mutations in patch order, so
  later checkpoints are not reported as completed after an earlier failure.
- Mutations participate in Pi's per-file mutation queue for the complete
  preflight-and-execution window. Queue paths are acquired deterministically,
  follow operation-specific symlink semantics, and include every move source
  and destination. There is no additional extension-local alias queue.

Operating model: relevant filesystem state is not modified outside the queued
`apply_patch` execution window. This includes ancestor paths, symlink targets,
hard-link aliases, callbacks, injected filesystem hooks, separate Pi sessions,
and external processes. Preflight is authoritative under this model; the
executor does not attempt cross-process drift detection or transactional
isolation.

A low-level I/O failure can still complete part of an instruction. The failed
instruction reports every confirmed effect and final path state; when a path
cannot be inspected, it says that the final state was not verified.

The complete feedback and rendering contract is documented in
[`APPLY_PATCH_INSTRUCTION_FEEDBACK.md`](APPLY_PATCH_INSTRUCTION_FEEDBACK.md).

## `image_gen.imagegen`

The package registers the dotted Pi tool name `image_gen.imagegen` and serializes it as a native Responses API namespace:

```json
{
  "type": "namespace",
  "name": "image_gen",
  "tools": [{ "type": "function", "name": "imagegen" }]
}
```

The tool generates new images with `gpt-image-2` or edits up to five local/recent conversation images. Local edit inputs must use absolute paths and are read directly with the Pi process's filesystem permissions. PNG, JPEG, GIF, and WebP edit inputs are accepted. Generated PNGs are returned to Pi as image tool content and stored without overwriting existing files under:

```text
~/.pi/agent/generated_images/<session-id>/<call-id>.png
```

The active Pi agent directory replaces `~/.pi/agent` when configured differently. Turning `imageGeneration` off removes the tool immediately for the current session; `Enter` or `Ctrl+S` in `/codex-settings` persists the value.

The tool registers the server-reserved schema directly with a model-facing absolute-path annotation that names the supported image formats. OpenAI rejects additional schema keywords for image-count bounds and selector exclusivity, so the executor enforces those constraints before filesystem or network access. Local paths are lexically normalized before reading. A one-line system-prompt snippet and four high-signal guidelines cover normal model use. Local images are inspected with Pi's `read` tool, and generated image content is displayed and saved automatically without Codex Code Mode wrappers.

Pi also persists the returned image content in tool-result history so later image edits and provider replay remain self-contained. Generated-image turns therefore increase the session file by approximately the base64 image size in addition to the saved PNG artifact.

When the image tool result is serialized back to the model, `imageDetail` controls its Responses `input_image.detail`. The default remains `auto`; select `high` for the official Codex default. The saved-path hint intentionally differs from Codex: it always uses “the generated image” and is not removed when the UTF-8 hint exceeds 1,024 bytes.

The TUI shows a compact generation/edit summary and saved artifact path instead of the model-facing path hint. `Ctrl+O` reveals the full prompt and artifact metadata; terminal image display continues to use Pi's normal image support.

## `web.run`

The package registers the dotted Pi tool name `web.run` and serializes it as a native Responses API `web` namespace. Calls are executed through `codex/alpha/search`. Like Codex, successful model-facing output is the unmodified plaintext `output` wrapped in a single `input_text` content item:

```json
{
  "type": "function_call_output",
  "call_id": "<call-id>",
  "output": [{ "type": "input_text", "text": "<alpha/search output>" }]
}
```

Structured `results` are not sent to the model by either implementation. Codex stores them in extension-backed web-search events; this package stores the equivalent opaque JSON branch-locally in Pi tool-result `details`. Extensions and session readers can inspect those details, while subsequent `web.run` calls resolve model-visible reference IDs through `alpha/search` rather than querying the details directly.

The collapsed TUI view provides action-specific summaries for search, image search, page navigation, in-page find, PDF screenshots, finance, weather, sports, and time. `Ctrl+O` expands structured source or image cards, page metadata with line/page gutters, PDF page cards, operation-specific result cards, and readable labeled fields for forward-compatible result types. Citation markers and backend separators are normalized for display, while empty or unavailable operations use compact warning states instead of appearing successful.

Standalone `screenshot` calls return a plaintext PDF-page reference from `alpha/search`, not image bytes or an image content item. The TUI therefore labels these results as reference-only, and the next model request receives the same plaintext reference rather than screenshot pixels.

The exposed command schema includes:

- `search_query`;
- `image_query`;
- `open`;
- `click`;
- `find`;
- `screenshot`;
- `finance`;
- `weather`;
- `sports`;
- `time`;
- `response_length`.

The tool sends the current user message plus the preceding visible user/assistant turn as search context. When `web.run` is active, hosted `web_search` is omitted; turning `webRun` off restores the hosted tool according to `webSearch`.

Both namespace tools are accepted only from the fixed extension-owned allowlist. Unknown namespaced calls and flat wire calls named `web.run` or `image_gen.imagegen` fail instead of being routed ambiguously.

## Development

```bash
mise trust
mise install
npm install
npm run check
npm test
npm run pack:dry
```

Run the credentialed Pi/Codex integration tests separately. They load the real
extension into headless Pi sessions, use the real WebSocket service, and ask
the model to report all prior history markers after each text and tool
continuation:

```bash
mise run test:live:codex
```

The task obtains the local Codex bearer token and runs the tests with
`gpt-5.6-luna` at medium reasoning effort.

The public package entrypoint is `extensions/index.ts`; implementation modules remain under
`extensions/openai-codex-compat/`. The focused Pi AI serializer copy lives under
`extensions/openai-codex-compat/vendor/pi-ai/`. The custom Codex provider transport and stream
parser are focused adaptations of Pi AI's corresponding implementation. Equivalence and protocol
tests cover canonical serialization, native namespace round-trips, raw native replay, sibling Codex
JSON endpoints, SSE request behavior, WebSocket reuse, grammar tools, image results, standalone
search, and compaction continuation.

## Release staging

1. Run `npm run release -- X.Y.Z` from a clean, synchronized `main`.
2. The command builds the exact package locally, records its SHA-256 in an SSH-signed release commit, proves a clean rebuild is reproducible, and creates a lightweight tag.
3. Inspect the result, then push atomically with `git push --atomic origin main vX.Y.Z`.
4. A read-only GitHub Actions job validates and packs the package. After approval in the tag-restricted `npm-publish` environment, a separate GitHub-owned job verifies the signature and signed digest before attesting and staging that exact archive through npm trusted publishing.
5. Approve the staged package on npmjs.com, or with `npm stage approve <stage-id>`.

Stable releases use `latest`; prereleases derive their npm dist-tag from the first prerelease identifier.

## Acknowledgements

The remote-compaction implementation follows the current OpenAI Codex `remote_compaction_v2` protocol. The `apply_patch`, standalone image-generation, and standalone web-search behavior is adapted from OpenAI Codex under Apache-2.0. The Codex provider transport, stream processing, and OpenAI Responses history serialization adapt selected Pi AI methods under MIT; see [third-party notices](THIRD_PARTY_NOTICES.md).

## License

MIT © 2026 Kaan Ozdokmeci. See [LICENSE](LICENSE).
