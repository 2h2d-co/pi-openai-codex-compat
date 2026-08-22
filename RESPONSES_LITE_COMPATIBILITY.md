# Responses Lite compatibility report

This report compares the package's Responses Lite path with the official OpenAI Codex CLI.
It separates the wire envelope from Codex runtime behavior that a Pi provider extension cannot
or intentionally does not reproduce.

## Baselines

| Baseline                     | Revision                                   | Default-tool representation in `additional_tools`     |
| ---------------------------- | ------------------------------------------ | ----------------------------------------------------- |
| Official Codex CLI `0.149.0` | `758ef40f50c1a458425c7cfbf1eb12cbc07af0b0` | One canonical `functions` namespace                   |
| Contract release `0.147.0`   | `be6e8eac029b183056b7e4402879f15d2c85f61b` | One canonical `functions` namespace                   |
| Previous Codex CLI `0.146.0` | `e363b08c9175ac1cbe5893615dd2cb9ddf95043b` | Direct top-level `function` and `custom` declarations |
| Namespace migration          | `f21dc4638803f40046c9e294b0349782928f6b36` | Introduced the contract released in `0.147.0`         |

The package targets the official `0.149.0` contract, whose default-tool layout remains unchanged
from `0.147.0`. It does not add a legacy `0.146.0` tool-layout mode. The earlier cache report's
recommendation to remove the `functions` namespace was based on a `0.146.0` capture; the following
release made the package's grouped representation official behavior.

## Aligned wire contract

For supported GPT-5.6 models with `responsesLite: true`, the package now matches the current
first-party contract in these areas:

| Area             | Package and current Codex behavior                                                                                                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instructions     | Remove top-level `instructions` and prepend a developer `message` after `additional_tools` when instructions are non-empty.                                                                                                                     |
| Tools            | Remove top-level `tools`; prepend a developer `additional_tools` item even when its tool list is empty.                                                                                                                                         |
| Default tools    | Coalesce top-level `function`, top-level `custom`, and explicit `functions` members into one `functions` namespace. Preserve first-occurrence ordering, a non-empty explicit namespace description, and an empty default description otherwise. |
| Other namespaces | Preserve native namespace declarations and their member identities.                                                                                                                                                                             |
| Empty namespace  | Omit an empty `functions` namespace.                                                                                                                                                                                                            |
| Tool calls       | Preserve flat default function/custom replay calls and map missing, empty, or explicit `functions` response namespaces to Pi's bare tool name.                                                                                                  |
| Continuations    | Preserve the server's exact default-call namespace form in native overrides; ordinary flat calls round-trip canonically and remain valid aliases for the grouped tool declaration.                                                              |
| Hosted tools     | Omit hosted web/image declarations from the Lite path; Pi's separately configured `web.run` and `image_gen.imagegen` tools use native namespaces.                                                                                               |
| Images           | Omit `detail` from `input_image` content in messages and tool outputs.                                                                                                                                                                          |
| Reasoning        | Send `reasoning.context: "all_turns"`.                                                                                                                                                                                                          |
| Parallel calls   | Send `parallel_tool_calls: false`.                                                                                                                                                                                                              |
| HTTP/SSE marker  | Send `x-openai-internal-codex-responses-lite: true` as a header, not as WebSocket compatibility metadata in the HTTP body.                                                                                                                      |
| WebSocket marker | Send `client_metadata.ws_request_header_x_openai_internal_codex_responses_lite = "true"` in each `response.create` body, without putting the Lite HTTP header on the handshake.                                                                 |
| WebSocket timing | Stamp each outgoing body with `client_metadata.x-codex-ws-stream-request-start-ms`.                                                                                                                                                             |
| Static prewarm   | Send `generate: false` with only `additional_tools` and the developer-instruction item, then continue with the dynamic input through `previous_response_id`.                                                                                    |
| Prewarm metadata | Use the startup turn id `""` and omit `turn_started_at_unix_ms`; generated turns retain their real turn id and start time.                                                                                                                      |
| Compaction       | Apply the same Lite envelope, all-turn reasoning context, disabled parallel calls, and transport marker to native compaction requests.                                                                                                          |

Malformed members inside an explicit `functions` namespace now fail closed instead of producing a
wire shape that the strongly typed official implementation cannot construct.

## Remaining intentional differences

| Area                       | Difference and rationale                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Activation                 | The package keeps the user-requested `responsesLite` setting default-off and restricts it to Sol, Terra, and Luna. Official Codex activates Lite from remotely supplied model metadata.                                                                                                                                                                                                                    |
| Version compatibility      | The package follows official Codex `0.149.0` and intentionally does not provide a legacy direct-declaration mode for `0.146.0` or older clients.                                                                                                                                                                                                                                                           |
| Namespace capability       | This provider targets the first-party `openai-codex` endpoint and always uses its namespace-capable contract. Official Codex can fall back to direct declarations for custom providers without namespace support.                                                                                                                                                                                          |
| Tool surface               | Pi and Codex expose different built-in tools and schemas. The package only maps Pi's default tools plus the fixed native `web.run` and `image_gen.imagegen` allowlist; it does not reproduce Codex Code Mode, collaboration, MCP, plugin, or environment tools.                                                                                                                                            |
| Hosted-tool planning       | The package removes hosted web/image tools during its Lite transformation. Official Codex normally prevents those declarations earlier while constructing the prompt and substitutes eligible standalone extensions. The resulting first-party wire request is equivalent.                                                                                                                                 |
| Startup timing             | Official Codex can begin prewarm asynchronously during session startup. Pi does it synchronously at the first provider request boundary because extensions do not own Pi session construction.                                                                                                                                                                                                             |
| Prompt and initial context | Pi supplies its own system prompt, permissions, tools, and conversation history. It does not reproduce Codex's permissions, team, plugin, workspace, or multi-agent initial-context messages.                                                                                                                                                                                                              |
| Image preparation          | Pi supplies normal attachments as data URLs and strips Lite detail, but it does not reproduce Codex's complete image resizing, unified image budget, remote-URL replacement, or resize-notice pipeline.                                                                                                                                                                                                    |
| Dynamic namespaces         | Official Codex can register arbitrary MCP/plugin namespaces. Pi exposes dotted tools as flat names, so this package accepts only its fixed native namespace allowlist and fails closed on unknown namespaces.                                                                                                                                                                                              |
| Model metadata             | Pi's model objects do not expose Codex's `use_responses_lite` or provider `namespace_tools` capability fields. The package uses an explicit model allowlist and setting instead.                                                                                                                                                                                                                           |
| Streaming summaries        | The package does not request Codex's optional `reasoning_summary_delivery: "sequential_cutoff"` stream mode.                                                                                                                                                                                                                                                                                               |
| Tracing and attestation    | Official Codex may add W3C trace metadata, attestation, client version, and Codex-specific originator/feature headers. The package identifies itself as Pi and does not impersonate those client-specific values.                                                                                                                                                                                          |
| Turn metadata              | Pi sends its real unsandboxed execution label and Pi session lineage. It does not fabricate Codex Git workspace state, Code Mode tool maps, forks, subagents, or plugin metadata.                                                                                                                                                                                                                          |
| Retry ownership            | Pi history remains canonical. The package resamples retryable protocol terminals from completed native output and follows `end_turn: false`, but still fails closed on transport failures after visible output and keeps pre-output WebSocket/SSE recovery bounded. Official Codex owns the complete rollout/sampling loop and retries sampling connection-establishment failures indefinitely by default. |

## Known unintentional differences

No remaining unintentional difference is known in the core Responses Lite envelope for the
supported first-party path. This includes the thread-scoped HTTP `x-client-request-id`; it does not
claim byte-identical prompts, tools, metadata, or runtime behavior listed above.

## Validation

The automated suite covers:

- upstream-equivalent namespace grouping, description, ordering, and empty-namespace behavior;
- function and custom call namespace mapping;
- image-detail removal;
- HTTP versus WebSocket Lite marker placement;
- per-WebSocket-request start timestamps;
- prewarm metadata and static-prefix construction;
- `generate: false` continuation through `previous_response_id`;
- SSE, WebSocket, native compaction, and fallback behavior.

Live validation should use the local extension with:

```bash
PI_OPENAI_CODEX_COMPAT_RESPONSES_LITE=true \
pi --no-extensions -e .
```

The resulting Pi session diagnostics identify the selected envelope, static-prefix fingerprints,
request sizes, continuation response ids, transport retries, and cache-token usage.

The final live validation used local source with `gpt-5.6-luna` for three text turns and three
forced function-tool turns. Every generated request used the existing WebSocket and
`previous_response_id`. Text turns sent one new user item; later tool turns sent only the preceding
tool result plus the new user item. No local continuation bypass or SSE fallback occurred. The
small tool prompt remained below a useful cache-reporting threshold, so its zero cache reads do not
measure the large-prefix cache trajectory.
