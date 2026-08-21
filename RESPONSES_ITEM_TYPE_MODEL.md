# Responses Item Type Model

## Purpose

Replace the broad `ResponsesItem` record with TypeBox-derived contracts that
match each value's lifecycle:

- request input and replay history use `ResponsesInputItem`;
- committed `response.output_item.done` values use `ResponsesOutputItem`;
- tool declarations use `ResponsesToolDefinition`;
- unknown item variants fail closed;
- additional fields on known variants remain allowed and are preserved.

New variants are added deliberately when official Codex release reviews show
that this package supports or must replay them.

## Shared literal domains

- `ResponsesItemStatus`
- `ResponsesMessageRole`
- `ResponsesMessagePhase`

## Top-level unions

- `ResponsesInputItem`
- `ResponsesOutputItem`
- `ResponsesMessageItem`
- `ResponsesToolCallItem`
- `ResponsesToolCallOutputItem`

Provider history is exactly `ResponsesInputItem[]`; there is no separate
`ResponsesHistoryItem`.

## Message items

- `PiInputMessageItem`
- `ResponsesInputMessageItem`
- `ResponsesOutputMessageItem`

`PiInputMessageItem` records the type-less user, system, and developer messages
produced by Pi AI's canonical Responses serializer. It is an input contract,
not a completed provider-output contract.

## Other item variants

- `ResponsesAdditionalToolsItem`
- `ResponsesReasoningItem`
- `ResponsesFunctionCallItem`
- `ResponsesFunctionCallOutputItem`
- `ResponsesCustomToolCallItem`
- `ResponsesCustomToolCallOutputItem`
- `ResponsesToolSearchCallItem`
- `ResponsesToolSearchOutputItem`
- `ResponsesWebSearchCallItem`
- `ResponsesImageGenerationCallItem`
- `ResponsesCompactionItem`
- `ResponsesCompactionTriggerItem`

The following are intentionally excluded until the package implements or must
replay them:

- `ResponsesAgentMessageItem`
- `ResponsesLocalShellCallItem`
- `ResponsesContextCompactionItem`
- `ResponsesOtherItem`
- `UnknownResponsesItem`

`ResponsesContextCompactionItem` is an official Codex rollout and app-server
lifecycle marker for a client-owned compaction operation. Official Codex emits
that local item around compaction and separately installs the backend-produced
`compaction` item. This package does not own a Codex rollout store: Pi's session
`compaction` entry records the local lifecycle, while
`ResponsesCompactionItem` carries the opaque backend state in provider history.
`ResponsesCompactionTriggerItem` remains the request control that asks the
backend to compact. Adding `context_compaction` to request or committed-output
history would therefore duplicate Pi state and misrepresent the protocol.

## Content contracts

- `ResponsesInputTextContent`
- `ResponsesInputImageContent`
- `ResponsesOutputTextContent`
- `ResponsesRefusalContent`
- `ResponsesReasoningSummaryContent`
- `ResponsesReasoningTextContent`
- `ResponsesInputContent`
- `ResponsesOutputContent`
- `ResponsesReasoningContent`
- `ResponsesToolOutputContent`

File and audio content remain excluded until they are supported.

## Tool-definition contracts

- `ResponsesToolDefinition`
- `ResponsesFunctionToolDefinition`
- `ResponsesCustomToolDefinition`
- `ResponsesNamespaceToolDefinition`
- `ResponsesWebSearchToolDefinition`
- `ResponsesGrammarFormat`

These are request tool declarations, not Responses history items.

## Union membership

`ResponsesOutputItem` contains:

- `ResponsesOutputMessageItem`
- `ResponsesReasoningItem`
- `ResponsesFunctionCallItem`
- `ResponsesCustomToolCallItem`
- `ResponsesToolSearchCallItem`
- `ResponsesToolSearchOutputItem`
- `ResponsesWebSearchCallItem`
- `ResponsesImageGenerationCallItem`
- `ResponsesCompactionItem`

`ResponsesInputItem` contains:

- `PiInputMessageItem`
- `ResponsesInputMessageItem`
- every `ResponsesOutputItem`;
- `ResponsesFunctionCallOutputItem`
- `ResponsesCustomToolCallOutputItem`
- `ResponsesAdditionalToolsItem`
- `ResponsesCompactionTriggerItem`

## Schema naming

Each static type is derived from the same-named raw schema:

```ts
ResponsesFunctionCallItem;
RESPONSES_FUNCTION_CALL_ITEM_SCHEMA;
```

Union schemas follow the same convention:

```ts
ResponsesOutputItem;
RESPONSES_OUTPUT_ITEM_SCHEMA;
```
