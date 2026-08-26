# Official Codex CLI Built-in Tool Catalog

This catalog is intended to help decide which official Codex CLI tools are worth
adapting into `pi-openai-codex-compat`.

## Research baseline

- **Released baseline:** Codex CLI `0.149.1` (`rust-v0.149.1`), published
  August 24, 2026, from commit
  `ff29a44391deccde0aba0f8390337d7f3c319ea4`.
- **Compared with:** the prior catalog baseline `0.146.0` at
  `e363b08c9175ac1cbe5893615dd2cb9ddf95043b`, and the previously reviewed
  stable `0.149.0` at `758ef40f50c1a458425c7cfbf1eb12cbc07af0b0`.
- **Package baseline:** `pi-openai-codex-compat` `0.0.10-alpha.3`.
- **Pi baseline:** `@earendil-works/pi-coding-agent` `0.84.3`.
- **Reviewed:** August 25, 2026.

The released `0.149.1` tag is normative. There was no tool-planning or tool
schema diff from `0.149.0` to `0.149.1`. Compared with the old `0.146.0`
catalog, one fixed model-callable name was added:
`send_user_message_async`.

## Dictionary

- **Built-in tool:** A fixed model-callable tool implemented or bundled by the
  official Codex repository. Arbitrary MCP-server tools, dynamic tools supplied
  by a client, and tools contributed by installed third-party plugins are not
  individually cataloged.
- **Function tool:** A normal JSON-schema tool with a flat name such as
  `update_plan`.
- **Namespace tool:** A Responses API namespace plus a function, written here
  as `web.run` or `clock.sleep`.
- **Freeform tool:** A tool whose input is raw text constrained by a grammar
  rather than a JSON object.
- **Hosted tool:** A provider-executed Responses API tool. Codex does not run
  its implementation locally.
- **Extension-backed tool:** A tool bundled with Codex but installed through
  Codex's internal extension registry.
- **Direct-model-only:** A tool intentionally kept outside Codex Code Mode's
  nested JavaScript tool surface.
- **Pi analogue:** A Pi tool can perform a similar user task, but this package
  does not reproduce the official Codex wire schema or runtime.
- **Protocol-only support:** The package can serialize or replay the provider
  item, but does not expose an executable model-callable implementation.

## Recommendation summary

| Priority                  | Tool or family                                                          | Recommendation for this package                                                                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep                      | `apply_patch`                                                           | Already implemented and highly aligned with Codex model behavior.                                                                                                                                    |
| Keep                      | Hosted `web_search`                                                     | Already implemented; keep it as the simple, low-state web option.                                                                                                                                    |
| Keep                      | `web.run`                                                               | Implemented with its native namespace, complete reserved schema and description, `alpha/search` execution, and structured result details. Durable citation/reference persistence remains incomplete. |
| Keep                      | `image_gen.imagegen`                                                    | Implemented with its native namespace, Codex Images execution, image-edit inputs, generated artifacts, image output, and dedicated rendering.                                                        |
| Consider next             | `request_user_input`                                                    | Pi has the UI primitives needed. Useful, bounded, and much smaller than sub-agents or persistent shells.                                                                                             |
| Consider later            | `tool_search`                                                           | Pi already supports additive dynamic tool loading and native OpenAI tool-search history. It becomes valuable only after this package owns several optional tools.                                    |
| Consider only as an alias | `view_image`                                                            | Pi's `read` tool already supports images. Add an alias only if Codex models measurably perform better when the canonical name is present.                                                            |
| Separate package          | Multi-agent tools                                                       | Useful but operationally large and not specific to provider compatibility. Pi already includes a sub-agent extension example.                                                                        |
| Keep                      | `exec_command` + `write_stdin`                                          | Implemented as the default command surface with persistent PTY lifecycle, process cleanup, bounded output, temporary complete-output logs, and dedicated rendering.                                  |
| Keep                      | `shell_command`                                                         | Implemented as the configurable one-shot alternative to unified exec, reusing Pi's shell resolution and output limits.                                                                               |
| Do not port here          | MCP, plugin-install, goals, memories, skills, async messages, Code Mode | These require separate state, trust, UI, provider, or execution architectures and would make the compatibility entrypoint non-compositional.                                                         |

**Recommended order:** finish the durable citation/reference layer for
`web.run`; then decide whether structured user questions are desirable; add
`tool_search` only when the optional tool count justifies deferred discovery.

## Complete wire-name inventory

Codex `0.149.1` contains the following 46 fixed model-callable names. Namespace
names are shown with dots for readability. The multi-agent V2 namespace is
configurable; `collaboration` is its default.

```text
exec_command
write_stdin
shell_command
apply_patch
view_image
update_plan
request_user_input
send_user_message_async
request_permissions
wait_for_environment
get_context_remaining
new_context
clock.curr_time
clock.sleep
list_mcp_resources
list_mcp_resource_templates
read_mcp_resource
list_available_plugins_to_install
request_plugin_install
tool_search
web_search
web.run
exec
wait
multi_agent_v1.spawn_agent
multi_agent_v1.send_input
multi_agent_v1.resume_agent
multi_agent_v1.wait_agent
multi_agent_v1.close_agent
collaboration.spawn_agent
collaboration.send_message
collaboration.followup_task
collaboration.wait_agent
collaboration.interrupt_agent
collaboration.list_agents
get_goal
create_goal
update_goal
memories.add_ad_hoc_note
memories.list
memories.read
memories.search
skills.list
skills.read
image_gen.imagegen
test_sync_tool
```

## Package coverage

The package implements seven operational official surfaces: six
client-executed tools and one provider-hosted tool. Pi's similarly capable
built-ins are listed separately so they are not mistaken for wire-compatible
implementations.

| Official tool or family                                                                                                                                                                 | Coverage in this package | Notes                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apply_patch`                                                                                                                                                                           | **Implemented**          | Extension-owned parser, matcher, filesystem engine, mutation-queue participation, structured history, and renderer. Recorded A-series deviations remain intentional. |
| `web.run`                                                                                                                                                                               | **Implemented**          | Native namespace declaration, official reserved schema and description, `alpha/search` execution, structured result details, and renderer.                           |
| `image_gen.imagegen`                                                                                                                                                                    | **Implemented**          | Native namespace declaration, `gpt-image-2` generation/edit execution, local/recent image inputs, artifact persistence, image result, and renderer.                  |
| Hosted `web_search`                                                                                                                                                                     | **Hosted support**       | The package injects the Responses hosted declaration in cached, indexed, or live mode; OpenAI executes the tool.                                                     |
| `tool_search`                                                                                                                                                                           | **Protocol only**        | The provider preserves additive `tool_search_call`/`tool_search_output` history, but this package has no searchable deferred-tool catalog or BM25 executor.          |
| `exec_command`, `write_stdin`                                                                                                                                                           | **Implemented**          | Default command surface with optional `node-pty` sessions, writes and polls, process cleanup, Codex-style result metadata, and Pi-style tail truncation.             |
| `shell_command`                                                                                                                                                                         | **Implemented**          | Configurable one-shot command surface with working-directory, timeout, login-shell, cancellation, process-tree cleanup, and Pi-style tail truncation.                |
| `view_image`                                                                                                                                                                            | **Pi analogue**          | Pi `read` accepts images, but the package does not register the canonical Codex alias or reproduce its detail/environment contract.                                  |
| `update_plan`, `request_user_input`, `send_user_message_async`, `request_permissions`, `wait_for_environment`, `get_context_remaining`, `new_context`, `clock.curr_time`, `clock.sleep` | **Not implemented**      | These depend on Codex planning, question, asynchronous-message, permission, environment, context-window, or reminder lifecycles.                                     |
| `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`                                                                                                                | **Not implemented**      | No Codex MCP connection/resource runtime is provided.                                                                                                                |
| `list_available_plugins_to_install`, `request_plugin_install`                                                                                                                           | **Not implemented**      | Model-initiated installation is outside package trust and package-manager policy.                                                                                    |
| `multi_agent_v1.*`, `collaboration.*`                                                                                                                                                   | **Not implemented**      | No Codex agent tree, mailbox, task-path, depth, or resume runtime is provided.                                                                                       |
| Code Mode `exec`, `wait`                                                                                                                                                                | **Not implemented**      | No V8 isolate, nested tool dispatcher, yielded-cell store, or cell lifecycle is provided.                                                                            |
| `get_goal`, `create_goal`, `update_goal`, `memories.*`, `skills.*`                                                                                                                      | **Not implemented**      | Pi sessions, reusable notes, and native skills remain separate from Codex's goal, memory, and remote skill-resource stores.                                          |
| `test_sync_tool`                                                                                                                                                                        | **Not implemented**      | Official integration-test infrastructure only.                                                                                                                       |

Exact implementation evidence lives in
[`extensions/openai-codex-compat/tools.ts`](extensions/openai-codex-compat/tools.ts),
[`extensions/openai-codex-compat/command-tools.ts`](extensions/openai-codex-compat/command-tools.ts),
[`extensions/openai-codex-compat/command-runtime.ts`](extensions/openai-codex-compat/command-runtime.ts),
[`extensions/openai-codex-compat/request-options.ts`](extensions/openai-codex-compat/request-options.ts),
and the focused `apply-patch`, `web-run`, and `image-generation` modules.

## 1. Shell, process, file, and image tools

Source:
[core tool planning](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/core/src/tools/spec_plan.rs),
[shell schemas](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/core/src/tools/handlers/shell_spec.rs),
[apply-patch schema](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/core/src/tools/handlers/apply_patch_spec.rs),
and
[view-image schema](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/core/src/tools/handlers/view_image_spec.rs).

| Tool            | Contract                                                                                                                                                                                                                                         | Availability in Codex                                                                                                                                                                              | Pi fit                                                                                                                                                                            | Verdict                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `exec_command`  | Runs one command with plain pipes or an optional PTY. Inputs include `cmd`, `workdir`, `tty`, yield time, output-token limit, and optional shell, login, environment, and permission fields. Returns output immediately or a numeric session ID. | Requires an execution environment and a model/runtime selecting unified exec. Unified exec is enabled by default on non-Windows systems, but model metadata still chooses the visible shell shape. | Implemented with optional PTY allocation, a process registry, cancellation, bounded interaction output, and cleanup. Environment and permission fields are intentionally omitted. | **Keep as the default command surface.**                                       |
| `write_stdin`   | Writes characters to, or polls, an active `exec_command` session. Inputs: `session_id`, optional `chars`, yield time, and output-token limit.                                                                                                    | Exposed only with unified exec.                                                                                                                                                                    | Implemented against the same in-memory process registry, including empty polling, PTY writes, non-PTY interruption, per-session serialization, and cleanup.                       | **Keep with `exec_command`.**                                                  |
| `shell_command` | Legacy one-shot shell execution. Inputs: `command`, `workdir`, timeout, optional login, and permission fields.                                                                                                                                   | Used when model/runtime selects the legacy shell. It remains hidden as a dispatch fallback when unified exec is visible.                                                                           | Implemented as a configurable alternative to unified exec, with Pi-compatible shell resolution, process-tree cancellation, timeout, output limits, and complete temporary logs.   | **Keep as the one-shot alternative.**                                          |
| `apply_patch`   | Freeform Lark-grammar patch tool supporting add, update, delete, and move operations.                                                                                                                                                            | Requires an execution environment and model metadata advertising an apply-patch tool type.                                                                                                         | This package already implements the Codex grammar, matching, filesystem semantics, mutation queue integration, history, and rendering.                                            | **Keep.**                                                                      |
| `view_image`    | Reads a local image path and returns an image data URL plus detail metadata. Optional inputs select original detail and an environment.                                                                                                          | Present whenever an execution environment exists. Original-detail support is model-dependent.                                                                                                      | Pi's built-in `read` already accepts text and common image formats and returns images as tool-result attachments.                                                                 | **Consider only as a thin alias** if canonical naming improves model behavior. |

### Shell-family implementation note

Codex treats `exec_command` and `write_stdin` as a coordinated subsystem, not
as two unrelated tools. This package therefore activates and implements them
together. Its in-memory process manager owns optional PTYs across calls,
serializes interactions per session, supports yielding, polling and
interruption, and terminates sessions when the command surface or Pi session
changes. Output follows Pi's 2,000-line/50-KiB tail policy and points to a
complete temporary log when truncated. The unified tools use the official
retained-field descriptions, while their top-level Pi descriptions name the
resolved shell and explain Pi-specific process and session behavior. Official
Codex keeps their output schemas as internal Code Mode metadata and omits them
from direct Responses declarations; this package omits them entirely because
it has no Code Mode runtime. Unified child processes receive the official
non-color, UTF-8 locale, and pager environment normalization except
`CODEX_CI`, which this package deliberately does not set.
Cancelling the initial wait preserves a started process and reports its session
ID in Pi's cancellation result rather than relying on Codex's background
terminal UI. The package adapts Codex's `/ps` and `/stop` split into one `/ps`
browser. `Enter` opens a live, scrollable recent-output popup; confirmed
`Ctrl+X` stops one session, and confirmed `Ctrl+S` stops all sessions. One-shot
nonzero exits and timeouts remain successful tool results, matching official
tool-call semantics. Naturally signal-terminated one-shot commands retain the
package's conventional `128 + signal` successful exit result; changing only
Pi's internal `isError` classification without changing model-visible output
is explicitly deferred.

Unlike official Codex, the package has no execution-environment, sandbox,
permission-profile, or approval lifecycle. Those schema fields are omitted,
and commands run with the Pi extension process's host permissions.

### Implemented command input schemas

All three schemas are closed (`additionalProperties: false`). Types below use
the official JSON Schema shape; numeric values are additionally required to be
safe integers by the runtime.

#### `exec_command`

| Field               | Required | Type    | Package behavior                                                                                        |
| ------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------- |
| `cmd`               | yes      | string  | Shell command to execute.                                                                               |
| `workdir`           | no       | string  | Absolute path or path relative to the Pi session working directory; defaults to that session directory. |
| `shell`             | no       | string  | Shell binary; defaults to Pi's bash-compatible shell resolution.                                        |
| `login`             | no       | boolean | Enables login-shell semantics; defaults to `true`.                                                      |
| `tty`               | no       | boolean | Allocates a persistent PTY when `true`; defaults to plain pipes.                                        |
| `yield_time_ms`     | no       | number  | Defaults to 10,000 ms and is clamped to 250–30,000 ms, with a 10,000 ms floor on Windows.               |
| `max_output_tokens` | no       | number  | Defaults to 10,000 approximate tokens and cannot exceed Pi's 50-KiB/2,000-line output cap.              |

#### `write_stdin`

| Field               | Required | Type   | Package behavior                                                                                                        |
| ------------------- | -------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| `session_id`        | yes      | number | Numeric ID returned by `exec_command`.                                                                                  |
| `chars`             | no       | string | Characters written to a PTY. Empty or omitted polls; `"\u0003"` interrupts a non-PTY process.                           |
| `yield_time_ms`     | no       | number | Non-empty writes default to 250 ms and clamp to 250–30,000 ms; empty polls default to 5,000 ms and clamp at 300,000 ms. |
| `max_output_tokens` | no       | number | Defaults to 10,000 approximate tokens and cannot exceed Pi's 50-KiB/2,000-line output cap.                              |

#### `shell_command`

| Field        | Required | Type    | Package behavior                                                                                        |
| ------------ | -------- | ------- | ------------------------------------------------------------------------------------------------------- |
| `command`    | yes      | string  | One-shot shell script to execute.                                                                       |
| `workdir`    | no       | string  | Absolute path or path relative to the Pi session working directory; defaults to that session directory. |
| `timeout_ms` | no       | number  | Defaults to 10,000 ms; maximum 2,147,483,647 ms.                                                        |
| `login`      | no       | boolean | Enables login-shell semantics; defaults to `true`.                                                      |

Official Codex's in-memory `exec_command` and `write_stdin` specifications
share a closed output schema requiring `wall_time_seconds` and `output`, with
optional `chunk_id`, `exit_code`, `session_id`, and `original_token_count`.
The field is marked `#[serde(skip)]`, so normal Responses declarations do not
send it and direct tool results remain human-readable text. Code Mode consumes
the schema for its nested typed tool surface and returns the matching
structured object. This package omits the metadata entirely because it has no
Code Mode runtime; Pi's temporary complete-output path remains an intentional
extension when direct text output is truncated.

### Fresh command-tool alignment review

This focused review was repeated against the exact stable `rust-v0.149.1`
source at `ff29a44391deccde0aba0f8390337d7f3c319ea4` on August 25, 2026. GitHub's
latest stable release and npm's `latest` dist-tag still resolve to `0.149.1`.
The newest GitHub prerelease observed was `0.150.0-alpha.13`; prerelease source
is not used as the compatibility baseline.

The review covers model-visible declarations, validation, process behavior,
output, cancellation, and background-terminal lifecycle. Backend internals are
listed where they create observable differences.

Primary runtime evidence:
[unified handlers](https://github.com/openai/codex/tree/rust-v0.149.1/codex-rs/core/src/tools/handlers/unified_exec),
[unified process manager](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/core/src/unified_exec/process_manager.rs),
[shell handler](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/core/src/tools/handlers/shell/shell_command.rs),
[tool output formatting](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/core/src/tools/context.rs),
and
[background-terminal TUI](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/tui/src/history_cell/exec.rs).

#### Exact or materially aligned behavior

| Area                           | Alignment                                                                                                                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Names and retained fields      | All three tool names and descriptions for every retained input field are copied exactly.                                                                                                                   |
| Direct output-schema transport | Official Codex omits its internal unified-exec output schemas from normal Responses declarations; the package now does the same.                                                                           |
| Core defaults                  | Initial yield is 10,000 ms; non-empty writes default to 250 ms; empty polls clamp to at least 5,000 ms; one-shot timeout defaults to 10,000 ms; output-token budget defaults to 10,000 approximate tokens. |
| Yield bounds                   | Initial and non-empty write yields clamp to 250–30,000 ms, with the official 10,000 ms initial floor on Windows. Empty polls cap at 300,000 ms by default.                                                 |
| Legacy timeout alias           | `shell_command` accepts the unadvertised `timeout` alias for `timeout_ms` and rejects calls that provide both names.                                                                                       |
| Unified result envelope        | Text results use six-hex-digit chunk IDs, four-decimal wall time, exit/session status, original token count, and output in the official order.                                                             |
| Exit semantics                 | Unified nonzero exits and one-shot nonzero exits/timeouts are successful tool results. One-shot timeouts use exit code 124 and prepend a timeout line.                                                     |
| Sessions                       | Numeric IDs use the official random 1,000–99,999 range, the registry cap is 64, interactions on one session serialize, and separate sessions can run concurrently.                                         |
| Terminal modes                 | Plain execution closes stdin; `tty: true` creates an 80×24 PTY; `write_stdin` can write to that PTY; `"\u0003"` interrupts a live non-PTY session.                                                         |
| Unified environment subset     | `NO_COLOR`, `TERM`, UTF-8 locale variables, `COLORTERM`, and pager variables use the official forced values.                                                                                               |
| Initial cancellation invariant | Once spawned, a process survives cancellation of the initial `exec_command` wait in both implementations.                                                                                                  |
| Shell resolution               | Default and model-requested shells use Codex's type-first discovery and fallback policy.                                                                                                                   |
| Shell-text `apply_patch`       | Both recognize the same strict top-level direct and optional-`cd` heredoc forms with the official Tree-sitter query and route them before spawning a shell.                                                |
| PTY write delay                | Both wait 100 ms after a successful non-empty PTY write before polling.                                                                                                                                    |
| Process pruning                | Both protect the eight most recently used sessions, prefer unlocked exited sessions, and avoid pruning a session with an active interaction.                                                               |
| Invalid UTF-8 accounting       | Both estimate original output tokens from raw observed bytes before lossy UTF-8 conversion.                                                                                                                |
| One-shot output order          | Final `shell_command` output aggregates stdout before stderr.                                                                                                                                              |

#### Deliberate contract and activation differences

| Area                              | Official Codex `0.149.1`                                                                                                                                                                                                             | This package                                                                                                                                                                               | Classification                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| Tool selection                    | Selects unified exec, legacy shell, or disabled from model metadata, features, platform, and available execution environments. A local `shell_command` handler remains hidden as an internal fallback while unified exec is visible. | User setting `shellTool` selects one visible surface, defaults to unified exec on every platform, and replaces it only when Pi `bash` was active. There is no hidden shell fallback.       | Pi host adaptation.                               |
| Surface changes                   | Codex owns one session process manager independently of Pi tool activation.                                                                                                                                                          | Switching away from unified exec, switching providers, losing Pi `bash`, or shutting down the Pi session terminates unified sessions so inaccessible processes are not left behind.        | Pi lifecycle policy.                              |
| Output-schema metadata            | Retains unified-exec schemas internally for Code Mode, skips them during normal Responses serialization, and returns structured objects only through Code Mode dispatch.                                                             | Does not retain or transmit those schemas because no Code Mode runtime exists; direct command dispatch remains text.                                                                       | Intentional Code Mode exclusion.                  |
| `shell` field                     | Omitted for local zsh-fork unified exec; present for direct or remote execution.                                                                                                                                                     | Always advertised because only direct shell launch is implemented.                                                                                                                         | Deliberate simplification.                        |
| `login` field                     | Advertised only when at least one selected environment permits login shells. The official default permits them, but policy can disable the field and reject `login: true`.                                                           | Always advertised and defaults to `true`; there is no separate login-shell policy.                                                                                                         | Missing policy gate.                              |
| Environment and permission fields | Can expose `environment_id`, `sandbox_permissions`, `additional_permissions`, `justification`, and `prefix_rule`.                                                                                                                    | Omits all of them. Commands run with the host permissions of the Pi extension process.                                                                                                     | Explicitly approved exclusion.                    |
| Model guidance                    | Uses compact official descriptions and adds Windows-only PowerShell examples and safety guidance.                                                                                                                                    | Uses dynamically resolved shell names plus Pi lifecycle, working-directory, and `PI_*` guidance. Retained-field descriptions are exact, while official Windows-only guidance is deferred.  | Pi prompt integration; deferred Windows guidance. |
| Numeric domain                    | Rust inputs use `u64`, `usize`, and `i32`; zero yield values are accepted and then clamped, zero timeout is accepted, and timeout has no schema-level upper bound.                                                                   | Numbers must be safe integers. Zero timing values are accepted with official clamping; session IDs are not restricted to `i32`, and timeout is capped at 2,147,483,647 ms for Node timers. | Runtime validation difference.                    |
| Input edge handling               | Runtime deserialization can ignore unknown fields and preserves whitespace-only shell and working-directory strings.                                                                                                                 | Pi enforces the advertised closed schemas, trims the shell selector, and treats whitespace-only `workdir` as omitted.                                                                      | Minor validation difference.                      |

#### Deliberate execution and output differences

| Area                      | Official Codex `0.149.1`                                                                                                                                                                                 | This package                                                                                                                                                                       | Classification                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Execution architecture    | Supports local and remote environments, shell-environment policies, exec-server backends, sandbox selection, network mediation, permission profiles, and approvals.                                      | Supports host-local execution only and inherits the Pi process environment.                                                                                                        | Explicitly approved exclusion.      |
| Child environment         | Applies its shell environment policy and injects Codex thread/session, `apply_patch`, permission, plugin, and managed-network variables. Unified exec also forces `CODEX_CI=1`.                          | Injects Pi session/model variables and the nine approved unified normalization variables. It deliberately does not inject `CODEX_CI`; an inherited parent value is left unchanged. | Intentional divergence.             |
| Shell backends            | Uses detected direct shells, optional zsh-fork, portable PTY/ConPTY, and remote exec-server execution.                                                                                                   | Uses Pi's shell resolution, Node child processes, and `node-pty@1.2.0-beta.15`; no zsh-fork or remote backend exists.                                                              | Pi implementation.                  |
| PowerShell launch         | Login mode omits `-NoProfile`; non-login mode adds `-NoProfile`; neither mode adds `-NonInteractive`.                                                                                                    | Matches profile and `-NonInteractive` behavior but also adds `-NoLogo`.                                                                                                            | Accepted shell-argument difference. |
| `apply_patch` execution   | Eligible shell text is routed through Codex's patch runtime.                                                                                                                                             | Detection and pre-spawn routing align; execution uses the extension's queued `apply_patch` engine.                                                                                 | Pi runtime adaptation.              |
| Hooks and attribution     | Runs Codex Bash pre/post hooks, permits hook command rewrites, detects implicit skills, attributes plugins, records metrics, and emits Codex exec lifecycle events.                                      | Participates in Pi's normal tool lifecycle but does not recreate those Codex-specific systems.                                                                                     | Excluded Codex runtimes.            |
| Working directories       | Resolves `PathUri` values against the selected local or remote environment and supports foreign path conventions through remote executors.                                                               | Resolves host paths against the Pi session cwd and checks that the result exists before spawning.                                                                                  | Host-only adaptation.               |
| Unified output collection | Retains at most 1 MiB as a symmetric head/tail buffer, records omitted bytes, then middle-truncates against the requested and model policy budgets.                                                      | Uses Pi's 2,000-line/50-KiB tail view, honors a smaller requested token budget, and stores complete raw output in an absolute-path temporary file when truncated.                  | Explicitly approved Pi improvement. |
| One-shot output           | Uses the Codex model truncation policy and middle truncation, with no complete-output file.                                                                                                              | Uses the same Pi tail policy and complete temporary file as unified exec.                                                                                                          | Explicitly approved Pi improvement. |
| Output timing             | After a successful non-empty PTY write, sleeps 100 ms before starting the requested poll. Empty-poll maximum is configurable and defaults to 300,000 ms. Elicitation pauses extend collection deadlines. | Matches the 100 ms delay and default 300,000 ms cap. It has no elicitation-pause clock adjustment because it implements no Codex approval or elicitation lifecycle.                | Approved runtime exclusion.         |
| Timeout text              | Uses the measured timed-out duration in the timeout line.                                                                                                                                                | Uses the requested `timeout_ms` value.                                                                                                                                             | Minor formatting difference.        |
| Errors                    | Uses official parse, unknown-process, closed-stdin, spawn, and write error wording.                                                                                                                      | Major templates and prefixes align; exact unknown-session nouns, resolved-command display, Serde locations, numeric wording, and working-directory errors differ.                  | Minor textual parity gap.           |
| Natural signal exit       | A shell process terminated directly by a Unix signal becomes a failed tool result.                                                                                                                       | Converts the signal to conventional exit code `128 + signal` and returns the existing structured successful result. Pi-only `isError` classification is deferred.                  | Deferred runtime difference.        |

#### Cancellation, process registry, and UI differences

| Area                         | Official Codex `0.149.1`                                                                                                                                                   | This package                                                                                                                                                                  | Classification                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Initial unified cancellation | Stores the process before waiting, so dropping the cancelled tool future leaves it running. The cancelled turn does not receive a synthetic tool result containing the ID. | Preserves the process and returns the output collected so far plus a model-visible session ID in the cancellation error.                                                      | Deliberate Pi recovery improvement. |
| `write_stdin` cancellation   | Cancelling the interaction leaves the session available; Codex's cancelled turn owns the presentation.                                                                     | Returns an explicit Pi error saying the session is still running.                                                                                                             | Pi presentation difference.         |
| One-shot cancellation        | Sends `SIGTERM`, allows 50 ms for cleanup, then escalates to process-group kill.                                                                                           | Matches this behavior on Unix. Exact Windows graceful-cancellation parity remains deferred.                                                                                   | Aligned on Unix; Windows deferred.  |
| Registry pruning             | At the 64-process soft cap, protects the eight most recently used sessions, prefers unlocked exited sessions, and avoids pruning a session with an active interaction.     | Matches the protected-eight, exited-first, and interaction-safe policy.                                                                                                       | Aligned.                            |
| Background transcript        | Continuously emits output deltas and a terminal completion event, while retaining a capped transcript independent of model polls.                                          | Retains a Pi-sized recent-output tail for `/ps` beside the per-interaction polling buffer, but emits no independent completion cell after an interaction ends.                | Pi lifecycle gap.                   |
| Process-control API          | Core/app-server APIs can list sessions and terminate one session; the Codex TUI exposes `/ps`, `/stop`, and the `/clean` alias, with `/stop` stopping all.                 | The `/ps` browser can terminate one selected session or every session, with confirmation.                                                                                     | Materially aligned capability.      |
| `/ps` presentation           | Adds a static history cell containing command snippets and recent output chunks, up to 16 processes.                                                                       | Opens a Pi browser showing session ID, OS PID, PTY/pipe mode, command, and cwd. `Enter` opens a live, scrollable recent-output popup. Non-TUI mode emits a text notification. | Pi UI adaptation.                   |
| Stop shortcut                | Uses separate `/stop` or `/clean` commands.                                                                                                                                | Registers no `/stop`; confirmed `Ctrl+X` stops the selected session and confirmed `Ctrl+S` stops all sessions from `/ps`.                                                     | Explicitly requested adaptation.    |
| Persistent footer            | Shows the live background-terminal count and `/ps`/`/stop` hints near the editor.                                                                                          | Does not currently add a background-terminal line to Pi's footer.                                                                                                             | Explicitly deferred UI work.        |
| `write_stdin` call context   | Terminal interaction events let the TUI associate a poll or write with the original command.                                                                               | Renders the session ID and current poll/write interaction, not the original command or working directory.                                                                     | Explicitly deferred UI work.        |
| Live output updates          | Emits raw command-output delta events as chunks arrive.                                                                                                                    | Streams Pi tool updates with an approximately 100 ms throttle; final model-visible output is unaffected.                                                                      | Pi UI adaptation.                   |

These differences are cataloged rather than automatically treated as defects.
The approved exclusions and Pi output behavior should remain stable. Windows
model guidance, exact edge-case error and input behavior, Windows graceful
cancellation, natural-signal classification, the optional background footer,
and richer `write_stdin` call rendering are explicitly noted for possible
future review rather than release blockers. Official `/cd` blocking is not
applicable because Pi exposes no corresponding cwd-changing command.

## 2. Planning, questions, messages, permissions, and environments

Source:
[plan schema](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/core/src/tools/handlers/plan_spec.rs),
[user-input schema](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/core/src/tools/handlers/request_user_input_spec.rs),
[permission schema](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/core/src/tools/handlers/shell_spec.rs),
and
[environment wait implementation](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/core/src/tools/handlers/wait_for_environment.rs).

| Tool                      | Contract                                                                                                                                                    | Availability in Codex                                                                                                                | Pi fit                                                                                                                                                                                                      | Verdict                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `update_plan`             | Replaces the current plan with steps whose states are `pending`, `in_progress`, or `completed`; at most one may be active.                                  | Enabled by default and independently configurable.                                                                                   | Easy to build, but Pi intentionally avoids a built-in plan/todo workflow. Pi's example plan-mode extension is more complete than this data-only tool.                                                       | **Skip in this package.** Build as a separate workflow package if wanted.  |
| `request_user_input`      | Presents one to three short multiple-choice questions, always with a client-added free-form option, and waits for the response.                             | Enabled by default, direct-model-only, and normally callable only in Plan mode. An under-development flag also permits Default mode. | Pi supports custom dialogs, RPC UI, sequential tools, timeouts, and custom rendering. The main design work is non-TUI behavior and durable result details.                                                  | **Strong optional candidate.**                                             |
| `send_user_message_async` | Emits a concise user-visible acknowledgment, update, or blocking question and returns immediately; a reply enters later as a new asynchronous user message. | Direct-model-only, root-agent-only, and exposed only when model metadata lists the experimental tool.                                | Correct behavior needs out-of-band assistant delivery, asynchronous user-item injection, turn coordination, and canonical history semantics that this provider extension does not own.                      | **Skip under the recorded asynchronous-message runtime exclusion.**        |
| `request_permissions`     | Requests a filesystem/network permission profile from the client and waits for a granted subset.                                                            | Under-development feature, off by default, and requires an execution environment.                                                    | Pi extensions run with host permissions and Pi intentionally has no built-in permission-popup model. Correct behavior would require a sandbox and durable permission scope, not just a confirmation dialog. | **Skip.**                                                                  |
| `wait_for_environment`    | Waits for a named remote or deferred execution environment to finish starting.                                                                              | Under-development `deferred_executor` feature, off by default.                                                                       | Pi has no equivalent multi-environment lifecycle abstraction.                                                                                                                                               | **Skip unless a future remote-execution package introduces environments.** |

## 3. Context-window and clock tools

Source:
[context-remaining schema](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/core/src/tools/handlers/get_context_remaining_spec.rs),
[new-context schema](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/core/src/tools/handlers/new_context_window_spec.rs),
[current-time implementation](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/core/src/tools/handlers/current_time.rs),
and
[sleep implementation](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/core/src/tools/handlers/sleep.rs).

| Tool                    | Contract                                                                 | Availability in Codex                                                        | Pi fit                                                                                                                                                                            | Verdict                           |
| ----------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `get_context_remaining` | Returns remaining tokens in the current context window.                  | Under-development `token_budget` feature, off by default.                    | Pi exposes context usage through `ctx.getContextUsage()`, so this is small to implement. The package already handles compaction without model intervention.                       | **Low-priority experiment only.** |
| `new_context`           | Starts a fresh model context window without resetting environment state. | Same under-development token-budget feature; direct-model-only.              | This is not merely `/compact`: Codex owns a context-rollover lifecycle and state accounting. A superficial implementation could corrupt canonical history or checkpoint behavior. | **Skip.**                         |
| `clock.curr_time`       | Returns current UTC time in a fixed string format.                       | Under-development `current_time_reminder` feature, off by default.           | Trivial, but not a coding-compatibility feature.                                                                                                                                  | **Skip.**                         |
| `clock.sleep`           | Sleeps for up to 12 hours and ends early when new input arrives.         | Requires current-time reminders plus `sleep_tool = true`; direct-model-only. | A long-lived blocking tool adds little coding value and complicates cancellation.                                                                                                 | **Skip.**                         |

## 4. Web search and deferred tool discovery

Source:
[hosted web-search planning](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/core/src/tools/hosted_spec.rs),
[standalone web-search extension](https://github.com/openai/codex/tree/rust-v0.149.1/codex-rs/ext/web-search),
and
[tool-search schema](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/core/src/tools/handlers/tool_search_spec.rs).

| Tool                | Contract                                                                                                                                                                             | Availability in Codex                                                                                                                                                                                                  | Pi fit                                                                                                                                                                                                                                                                                  | Verdict                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Hosted `web_search` | Provider-executed Responses API tool. Supports cached, indexed, and live access, optional domain/location/context filters, and model-dependent image results.                        | Web search defaults to cached. Emitted when the provider supports hosted search, search is enabled, Responses Lite is not in use, and standalone `web.run` is unavailable.                                             | This package already injects it without owning search execution or reference persistence.                                                                                                                                                                                               | **Keep.**                                          |
| `web.run`           | Client-executed namespaced tool that sends structured search commands to Codex's search service. It returns model-facing text while retaining structured result metadata separately. | Requires provider web-search capability and namespace support. It is automatic for Responses Lite; otherwise the under-development standalone-web-search feature must be enabled. Disabled web-search mode removes it. | Implemented through provider-level namespace serialization, the complete reserved schema and description, `alpha/search`, model-facing text, and structured Pi result details. Remaining parity gaps are durable cross-call references, citation rendering, and Codex lifecycle events. | **Keep; finish reference persistence.**            |
| `tool_search`       | BM25 search over deferred tool metadata. A successful call exposes matching tools on the next model request. Inputs: `query` and optional `limit`.                                   | Requires model support for tool search, provider namespace support, and at least one deferred tool.                                                                                                                    | Pi already records additive tool activation as OpenAI `tool_search_call`/`tool_search_output` items when the model supports it. The missing piece is a Codex-like searchable catalog and ranking tool.                                                                                  | **Add later**, after several optional tools exist. |

### `web.run` command catalog

`web.run` is one top-level tool with these optional command arrays:

| Command           | Main inputs                                               | Purpose                                      |
| ----------------- | --------------------------------------------------------- | -------------------------------------------- |
| `search_query`    | `q`, optional recent-day filter and domains               | General web search.                          |
| `image_query`     | Same query shape                                          | Image search.                                |
| `open`            | Reference ID or URL, optional line number                 | Open a result or page.                       |
| `click`           | Page reference and numbered link ID                       | Follow a link discovered on a page.          |
| `find`            | Page reference or URL and text pattern                    | Locate text within a page.                   |
| `screenshot`      | PDF reference/URL and zero-based page number              | Render a PDF page.                           |
| `finance`         | Ticker, asset type, optional market                       | Equity, fund, crypto, or index lookup.       |
| `weather`         | Location, optional start date and duration                | Weather forecast.                            |
| `sports`          | Schedule/standings, league, optional teams and date range | Sports lookup for the supported league enum. |
| `time`            | UTC offset                                                | Current time lookup.                         |
| `response_length` | `short`, `medium`, or `long`                              | Controls returned search detail.             |

Unlike the later tool description used by some OpenAI environments, the
`0.149.1` `SearchCommands` schema does **not** include a calculator command.

## 5. MCP resource bridge

Source:
[MCP resource schemas](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/core/src/tools/handlers/mcp_resource_spec.rs).

| Tool                          | Contract                                                                                | Availability in Codex                             | Pi fit                                                     | Verdict   |
| ----------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------- | --------- |
| `list_mcp_resources`          | Lists concrete resources from one or all configured MCP servers with cursor pagination. | Present only when at least one MCP server exists. | Pi intentionally does not ship MCP.                        | **Skip.** |
| `list_mcp_resource_templates` | Lists parameterized MCP resource templates.                                             | Same gate.                                        | Same architectural mismatch.                               | **Skip.** |
| `read_mcp_resource`           | Reads a resource by exact server name and URI.                                          | Same gate.                                        | Requires an MCP connection manager and resource lifecycle. | **Skip.** |

These are fixed Codex bridge tools. The actual MCP server tools are dynamic
external tools and are outside this catalog.

## 6. Plugin and connector installation tools

Source:
[candidate-list schema](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/core/src/tools/handlers/list_available_plugins_to_install_spec.rs)
and
[installation-request schema](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/core/src/tools/handlers/request_plugin_install_spec.rs).

| Tool                                | Contract                                                                                                   | Availability in Codex                                                                                                              | Pi fit                                                                                     | Verdict                         |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------- |
| `list_available_plugins_to_install` | Returns plugin or connector candidates only after the user explicitly asks for an unavailable integration. | Requires apps, plugins, tool suggestions, and host-supplied candidates. The three feature flags are stable and enabled by default. | Pi packages use explicit install commands, project trust, and package-manager constraints. | **Skip.**                       |
| `request_plugin_install`            | Requests installation of an exact candidate and includes a user-facing reason. Explicitly non-parallel.    | Same candidate and feature gates. It has two wire variants depending on how candidates were presented.                             | Model-initiated package installation creates trust, provenance, and package-policy risks.  | **Do not add to this package.** |

## 7. Multi-agent tools

Source:
[multi-agent schemas](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/core/src/tools/handlers/multi_agents_spec.rs)
and
[tool planning](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/core/src/tools/spec_plan.rs).

### V1: thread-ID-oriented tools

The V1 tools live under the `multi_agent_v1` namespace and are normally
deferred behind `tool_search` when that facility is available.

| Tool                          | Purpose                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `multi_agent_v1.spawn_agent`  | Spawn a sub-agent, optionally forking context and overriding agent type, model, reasoning effort, or service tier. |
| `multi_agent_v1.send_input`   | Queue or interrupt with text or structured input for an existing agent.                                            |
| `multi_agent_v1.resume_agent` | Resume a previously closed agent by ID.                                                                            |
| `multi_agent_v1.wait_agent`   | Wait for one of several agents to reach a final state.                                                             |
| `multi_agent_v1.close_agent`  | Shut down an agent and its descendants.                                                                            |

### V2: task-path-oriented tools

The V2 namespace defaults to `collaboration` but is configurable. V2 is stable
but off by default unless model metadata selects it or the feature is enabled.
Its tools are direct-model-only by default and therefore stay outside Code
Mode.

| Tool                            | Purpose                                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `collaboration.spawn_agent`     | Spawn a named child task, optionally choosing fork depth, agent type, model, reasoning effort, or service tier. |
| `collaboration.send_message`    | Deliver a prompt message without starting a new turn.                                                           |
| `collaboration.followup_task`   | Deliver follow-up work and trigger a turn when appropriate.                                                     |
| `collaboration.wait_agent`      | Wait for mailbox or status activity from any live agent; can be disabled by configuration.                      |
| `collaboration.interrupt_agent` | Interrupt the target's current turn while keeping the agent available.                                          |
| `collaboration.list_agents`     | List live agents, optionally filtered by task-path prefix.                                                      |

### Pi decision

Pi can support sub-agents through extensions, and its official examples already
demonstrate isolated child Pi processes, streaming, concurrency limits,
cancellation, usage accounting, and custom rendering. A faithful Codex port
would additionally need:

- canonical agent-tree state;
- cross-agent mailboxes;
- model and service-tier inheritance;
- context-fork rules;
- concurrency/depth enforcement;
- session resume and branch semantics;
- tool-result and event compatibility.

**Verdict:** valuable as a separate multi-agent package, but not appropriate for
the Codex provider-compatibility entrypoint.

## 8. JavaScript Code Mode

Source:
[Code Mode schema](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/core/src/tools/code_mode/execute_spec.rs),
[wait schema](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/core/src/tools/code_mode/wait_spec.rs),
and
[runtime contract](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/code-mode-protocol/src/description.rs).

| Tool   | Contract                                                                                                                                                                                                                                                                                    | Availability                                                                                                                          | Pi fit                                                                                                                                                                                                                                             | Verdict                             |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `exec` | Freeform JavaScript executed in a fresh V8 isolate. Nested tools are available on a global `tools` object. It provides output helpers, image/audio forwarding, session-local storage, notifications, timers, and explicit yielding. It has no Node, filesystem, network, or console access. | Under-development Code Mode feature, off by default. A stricter Code-Mode-only option hides ordinary nested tools from the top level. | Requires a V8 isolate or remote Code Mode host, nested tool dispatch, output adaptation, running-cell state, and exact history semantics. Pi's deferred tool loading already addresses much of the schema-size motivation at far lower complexity. | **Do not port now.**                |
| `wait` | Polls, terminates, or continues a yielded `exec` cell by `cell_id`.                                                                                                                                                                                                                         | Only with Code Mode.                                                                                                                  | Meaningless without the full Code Mode runtime.                                                                                                                                                                                                    | **Do not implement independently.** |

## 9. Persisted goal tools

Source:
[goal schemas](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/ext/goal/src/spec.rs)
and
[goal extension](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/ext/goal/src/extension.rs).

| Tool          | Purpose                                                             |
| ------------- | ------------------------------------------------------------------- |
| `get_goal`    | Read the current persisted thread goal, status, budgets, and usage. |
| `create_goal` | Create an explicitly requested goal with an optional token budget.  |
| `update_goal` | Mark the current goal `complete` or `blocked` under strict rules.   |

The goals feature is stable and enabled by default, but tools appear only when
persistent thread state is available and the session is not a review sub-agent.
The extension also performs automatic continuation and token accounting outside
the tools themselves.

**Verdict:** do not copy only the three schemas. Their value depends on the
surrounding persisted-goal runtime. If desired, build a separate Pi workflow
extension using session entries and lifecycle events.

## 10. Memory tools

Source:
[memory extension](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/ext/memories/src/extension.rs)
and
[memory tools](https://github.com/openai/codex/tree/rust-v0.149.1/codex-rs/ext/memories/src/tools).

| Tool                       | Purpose                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `memories.add_ad_hoc_note` | Create an append-only Markdown memory after an explicit remember/forget/update request.                |
| `memories.list`            | List memory files and directories with pagination.                                                     |
| `memories.read`            | Read a memory file with line paging.                                                                   |
| `memories.search`          | Search memory files with match-mode, path, context-line, case, normalization, and pagination controls. |

The memory feature is stable but disabled by default. Dedicated memory tools
also require `memories.dedicated_tools = true`, which is false by default.
Codex's broader memory pipeline includes extraction, consolidation, prompt
injection, external-context policy, and a dedicated storage layout.

**Verdict:** out of scope. This repository already uses lightweight
`MISTAKES.md`, `LEARNINGS.md`, and `DESIRES.md` notes without introducing a
provider-specific memory backend.

## 11. Skill-resource tools

Source:
[skills extension](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/ext/skills/src/extension.rs)
and
[skill tools](https://github.com/openai/codex/tree/rust-v0.149.1/codex-rs/ext/skills/src/tools).

| Tool          | Purpose                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| `skills.list` | List skills owned by an orchestrator or selected executor, with exact resource handles and pagination. |
| `skills.read` | Read a paginated resource from a listed skill package.                                                 |

These tools are not the ordinary local-skill path. They are exposed when
orchestrator-owned skills are available or when a selected remote executor
contributes capability roots. Host and bundled local skills are usually
injected through context instead.

Pi already has native Agent Skills discovery, explicit `/skill:name`
invocation, automatic loading, and extension-contributed skill paths.

**Verdict:** skip. Pi's native skill system is the better integration boundary.

## 12. Image generation

Source:
[image-generation extension](https://github.com/openai/codex/tree/rust-v0.149.1/codex-rs/ext/image-generation).

| Tool                 | Contract                                                                                                                                                                                                             | Availability                                                                                                                                                                                                       | Pi fit                                                                                                                                                                                                                                               | Verdict                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `image_gen.imagegen` | Generates a new image from `prompt`, or edits up to five local/recent images through mutually exclusive reference mechanisms. Codex uses `gpt-image-2` and returns image bytes plus an optional saved-artifact hint. | Image-generation feature is stable and enabled by default, but the tool requires a non-Free plan, image-capable model, provider image-generation and namespace capabilities, and compatible OpenAI authentication. | This package implements the native namespace, Images API generation and edits, local/recent image selection, artifact persistence, image result, validation, and renderer. It deliberately uses Pi's artifact/session lifecycle rather than Codex's. | **Keep the existing implementation.** |

## 13. Internal synchronization tool

Source:
[test tool schema](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/core/src/tools/handlers/test_sync_spec.rs).

| Tool             | Purpose                                                                                                       | Availability                                                                            | Verdict                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------- |
| `test_sync_tool` | Sleeps before/after an optional rendezvous barrier so integration tests can coordinate concurrent tool calls. | Exposed only when model metadata explicitly lists it as an experimental supported tool. | **Never port. Test infrastructure only.** |

## What is deliberately excluded

The following are model-callable in some Codex sessions but are not fixed
built-in tool names:

- MCP server-provided function tools;
- Apps connector tools;
- client-supplied dynamic function or namespace tools;
- installed plugin tools;
- arbitrary internal extension contributors.

They pass through Codex's generic MCP, dynamic-tool, plugin, or extension
adapters, so a complete name catalog is impossible without a particular runtime
configuration.

## Pi-specific compatibility constraints

1. **Pi tools are flat.** Pi AI `0.84.3` models a tool with `name`,
   `description`, and `parameters`; it does not expose a public namespace-tool
   primitive. Exact ports of `web.run`, `clock.sleep`, multi-agent namespaces,
   memory tools, skill tools, or image generation therefore need provider-level
   serialization or intentionally flattened names. This package owns that
   serialization only for `web.run` and `image_gen.imagegen`.
2. **Pi already has the essential coding surface.** Its built-ins are `read`,
   `bash`, `edit`, `write`, `grep`, `find`, and `ls`; `read` supports images.
3. **Pi already supports deferred activation.** An extension can register many
   tools, initially disable them, then add matching tools with
   `pi.setActiveTools()`. Pi emits native OpenAI tool-search history for capable
   models.
4. **Pi has suitable question UI.** Custom TUI dialogs, RPC UI, timed prompts,
   sequential execution, stateful details, and custom rendering make
   `request_user_input` feasible.
5. **Pi intentionally omits several Codex architectures.** Its documented
   philosophy leaves MCP, sub-agents, permission popups, plan mode, built-in
   todos, and background bash to extensions or separate packages.

## Final recommendation

For this package, the sensible boundary is:

1. **Continue maintaining** `exec_command`, `write_stdin`, `shell_command`,
   `apply_patch`, hosted `web_search`, `web.run`, and `image_gen.imagegen`.
2. **Finish `web.run` reference persistence**, using the existing structured
   result details and canonical-history design rather than a text-only shortcut.
3. **Optionally add `request_user_input`** as a focused, independently
   configurable Pi tool.
4. **Add `tool_search` only after** the package owns enough optional tools to
   justify deferred discovery.
5. **Do not absorb** asynchronous-message, multi-agent, MCP, plugin
   installation, goals, memories, skills, Code Mode, or remote-environment
   runtimes into the compatibility entrypoint.

## Primary sources

- [Codex `0.149.1` release](https://github.com/openai/codex/releases/tag/rust-v0.149.1)
- [Codex `0.149.0...0.149.1` source comparison](https://github.com/openai/codex/compare/rust-v0.149.0...rust-v0.149.1)
- [Core tool planner](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/core/src/tools/spec_plan.rs)
- [Codex feature registry and defaults](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/features/src/lib.rs)
- [Codex app-server built-in extension registry](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/app-server/src/extensions.rs)
- [Pi extension documentation](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi built-in tool overview](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/README.md)
