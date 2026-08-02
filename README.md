# pi-openai-codex-compat

OpenAI Codex compatibility for [Pi](https://github.com/earendil-works/pi-mono), combining priority fast mode, native Codex compaction, and Codex-optimized model features in one Pi package.

## Features

- **Request-level fast mode**: keeps the canonical `openai-codex` provider id and models selected while adding `service_tier: "priority"` at the request boundary.
- **Native compaction**: uses Codex `remote_compaction_v2` for `/compact`, Pi threshold compaction, context-overflow recovery, and an optional percentage threshold.
- **Codex `apply_patch`**: provides an optional patch tool with the Codex grammar, parser, fuzzy matcher, overwrite semantics, filesystem behavior, model-facing result format, structured history, and diff-oriented TUI rendering. Pi sends it as an OpenAI custom grammar tool when the model supports that protocol and as a normal function tool otherwise.
- **Hosted web search**: optionally injects the native Codex `web_search` tool with cached, indexed, or live modes.
- **Native request controls**: configures Responses API text verbosity, reasoning summaries, and GPT-5.6 standard/pro reasoning mode.
- **Session-local settings pane**: `/codex-settings` changes every compatibility setting for the current session; `Ctrl+S` explicitly persists the current values.
- **Compact footer indicators**: non-default Codex request modes are appended to the model side of Pi's normal second footer line.

Pi provides the Codex OAuth flow and model catalog. At session start, this package overrides the built-in `openai-codex` runtime under the same provider id so ordinary responses and remote compaction share one transport, parser, native-history store, and sticky WebSocket session.

## Requirements

- Node.js 22.19 or newer
- Pi `>=0.83.0 <0.84.0`
- An OpenAI Codex login in Pi

Authenticate through Pi if needed:

```text
/login openai-codex
```

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

A trusted project can override it at:

```text
<project>/.pi/openai-codex-compat.json
```

Each session inherits the effective file-backed settings. Open `/codex-settings` to make immediate session-local changes. Press `Ctrl+S` in the pane to persist the current values; the global file is the normal save target, while an existing trusted project override remains the target for that project.

The effective settings are printed once when a TUI session starts. The footer shows `fast` and `pro` only when enabled, and shows text verbosity or reasoning summary only when they differ from their defaults.

Example:

```json
{
  "fastMode": true,
  "applyPatch": true,
  "autoCompactAtPercent": 90,
  "webSearch": "cached",
  "textVerbosity": "low",
  "reasoningSummary": "auto",
  "reasoningMode": "standard"
}
```

Defaults:

| Setting                | Values                                               | Default    | Behavior                                                                                                                                                                                     |
| ---------------------- | ---------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fastMode`             | boolean                                              | `false`    | Adds `service_tier: "priority"` to requests while retaining the current `openai-codex` provider and model.                                                                                   |
| `applyPatch`           | boolean                                              | `true`     | Uses the extension's `apply_patch` tool instead of Pi's active `edit` and `write` tools. Disabling it restores only the tools that the extension suppressed.                                 |
| `autoCompactAtPercent` | number greater than `0` and at most `100`, or `null` | unset      | Adds provider-boundary compaction independently of Pi's normal reserve-token threshold. A project value of `null` disables a global percentage threshold.                                    |
| `webSearch`            | `disabled`, `cached`, `indexed`, `live`              | `cached`   | Controls the hosted Codex web-search tool. Cached mode disallows live external access; indexed mode permits external access while preferring indexed content; live mode permits live access. |
| `textVerbosity`        | `low`, `medium`, `high`                              | `low`      | Sets Responses API `text.verbosity`.                                                                                                                                                         |
| `reasoningSummary`     | `auto`, `concise`, `detailed`, `off`                 | `auto`     | Sets `reasoning.summary` when reasoning is enabled; `off` omits the summary parameter.                                                                                                       |
| `reasoningMode`        | `standard`, `pro`                                    | `standard` | Sets `reasoning.mode` on GPT-5.6 models independently of Pi's reasoning-effort control.                                                                                                      |

Invalid values are ignored and invalid JSON does not prevent Pi from starting. The settings pane never writes on ordinary changes, refuses to overwrite invalid JSON when `Ctrl+S` is pressed, and retains unknown keys when saving. Project configuration is read only when the project is trusted.

## Native compaction

The extension handles native compaction for `openai-codex`. It follows the Codex v2 flow:

1. Send normal Responses history followed by `{ "type": "compaction_trigger" }`.
2. Validate the returned opaque `compaction` item.
3. Retain approximately 64,000 tokens of recent user, developer, and system context.
4. Persist the opaque checkpoint in the Pi session and replay it on later requests.

Ordinary responses and compaction use the same extension-managed SSE/WebSocket transport. The provider stores a native response override only when Pi's canonical assistant representation cannot round-trip the provider output exactly; normal text, reasoning, and tool responses therefore do not duplicate session data. Native overrides are associated with canonical assistants by response id and replayed only when they are present on the active Pi branch.

Switching to another model id while a checkpoint is active is rejected because checkpoints are model-specific. Toggling fast mode does not change the model id or invalidate the checkpoint.

Native compaction fails closed for Codex models: a failed compaction is cancelled instead of silently replacing the opaque state with a local text summary. Other providers continue to use Pi's default compaction behavior. `/tree` branch summarization is intentionally not intercepted.

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

While `applyPatch` is enabled, the extension temporarily disables Pi's active `edit` and `write` tools. Turning the setting off restores only the tools that were active before `apply_patch` replaced them.

Supported operations:

- add files;
- update files with ordered context chunks;
- delete files;
- move an updated file;
- anchor updates at the end of a file.

Compatibility behavior:

- `*** Add File` overwrites an existing file, matching Codex.
- `*** Move to` overwrites an existing destination, matching Codex.
- Hunk matching retries exact text, trailing-whitespace-insensitive text, fully trimmed text, and Codex's Unicode punctuation normalization.
- The parser accepts Codex's lenient marker whitespace, blank update-context lines, and direct heredoc wrappers.
- Successful model-facing results use Codex's exit-code, wall-time, and `Success. Updated the following files:` format.
- Tool-result history stores per-file old/new content, display diffs, move destinations, overwrite information, and committed-prefix details after runtime failures.
- The TUI renders Codex-style `Added`, `Edited`, and `Deleted` diff blocks instead of the raw model-facing result.

Filesystem behavior:

- Relative paths resolve from Pi's current working directory; absolute paths and `..` traversal are honored.
- `.git` paths and symlinks follow normal host filesystem semantics.
- The extension does not add path filtering, sandboxing, or approval prompts.
- Every hunk is parsed and validated before filesystem writes begin.
- Mutations participate in Pi's per-file mutation queue and `apply_patch` calls execute sequentially.

A low-level I/O failure can still leave a multi-file patch partially applied. The failed tool result records the known committed prefix, but inspect the working tree before retrying when that record is marked inexact.

## Development

```bash
mise trust
mise install
npm install
npm run check
npm test
```

The focused Pi AI serializer copy lives under `extensions/openai-codex-compat/vendor/pi-ai/`. The custom Codex provider transport and stream parser are focused adaptations of Pi AI's corresponding implementation. Equivalence and protocol tests cover canonical serialization, raw native replay, SSE request behavior, WebSocket reuse, grammar tools, and compaction continuation.

## Release staging

The GitHub Actions workflow stages npm releases when a `v*` tag is pushed. The tag must match `package.json` version and point at a commit whose subject is `release: v<version>`.

## Acknowledgements

The remote-compaction implementation follows the current OpenAI Codex `remote_compaction_v2` protocol. The `apply_patch` grammar, parser, matcher, mutation semantics, result format, and compatibility scenarios are adapted from OpenAI Codex under Apache-2.0. The Codex provider transport, stream processing, and OpenAI Responses history serialization adapt selected Pi AI methods under MIT; see [third-party notices](THIRD_PARTY_NOTICES.md).

## License

MIT © 2026 Kaan Ozdokmeci. See [LICENSE](LICENSE).
