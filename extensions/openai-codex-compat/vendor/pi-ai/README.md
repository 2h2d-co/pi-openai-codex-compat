# Focused Pi AI code copies

This directory intentionally contains only the Pi AI methods needed to serialize checkpoint history for OpenAI's Responses API. It does not contain Pi AI's complete source dependency graph.

[`openai-responses-serialization.ts`](openai-responses-serialization.ts) adapts the relevant methods from `@earendil-works/pi-ai@0.83.0`. Its header lists the upstream source files. Keep the behavioral equivalence test in [`test/pi-ai-serialization.test.ts`](../../../../test/pi-ai-serialization.test.ts) passing when updating the Pi dependencies.

The local copy is necessary because Pi's extension loader does not expose `@earendil-works/pi-ai/api/openai-responses-shared` to extensions.

Upstream: <https://github.com/earendil-works/pi/tree/main/packages/ai>

License: MIT; see [`LICENSES/pi-ai-MIT.txt`](../../../../LICENSES/pi-ai-MIT.txt).
