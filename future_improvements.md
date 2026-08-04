# Future Improvements

## Preserve transformed context when reconstructing Codex history

The custom Codex provider currently reconstructs wire history from the active
session branch so it can install native compaction checkpoints and replay raw
Responses items. In normal Pi usage with no other context-transforming
extensions, this remains consistent with the context supplied to Pi AI.

Pi's `context` hook can, however, filter, redact, inject, rewrite, or reorder
messages before each provider request. Reconstructing history from the
underlying branch bypasses those transformations. Direct provider or SDK calls
that deliberately supply a context different from the active session branch
have the same mismatch.

Update history construction to use the transformed `Context.messages` as its
source of truth, then overlay native response items and opaque Codex
checkpoints. The implementation must avoid duplicating retained messages around
a checkpoint and must preserve the current native compaction and namespace
semantics.

## Support Bun WebSocket proxy configuration

The Codex transport accepts Pi's provider environment options but does not use
them when creating WebSockets under Bun. Pi AI resolves HTTP and HTTPS proxy
settings from the provider environment and process environment, respects
`NO_PROXY`, and supplies the selected proxy to Bun's WebSocket constructor.

Add the same proxy selection when Bun is the active runtime. Node behavior
should remain unchanged, and unsupported proxy protocols should fail with a
clear error.
