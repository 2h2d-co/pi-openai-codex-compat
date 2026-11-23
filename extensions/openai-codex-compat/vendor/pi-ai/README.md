# Focused Pi AI code copies

This directory intentionally contains only the Pi AI methods needed to serialize checkpoint and native replay history for OpenAI's Responses API. It does not contain Pi AI's complete source dependency graph.

[`openai-responses-serialization.ts`](openai-responses-serialization.ts) adapts the relevant methods from `@earendil-works/pi-ai@0.86.0`. Its header lists the upstream source files. It also carries the strict JSON-schema conversion from `src/api/constrained-sampling.ts`; Pi's built-in tools request strict sampling, and Codex rejects `strict: true` without that subset. Keep the wire-equivalence tests in [`test/pi-ai-serialization.test.ts`](../../../../test/pi-ai-serialization.test.ts) passing when updating the Pi dependencies.

The copy also includes Pi 1.0.0's tool-call item-ID guard: same-model replay
preserves valid `fc_` function IDs and `ctc_` grammar IDs, while incompatible
item IDs are omitted without changing the `call_id` that pairs calls with results.

Pi AI's transcript helpers replay system sections and tool declarations.
`supportsAdditionalTools` and `supportsToolSearch` select Pi AI 1.4.0's tool
change mode. With mid-conversation system messages, `supportsAdditionalTools`
declares every tool in `additional_tools` items and announces removals as text.
`supportsToolSearch` adds later tools with a `tool_search_call`/`tool_search_output`
pair. The copy keeps both options so the wire-equivalence tests hold, but Compat
always passes `false`: it declares every tool at the top level.

System messages follow Pi AI. Pi AI 1.6.0 always serializes the leading system
message as the first developer item and dropped its `includeSystemPrompt` option.
The copy keeps that option as an extension-owned addition: Compat passes
`includeSystemPrompt: false` because it builds requests with the prompt in
`instructions`, which native compaction templates and cache diagnostics read, and
moves it to the first developer message when sending. Compat also forwards the
model's `supportsMidConvoSystemMessages` flag so later system messages render
inline through `renderSystemMessageUpdate` or collapse into the leading message.
A system message that lands between a tool call and its results is held until
after those results, as upstream `transformMessages` does.

The copy also includes Pi AI 1.6.0's `configurationUpdateEffort`: before every
earlier reply of the same model it replays the thinking level recorded on it
(`providerThinkingLevel`) as a `configuration_update` item, and it ends the input
with one for the request's own level. Native reply items replay behind the same
item. It also carries Pi AI 1.6.0's strict-schema rule that a node without a type
is not strict.

The copy replays a function call name that Codex rejects as `invalid_tool_name_<hash>`, which Pi AI does not. Codex accepts a replayed name only when it has 1 to 128 letters, digits, `_`, `.`, or `-`. Another model can return a call whose name breaks that rule, such as a whole shell command. Pi answers such a call "not found", and replaying its name unchanged would make every later Codex request fail. The hash keeps the placeholder stable across requests, and the `call_id` still pairs the call with its result. Valid names serialize exactly as in Pi AI.

The optional `namespacedToolNames`, `textContentItemToolResultNames`, and `toolResultImageDetail` paths are extension-owned additions. Without those options, serialization must continue to match Pi AI. `namespacedToolNames` groups only the fixed Codex allowlist into native Responses namespaces and replays namespace/member call identities. `textContentItemToolResultNames` preserves Codex tools such as `web.run` whose successful text output is transported as an `input_text` content-item array instead of Pi's usual plain string. `toolResultImageDetail` overrides the otherwise canonical `auto` detail used for image tool-result content.

The local copy is necessary because Pi's extension loader does not expose `@earendil-works/pi-ai/api/openai-responses-shared` to extensions.

The focused provider transport and stream-processing adaptations live in [`codex-transport.ts`](../../codex-transport.ts) and [`codex-stream.ts`](../../codex-stream.ts).

Upstream: <https://github.com/earendil-works/pi/tree/main/packages/ai>

License: MIT; see [`LICENSES/pi-ai-MIT.txt`](../../../../LICENSES/pi-ai-MIT.txt).
