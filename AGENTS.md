# Agent Instructions

- This project is a Pi package with a TypeScript extension entrypoint.
- Pi extensions run with full system permissions; keep side effects explicit and documented.
- Keep `extensions/index.ts` as a thin public entrypoint; provider, compaction, request-option, and tool behavior belongs in focused modules under `extensions/openai-codex-compat/`.
- Preserve canonical `openai-codex` assistant history when changing fast-mode request behavior.
- Keep `/codex-settings` aligned with `/anthropic-settings`: Enter edits drafts,
  Apply to session persists settings with the session without configuration-file writes, Ctrl+S saves
  and applies, and Escape discards only unapplied drafts. Reopening must show
  active session values, not file values. Restore session settings across reload,
  restart, and resume. Keep them scoped to the session identity, not its branches
  or process lifetime. Preserve
  changed-field persistence, inheritance, conflict detection, and the shared
  interaction tests in `test/settings-menu.test.ts`. Never terminate persistent
  command sessions while browsing or discarding settings.
- Native Codex compaction must fail closed and must not intercept `/tree` branch summarization.
- Follow Pi AI's Codex adapter for system messages: the leading system message is the prompt (`instructions`, or the Responses Lite developer prefix), and later system messages travel inline as developer items on models that accept mid-conversation system messages. Do not replay every system message into one current prompt. Native compaction must keep every developer and system message in place and outside the retained-context budget; only user messages are budgeted.
- Declare the complete current tool set in the top-level `tools` field on every request and never inside `input`. Do not replay `toolsAdded` system messages as inline `additional_tools` items or synthetic tool-search pairs, even though the public Responses API documents them: the Codex backend then treated other tools as unavailable in about half of live attempts, and the official Codex CLI never emits them mid-conversation. A mid-session tool change costs one prompt-cache miss by design. Pi's in-memory transcript can predate a runtime-appended checkpoint, so derive history (`input`) from the branch and only replayed projections (current tools, leading prompt) and request-local system messages from the transcript. Place a request-local system message after the nearest earlier request message stored on the branch.
- `apply_patch` must validate all hunks before writes and participate in Pi's file mutation queue.
- `apply_patch` assumes relevant filesystem state is not modified outside its queued execution window. Keep execution simple: trust standard Node filesystem operations, verify direct result postconditions, and do not add cross-process drift, inode-continuity, or extension-local alias-locking machinery.
- When asked to check a new official Codex CLI release, follow `OFFICIAL_CODEX_CLI_RELEASES.md`, compare the newest stable tag with the previous reviewed stable tag, and append the protocol and `apply_patch` decisions without silently reopening recorded deviations.
- When explaining model/provider context layouts, use concrete, traceable history transformations rather than mixing context with control flow: define a compact symbol legend, show each request/response as an ordered item list, walk each case independently, contrast valid and invalid layouts, and state which items are committed, discarded, compacted, or carried forward. Distinguish the logical full context from transport optimizations such as `previous_response_id` plus a suffix, and end with the key invariant or concise before/after summary.
- Add changelog entries for user-visible changes under `Unreleased`.
- Run `npm run pack:dry` to inspect the npm package contents before release.
- Keep changelog entries under `Unreleased` for prereleases and move them into a release section only for stable releases.
- Use `npm run release -- <version>` to build the release locally, record its SHA-256 in an SSH-signed `release: v<version>` commit, prove a clean rebuild is reproducible, and create the matching lightweight tag.
- Push release commits and tags atomically; do not create annotated or signed tag objects.
- The tag workflow creates the immutable GitHub release from the verified archive and the version's changelog section. Never create GitHub releases by hand.
- Run `mise run check` before committing meaningful code changes. Never bind `PI_PACKAGE_DIR` for tests: `npm test` and `npm run test:live:codex` remove an inherited value so Pi resolves its own package directory.
- Gate new model capabilities on the actual Codex endpoint, not public Responses API documentation. Extend the packaged CLI and WebSocket live matrices when adding supported models, and retain exact tool-argument assertions with explicit extraction instructions.
- Live tests report every error they meet as a test diagnostic, even when they pass: extension error and warning notices, extension errors, and failed responses. Use `test/support/error-log.ts`. Summarize failed responses by stop reason, HTTP status, and error category; never print provider error text or credentials.
- Keep tests in `test/*.test.ts`, code that tests import or load into Pi in `test/support/`, and test data in `test/fixtures/`.
