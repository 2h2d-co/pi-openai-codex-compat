# Focused Pi AI code copies

This directory intentionally contains only the Pi AI methods needed to serialize checkpoint and native replay history for OpenAI's Responses API. It does not contain Pi AI's complete source dependency graph.

[`openai-responses-serialization.ts`](openai-responses-serialization.ts) adapts the relevant methods from `@earendil-works/pi-ai@0.86.0`. Its header lists the upstream source files. It also carries the strict JSON-schema conversion from `src/api/constrained-sampling.ts`; Pi's built-in tools request strict sampling, and Codex rejects `strict: true` without that subset. Keep the wire-equivalence tests in [`test/pi-ai-serialization.test.ts`](../../../../test/pi-ai-serialization.test.ts) passing when updating the Pi dependencies.

Pi AI's transcript helpers replay system sections and tool declarations.
`supportsAdditionalTools` and `supportsToolSearch` select the dynamic tool
history representation for additive `toolsAdded` system messages:
message-anchored `additional_tools` or a `tool_search_call`/`tool_search_output`
pair. The copy keeps both options so the wire-equivalence tests hold, but Compat
always passes `false`: it declares every tool at the top level.

System messages follow Pi AI exactly. Compat passes `includeSystemPrompt: false`
because the leading system message travels as `instructions`, and forwards the
model's `supportsMidConvoSystemMessages` flag so later system messages render
inline through `renderSystemMessageUpdate` or collapse into the leading message.
A system message that lands between a tool call and its results is held until
after those results, as upstream `transformMessages` does.

The optional `namespacedToolNames`, `textContentItemToolResultNames`, and `toolResultImageDetail` paths are extension-owned additions. Without those options, serialization must continue to match Pi AI. `namespacedToolNames` groups only the fixed Codex allowlist into native Responses namespaces and replays namespace/member call identities. `textContentItemToolResultNames` preserves Codex tools such as `web.run` whose successful text output is transported as an `input_text` content-item array instead of Pi's usual plain string. `toolResultImageDetail` overrides the otherwise canonical `auto` detail used for image tool-result content.

The local copy is necessary because Pi's extension loader does not expose `@earendil-works/pi-ai/api/openai-responses-shared` to extensions.

The focused provider transport and stream-processing adaptations live in [`codex-transport.ts`](../../codex-transport.ts) and [`codex-stream.ts`](../../codex-stream.ts).

Upstream: <https://github.com/earendil-works/pi/tree/main/packages/ai>

License: MIT; see [`LICENSES/pi-ai-MIT.txt`](../../../../LICENSES/pi-ai-MIT.txt).
