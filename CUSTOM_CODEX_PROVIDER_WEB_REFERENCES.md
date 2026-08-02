# Custom Codex Provider: Web Search References and Citations

This document specifies how a custom `openai-codex` provider should capture, persist, replay, and render web-search source metadata while replacing Pi AI's built-in Codex provider.

The design supports both:

1. hosted Responses API `web_search`, where source data arrives as output-text annotations; and
2. Codex-style `web.run`, where the search service returns model-facing text plus structured results containing reference IDs and URLs.

## Current implementation status

The extension now implements `web.run` as a native Responses namespace, executes it through Codex `alpha/search`, and persists structured `results` in the corresponding Pi tool-result `details`. The durable cross-call reference store, hosted-search citation capture, citation rendering, and direct-link materialization described below remain future work.

The provider must not depend on opaque text such as `turn0search0` or `citeturn0search0` to reconstruct a source. The mapping must be captured when the provider or web tool receives the structured response.

## Dictionary

- **Canonical text**: The exact assistant text returned by the upstream provider and replayed to that provider on later requests.
- **Display text**: Text prepared for Pi's UI, which may materialize structured citations as Markdown links.
- **Reference ID**: An opaque search-result handle such as `turn0search0`.
- **Citation annotation**: Structured Responses API metadata containing a cited URL, title, and text range.
- **Reference store**: The custom provider's storage backend for canonical assistant output, citation annotations, and web-search results.
- **Text-part key**: A stable identifier for one assistant output-text part, normally composed from the Pi session ID, provider response ID, output item ID, and content index.

## Required outcome

The implementation must satisfy these invariants:

1. Reference IDs are never resolved from their spelling.
2. Every rendered link comes from trusted structured provider or tool output.
3. Canonical provider history remains available even if Pi stores display-oriented text.
4. A storage or rendering failure does not fabricate a citation.
5. A final answer should normally contain direct Markdown links, matching current Codex `web.run` behavior.
6. Raw `cite…` markers are a compatibility fallback, not the primary citation format.
7. Retries, reconnects, and duplicate stream events are idempotent.
8. Session resume, branching, and native compaction do not invalidate source records needed by the UI.

## Provider identity

The replacement provider should retain the canonical identities:

```ts
const PROVIDER_ID = "openai-codex";
const API_ID = "openai-codex-responses";
```

Keeping these values preserves model selection, authentication expectations, provider-scoped behavior, and canonical Codex assistant history. Register a custom `streamSimple` implementation for the existing provider instead of introducing a second provider identity solely for citation support.

The custom provider receives `options.sessionId`; use it as the Pi-session namespace for provider storage and request correlation.

## Data sources

### Hosted Responses API `web_search`

Capture URL citations from both streaming and completed response data:

- `response.output_text.annotation.added`
- `response.output_item.done`
- the terminal response's completed output, when available

The completed output item is authoritative. Streaming annotation events can support progressive UI updates, but must be reconciled against the completed item before finalizing the assistant message.

A URL citation normally contains:

```ts
interface UrlCitationAnnotation {
  type: "url_citation";
  url: string;
  title: string;
  start_index: number;
  end_index: number;
}
```

Preserve unknown annotation types and fields as opaque JSON so additions to the upstream protocol do not require an immediate provider release.

### Codex-style `web.run`

Codex's standalone web-search flow returns two channels:

```ts
interface SearchResponse {
  output: string;
  results?: unknown[];
}
```

- `output` is plaintext sent back to the model as tool output.
- `results` is structured metadata retained outside the model-facing text.

A text result can contain:

```ts
interface TextSearchResult {
  type: "text_result";
  ref_id: string;
  url: string;
  title?: string;
  [key: string]: unknown;
}
```

The web tool and custom provider should share the same reference-store abstraction. Record `results` before returning the tool result to the model.

The `web.run` tool instructions should require the model to:

- use reference IDs only in later `web.run` operations;
- never expose reference IDs in final responses; and
- cite sources with direct Markdown links.

## Storage model

The backend may use SQL, a document store, or another transactional system. The logical records should be equivalent to the following.

### Provider response

```ts
interface StoredProviderResponse {
  sessionId: string;
  responseId: string;
  provider: "openai-codex";
  api: "openai-codex-responses";
  modelId: string;
  status: "streaming" | "completed" | "incomplete" | "failed" | "aborted";
  createdAt: number;
  completedAt?: number;
}
```

### Assistant text part

```ts
interface StoredTextPart {
  sessionId: string;
  responseId: string;
  itemId: string;
  contentIndex: number;
  phase?: "commentary" | "final_answer";

  canonicalText: string;
  displayText?: string;
  canonicalTextHash: string;
  annotations: StoredAnnotation[];
}
```

### Annotation

```ts
interface StoredAnnotation {
  annotationIndex: number;
  type: string;
  startIndex?: number;
  endIndex?: number;
  refId?: string;
  url?: string;
  title?: string;
  raw: unknown;
}
```

### Web-search call and result

```ts
interface StoredWebSearchCall {
  sessionId: string;
  callId: string;
  requestId?: string;
  action: unknown;
  status: "started" | "completed" | "failed";
  createdAt: number;
  completedAt?: number;
}

interface StoredWebSearchResult {
  sessionId: string;
  callId: string;
  refId: string;
  type: string;
  url?: string;
  title?: string;
  raw: unknown;
}
```

Recommended uniqueness constraints:

```text
provider response:  (session_id, response_id)
text part:          (session_id, response_id, item_id, content_index)
annotation:         (session_id, response_id, item_id, content_index, annotation_index)
search call:        (session_id, call_id)
search result:      (session_id, call_id, ref_id)
```

Do not key records only by `turn0search0`. Reference IDs may be reused in another session or search context.

## Reference-store interface

Keep persistence behind a provider-owned interface:

```ts
interface CodexReferenceStore {
  beginResponse(response: StoredProviderResponse): Promise<void>;

  upsertTextPart(part: StoredTextPart): Promise<void>;

  finalizeResponse(input: {
    sessionId: string;
    responseId: string;
    status: StoredProviderResponse["status"];
    completedAt: number;
  }): Promise<void>;

  beginWebSearch(call: StoredWebSearchCall): Promise<void>;

  completeWebSearch(input: {
    call: StoredWebSearchCall;
    results: StoredWebSearchResult[];
  }): Promise<void>;

  getTextPart(input: {
    sessionId: string;
    responseId: string;
    itemId: string;
    contentIndex: number;
  }): Promise<StoredTextPart | undefined>;

  resolveReferences(input: {
    sessionId: string;
    refIds: string[];
    callId?: string;
  }): Promise<Map<string, StoredWebSearchResult>>;
}
```

All writes must be idempotent upserts. A WebSocket reconnect or Responses API retry may replay events that have already been stored.

## Stable correlation with Pi messages

Pi's current `TextContent` does not contain citation annotations. The provider therefore needs stable handles that survive session persistence.

For every assistant output item:

1. set `AssistantMessage.responseId` to the upstream response ID;
2. preserve the upstream message item ID in `TextContent.textSignature`;
3. preserve the Codex message phase in the same signature; and
4. use the text block's content index as the final key component.

Use Pi's canonical signature shape:

```ts
interface CodexTextSignature {
  v: 1;
  id: string;
  phase?: "commentary" | "final_answer";
}
```

Example:

```ts
textBlock.textSignature = JSON.stringify({
  v: 1,
  id: outputItem.id,
  phase: outputItem.phase,
});
```

This allows the provider and renderer to retrieve metadata using:

```text
session ID + response ID + text-signature item ID + content index
```

Do not put URLs, complete result objects, or large annotation payloads inside `textSignature`.

## Streaming algorithm

### Response start

On `response.created`:

1. capture `response.id`;
2. assign it to `AssistantMessage.responseId`;
3. create a `streaming` provider-response record; and
4. initialize in-memory output slots by upstream output index.

Do not emit the final `done` event until the response metadata needed for replay has been committed or a documented storage-degradation path has been selected.

### Output item start

On `response.output_item.added` for an assistant message:

1. create the Pi text block;
2. attach the item ID and phase through `textSignature`;
3. create an annotation buffer for each content part; and
4. emit `text_start`.

### Text deltas

On `response.output_text.delta`:

1. append the exact delta to canonical text;
2. avoid Unicode normalization or whitespace rewriting;
3. emit the original delta through `text_delta`; and
4. update any in-memory checksum used for persistence.

Annotation offsets refer to the upstream text. Any transformation before annotation reconciliation can invalidate them.

### Annotation events

On `response.output_text.annotation.added`:

1. identify the response output index, item ID, and content index;
2. type-guard known annotation shapes;
3. retain the complete raw annotation;
4. upsert it in the in-memory annotation buffer by annotation index; and
5. optionally persist it as provisional metadata.

Do not inject Markdown punctuation into the text delta stream when an annotation arrives. Adding characters during streaming changes all later offsets.

### Completed output item

On `response.output_item.done`:

1. replace provisional canonical text with the completed item's exact text;
2. replace or reconcile provisional annotations with the completed annotation array;
3. validate every known annotation range;
4. derive display text, if the provider is responsible for materialization;
5. persist the completed text part and annotations; and
6. emit `text_end`.

The completed item wins when delta accumulation and completed text disagree.

### Terminal response

On `response.completed` or `response.incomplete`:

1. reconcile any metadata available only on the terminal response;
2. persist usage, response status, and completion time;
3. commit the response transaction;
4. set the final Pi stop reason; and
5. emit `done`.

On failure or abort:

- finalize the response as `failed` or `aborted`;
- retain already received canonical text and annotations for diagnostics;
- never mark partial metadata as a completed response; and
- emit Pi's normal error event.

## Canonical text versus display text

There are two valid implementation strategies.

### Strategy A: Canonical Pi history plus metadata-aware renderer

Store canonical text in the Pi assistant message and use the reference store only during rendering.

Advantages:

- Pi history exactly matches upstream Codex history.
- Provider replay remains straightforward.
- No reverse transformation is required.

Requirement:

- Pi needs a renderer path that can resolve metadata for normal assistant messages. The current public extension API does not provide a complete override for the built-in assistant renderer, so this strategy may require a Pi core change.

### Strategy B: Display text in Pi plus canonical replay from provider storage

Materialize citation annotations as Markdown links before `text_end`, store that display text in the Pi message, and retain canonical text in the provider backend.

On later provider requests:

1. read `responseId` and `textSignature` from the Pi assistant message;
2. retrieve the corresponding canonical text part;
3. serialize canonical text, not display text, into Responses history; and
4. preserve the original phase and item identity.

Advantages:

- Pi's existing Markdown renderer can display links immediately.
- No Pi core renderer change is required.

Costs:

- the custom provider serializer must own canonical history reconstruction;
- missing provider storage requires an explicit fallback; and
- session exports contain display text rather than the exact upstream text.

For a provider that already owns durable storage and custom history serialization, Strategy B is the practical short-term approach. Strategy A remains the cleaner long-term Pi integration.

## Materializing citation annotations

When converting URL annotations to Markdown:

1. validate that `startIndex` and `endIndex` are within the canonical text;
2. verify that annotation ranges do not overlap incompatibly;
3. apply replacements from the highest start index to the lowest;
4. allow only `http` and `https` destinations;
5. escape Markdown link labels and destinations correctly;
6. avoid wrapping text that is already inside an equivalent Markdown link; and
7. retain the canonical text and original offsets in storage.

Conceptually:

```ts
function materializeUrlCitations(
  canonicalText: string,
  citations: UrlCitationAnnotation[],
): string {
  return [...citations]
    .sort((a, b) => b.start_index - a.start_index)
    .reduce((text, citation) => {
      const label = text.slice(citation.start_index, citation.end_index);
      return (
        text.slice(0, citation.start_index) +
        markdownLink(label, citation.url) +
        text.slice(citation.end_index)
      );
    }, canonicalText);
}
```

The real implementation must define and test the upstream offset convention. Do not assume byte offsets. JavaScript string slicing uses UTF-16 code units, so emoji and combining-character cases need explicit fixtures.

## Handling `cite…` markers

The preferred flow prevents these markers from appearing. If upstream text still contains them, resolve them only as a finalization compatibility step.

Example marker:

```text
citeturn1search0turn1search1
```

Required behavior:

1. parse the complete marker only after all its text has arrived;
2. preserve reference order while deduplicating repeated IDs;
3. query the reference store within the current session namespace;
4. replace resolved IDs with direct Markdown links;
5. never guess a URL for an unresolved ID; and
6. record unresolved IDs in provider diagnostics.

If any mapping is unavailable, retain the canonical marker in provider storage. The display policy may leave it visible or render a clear “source unavailable” indicator, but must not silently attach an unrelated URL.

## Web-tool integration

If `web.run` is implemented as a Pi tool rather than inside the provider stream, the tool should receive the shared reference store through dependency injection.

The order of operations must be:

```text
execute search request
  → validate response
  → persist search call and structured results
  → return plaintext output to the model
```

Do not rely on a later `tool_execution_end` observer as the only persistence point. The tool implementation itself has the complete typed response and can commit it before the model receives the result.

The tool result sent to the model should remain plaintext. Structured results belong in the reference store and, optionally, in tool-result `details` for session diagnostics. They should not be duplicated into the visible model context unless the search protocol requires them.

## History replay

The custom provider must control assistant-history serialization.

For each assistant text block:

1. parse `textSignature`;
2. look up canonical text by session, response, item, and content index;
3. serialize the canonical `output_text`;
4. preserve the item ID and message phase;
5. preserve citation annotations only if the upstream endpoint accepts replayed annotations; otherwise omit annotations while keeping canonical text; and
6. fall back to Pi's stored text only when no canonical record exists.

Fallbacks must be observable. Add a diagnostic such as:

```text
canonical_history_miss
```

with the session, response, item, and content index—but never log assistant text, URLs with credentials, or authentication data.

## Branching and compaction

### Branching

Do not key records by a mutable turn number. Pi branches share historical messages, while later messages diverge.

Provider response IDs and item IDs are immutable and can be shared safely across branches when namespaced by Pi session ID. If branch-specific retention is needed, keep a separate reachability table rather than copying source records.

### Native compaction

Native Codex compaction may replace old provider input with an opaque checkpoint. Citation records should remain available for:

- rendering historical Pi messages;
- session export;
- branch inspection; and
- diagnostics.

Do not delete citation records merely because a message is no longer replayed after a compaction checkpoint.

Compaction history serialization must continue to use canonical provider history, including custom grammar tools and opaque Codex items.

## Storage failure policy

The provider should distinguish between model completion and metadata durability.

Recommended policy:

- Continue the assistant response when the upstream model succeeds but reference storage is temporarily unavailable.
- Keep the current turn's metadata in memory long enough to render direct links when possible.
- Mark the response with a provider diagnostic indicating that durable citation storage failed.
- Fall back to Pi display text for future replay only when canonical storage is unavailable.
- Never fabricate mappings or silently claim durable storage succeeded.

If canonical replay is a hard requirement for the provider, make storage availability a request precondition and fail before sending the upstream request. Do not allow a successful upstream response and then discard the only canonical copy.

## Security and privacy

1. Accept rendered destinations only from structured provider or tool output.
2. Render only `http` and `https` URLs by default.
3. Do not execute, fetch, or open a URL merely because it appears in a citation marker.
4. Treat signed URLs, query parameters, and fragments as potentially sensitive.
5. Encrypt source metadata at rest when the backend is not local and user-private.
6. Redact URLs, search queries, assistant text, and result payloads from ordinary logs.
7. Apply the same session deletion and retention policy to provider metadata as to the corresponding Pi session.
8. Preserve the original URL for correct navigation; use a separately normalized URL only for deduplication.

## Observability

Useful counters and diagnostics:

```text
codex.references.annotations_received
codex.references.annotations_reconciled
codex.references.annotation_range_invalid
codex.references.search_results_stored
codex.references.marker_resolution_success
codex.references.marker_resolution_miss
codex.references.canonical_history_hit
codex.references.canonical_history_miss
codex.references.storage_failure
```

Telemetry must use counts, statuses, and stable internal IDs. It must not include source URLs, search queries, assistant text, OAuth tokens, or raw result payloads.

## Test matrix

### Hosted citation capture

- annotation received only through `annotation.added`;
- annotation received only on `output_item.done`;
- provisional and completed annotations agree;
- completed annotations replace conflicting provisional annotations;
- multiple citations in one text part;
- adjacent and overlapping citation ranges;
- invalid and out-of-bounds ranges;
- emoji, surrogate pairs, combining marks, and non-ASCII titles;
- completed text differs from accumulated deltas;
- aborted and incomplete responses retain partial diagnostics without becoming complete.

### Standalone web search

- `results` maps `ref_id` to URL and title;
- duplicate result delivery is idempotent;
- the same reference ID in different sessions does not collide;
- search output reaches the model only after result persistence;
- unknown result types remain stored as opaque JSON;
- missing `results` remains compatible with older endpoints.

### Display and marker handling

- direct Markdown links pass through unchanged;
- URL annotations materialize without corrupting surrounding text;
- multiple replacements are applied from right to left;
- marker text split across stream deltas resolves at finalization;
- multi-reference markers preserve order;
- unresolved references never produce guessed links;
- unsafe URL schemes are not rendered as links.

### History and lifecycle

- canonical history is replayed instead of display text;
- a storage miss falls back predictably and emits a diagnostic;
- session resume can retrieve citation metadata;
- branch creation preserves access to shared historical sources;
- native compaction does not delete display metadata;
- retries and WebSocket reconnects do not duplicate records;
- provider response IDs and text signatures survive Pi session persistence.

## Recommended implementation phases

### Phase 1: Provider capture

- Replace the built-in Codex stream implementation.
- Preserve current Codex request, tool, reasoning, usage, and history behavior.
- Capture response IDs, item IDs, phases, completed output text, and annotations.
- Add the reference-store interface and an in-memory test implementation.

### Phase 2: Durable storage and canonical replay

- Add the production storage adapter.
- Store canonical text and annotations transactionally.
- Reconstruct outbound assistant history from canonical storage.
- Add storage-miss diagnostics and fallback behavior.

### Phase 3: Display support

- Materialize annotations as Markdown links, or add a metadata-aware Pi assistant renderer.
- Preserve canonical text separately.
- Add handling for leaked `cite…` markers.

### Phase 4: Standalone `web.run`

- Add the Codex-style web tool.
- Persist structured `results` before returning tool output.
- Share the reference store with the provider.
- Require final direct Markdown links in the tool instructions.

### Phase 5: Lifecycle hardening

- Add branch, compaction, resume, retry, and deletion tests.
- Add retention controls and privacy review.
- Add metrics without sensitive payloads.

## Definition of done

The flow is complete when:

1. hosted web-search annotations survive streaming and session resume;
2. standalone web-search reference IDs can be resolved from stored structured results;
3. final answers normally use clickable Markdown links without exposing internal IDs;
4. raw markers resolve only from trusted stored mappings;
5. outbound Codex history uses canonical upstream text and preserves phases and item IDs;
6. Pi branching and native compaction do not break historical source rendering;
7. storage failure behavior is explicit and tested; and
8. no URL or source mapping is inferred from an opaque reference ID.
