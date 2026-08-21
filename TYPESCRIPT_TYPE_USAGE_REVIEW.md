# TypeScript Type Usage Review

## Summary

The codebase has strong TypeScript type usage overall. Its strict compiler and
lint configuration, lack of unsafe escape hatches, explicit return types,
runtime boundary checks, and extensive discriminated unions are well aligned
with Matt Pocock's published guidance.

The main opportunities are localized around callback variance, schema/type
parity, hand-written type predicates, broad wire types, and duplicated sources
of truth.

**Initial assessment:** 8.6/10 (A-)

## Baseline

The review covered:

- 80 non-vendored production TypeScript files
- 20,098 non-vendored production lines
- 79 test TypeScript files
- 21,534 test lines
- 600 non-vendored function declarations

Observed escape hatches:

- Explicit `any`: 0
- Non-const type assertions: 0
- Non-null assertions: 0
- `@ts-ignore`: 0
- `@ts-expect-error`: 0
- `as unknown as`: 0
- `as never`: 0
- `as const`: 10
- `satisfies`: 6

Validation at the time of review:

- `npm run check`: passed
- `npm test`: 314 passed, 2 skipped, 0 failed

## Strengths

### Compiler and lint policy

`tsconfig.json` enables strict checking together with
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitReturns`, `noImplicitOverride`,
`noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature`,
`isolatedModules`, `verbatimModuleSyntax`,
`noUncheckedSideEffectImports`, and `erasableSyntaxOnly`.

The shared Oxlint policy additionally forbids explicit `any`, type assertions,
non-null assertions, unsafe operations, and non-exhaustive switches.

`skipLibCheck` is justified: disabling it exposes errors in upstream
declarations rather than project source.

### Return types and inference

Every non-vendored function declaration has an explicit return type or type
predicate. This is stricter than Matt's recommendation to annotate top-level
module functions and is reasonable for protocol-heavy code.

Contextually typed callbacks are allowed to infer their parameters and return
types.

### Domain modeling

The codebase makes strong use of discriminated unions, particularly:

- `VirtualEntry` and `PlannedMutation`
- `AppliedPatchChange` and `ResolvedOperation`
- `OutputSlot`
- `CheckpointSearch`
- `CodexTransportDiagnostic`

`Extract`, `never` properties, exhaustive switches, and `satisfies` are used to
preserve variant-specific guarantees and make invalid combinations
unrepresentable.

### Runtime boundaries

Untrusted JSON, stream events, persisted data, configuration, environment
variables, and caught values generally enter as `unknown` and are narrowed
before use.

TypeBox and focused manual validation already satisfy the need for runtime
validation. Adding another schema library would be redundant.

### Type organization

Single-use types are generally colocated, while genuinely shared provider,
transport, and apply-patch contracts live in focused modules. Narrow
`Pick`-based adapter contexts keep tests and integrations decoupled from the
complete Pi API.

## Findings and Work Plan

After each completed finding, pause before starting the next one to decide
whether the pattern can and should be enforced by an Oxlint rule.

### 1. Bivariant method signatures

**Status:** Completed and enforced by Oxlint

**Priority:** High

The codebase contained 62 object method signatures, including internal adapter,
callback, transport, and tool contracts. Method signatures are bivariant in
their parameter types and can admit implementations with unsafely narrow
parameters.

Examples:

- `extensions/openai-codex-compat/remote-compaction.ts`
- `extensions/openai-codex-compat/codex-thread-lineage.ts`
- `extensions/openai-codex-compat/output-limit-continuation.ts`
- `extensions/openai-codex-compat/settings-pane.ts`
- `extensions/openai-codex-compat/tool-definition-contract.ts`
- `extensions/openai-codex-compat/codex-transport/codex-transport-contracts.ts`
- `extensions/openai-codex-compat/apply-patch.ts`

Prefer function properties:

```ts
type Api = {
  onContext: (handler: ContextHandler) => void;
};
```

instead of method signatures:

```ts
type Api = {
  onContext(handler: ContextHandler): void;
};
```

Actual class methods and declarations intentionally mirroring an upstream or
native method-shaped API may be justified exceptions.

**Outcome:** All 62 non-vendored object method signatures were converted to
function properties. The initial structural scan found 59; the released Oxlint
rule identified three additional test contracts. Oxlint now reports zero method
signatures. `npm run check` and `npm test` pass.

**Oxlint checkpoint:** Added `2h2d/no-bivariant-method-signatures` without an
autofixer and enabled it through `@2h2d/oxlint-config` `0.1.0-alpha.7`. The rule
rejects interface and type-literal method signatures while allowing call,
construct, class, and object implementation methods.

### 2. `Type.Unsafe` schema/type parity

**Status:** Completed and enforced by Oxlint

**Priority:** High-medium

`image-generation-schema.ts` and `web-run-schema.ts` previously paired a static
type with raw JSON Schema through `Type.Unsafe`. TypeScript could not prove that
the two contracts agreed.

The web-run static type also accepted several `null` values that the emitted
schema does not advertise. Exact schema hash tests preserved the wire schema
but did not prove static/runtime parity.

**Outcome:** Both exact raw schemas remain unchanged as const object literals,
and their static types are now derived with TypeBox's native JSON Schema
inference through `Static<typeof schema>`. All direct `Type.Unsafe` calls were
removed.

The validated `WebRunCommands` type now matches the reserved schema. A separate
mapped `WebRunRenderCommands` type retains null tolerance for incomplete
model-supplied arguments rendered before schema validation. Existing schema
equality and hash tests confirm the wire declarations are unchanged.
`npm run check` and `npm test` pass.

**Oxlint checkpoint:** Added the import-aware `2h2d/no-typebox-unsafe` rule
without an autofixer and enabled it through `@2h2d/oxlint-config`
`0.1.0-alpha.8`. It rejects named, aliased, default, and namespace TypeBox
`Unsafe` calls without matching unrelated local APIs.

### 3. Overclaiming hand-written type predicates

**Status:** Completed

**Priority:** High-medium

`isAppliedPatchChange` did not validate every optional field promised by
`AppliedPatchChange`, including:

- `overwrittenContent`
- `overwrittenMoveContent`

`isWebSocketConstructor` also checked only that a value was callable while
claiming that it was newable and implemented the complete constructor
contract.

Audit substantive type predicates field-by-field and add malformed-input
tests. TypeScript trusts a predicate's claim without checking its
implementation.

**Outcome to date:** The complete `ApplyPatchDetails` contract, including
formatter-match diagnostics, is now represented by raw TypeBox-compatible JSON
Schemas. All corresponding static types are derived with `Static`, and the
renderer calls TypeBox's `Value.Check` directly instead of maintaining nine
hand-written predicates.

The schemas require integers for numeric metadata, allow additional
properties, preserve optional fields, and retain the
`move-already-fulfilled` single-related-instruction invariant. Focused tests
cover valid complete details and malformed nested data. `npm run check` and
`npm test` pass.

The WebSocket boundary now uses Node's native, header-aware
`globalThis.WebSocket` type directly instead of replacing it with a
hand-written constructor predicate and contract. The live test also uses the
typed runtime global directly.

The same schema-first pattern now covers image-generation render metadata,
persisted Codex thread markers, CI package identity, and `npm pack` result
metadata. Each static type is inferred from its raw TypeBox-compatible schema,
and each untrusted value is narrowed directly with `Value.Check`.

Broad Responses items and recursive JSON values are deferred to finding 4 so
that they can be narrowed at the correct domain boundaries rather than encoded
as another broad schema. Tolerant sanitizers and non-JSON capability checks
remain manual because all-or-nothing schema validation would change their
semantics.

The final capability predicate no longer accepts `unknown` and claims a
complete session-manager contract after checking one method. Its input is now a
`SessionScopeReader` derived from the three Pi session operations already
required by scope capture. A successful check adds only
`Pick<SessionManager, "appendCompaction">`, producing the focused
`CompactionSessionManager` contract. The append signature therefore remains
owned by Pi, while a focused test verifies that scope capture fails closed when
the runtime capability is absent.

**Oxlint checkpoint:** No additional rule. Predicate completeness depends on
the relationship between preconditions, runtime checks, and the claimed domain
contract; a syntax rule would produce low-confidence findings. Schema-derived
JSON contracts, native platform types, narrow capability checks, and malformed
boundary tests provide stronger enforcement for the concrete cases found here.

### 4. Broad wire types leaking into domain logic

**Status:** Completed

**Priority:** Medium

`JsonRecord` is appropriate at transport boundaries, but `ResponsesItem`
remains broad throughout stream and provider logic:

```ts
interface ResponsesItem extends JsonRecord {
  type?: string;
}
```

This prevents the compiler from checking item-specific required fields and
exhaustive handling.

Keep broad records at wire boundaries, then introduce small local unions for
the known event and item subsets consumed by individual modules. Do not model
the complete evolving Responses API.

**Outcome:** The broad `ResponsesItem` contract was removed. Raw TypeBox
schemas now model each supported content item, message representation,
completed provider item, request-input item, and Responses tool definition.
The individually exported types compose into lifecycle-specific
`ResponsesOutputItem`, `ResponsesInputItem`, and `ResponsesToolDefinition`
unions.

Only `response.output_item.done` values validated by the closed output union
enter native history. Request history has its own closed union, including Pi's
canonical type-less input messages and input-only tool outputs and controls.
Unknown variants and malformed known variants fail closed, while additional
fields on known variants remain allowed and survive replay. Tool definitions
no longer masquerade as history items. The approved inventory and union
membership are recorded in [`RESPONSES_ITEM_TYPE_MODEL.md`](RESPONSES_ITEM_TYPE_MODEL.md).

**Oxlint checkpoint:** No additional rule. Whether a JSON record represents a
transport envelope, input item, committed output item, or tool definition is a
domain-lifecycle distinction that syntax alone cannot infer reliably. The
closed schema unions and boundary tests enforce the intended separation.

### 5. Duplicated literal domains and types

**Status:** Completed

**Priority:** Medium

Several closed string domains were declared independently as both unions and
runtime sets. `Set<Union>` rejects invalid members but does not prove that all
union members are present.

Examples include:

- Configuration modes
- `SettingId` and `SETTING_IDS`
- Response statuses
- Apply-patch statuses, reasons, and final states
- Formatter matcher reasons

Prefer value-first declarations:

```ts
const MODES = ["disabled", "cached", "indexed", "live"] as const;
type Mode = (typeof MODES)[number];
```

**Outcome:** Configuration modes and terminal response statuses now derive
their static types from the same raw TypeBox schemas used for runtime
validation. The settings pane reuses those schema enums and derives
`SettingId` from `CONFIG_ENVIRONMENT_VARIABLES`. Internal matcher modes derive
their type from one runtime tuple. The apply-patch reason schema composes its
complete domain from the ordinary reason-code tuple instead of repeating
literals.

The unused `CodexCompat`, duplicate `ImageGenerationArgs`, and obsolete
`isAllowedString` helper were removed. Apply-patch statuses, final states, and
formatter reasons were already schema-derived after finding 2 and required no
further restructuring.

**Oxlint checkpoint:** No additional rule. A `Set<Union>` may intentionally
represent a subset, so banning that syntax would produce false positives.
Cross-declaration analysis to infer whether a collection is intended to be
exhaustive is not reliable enough for a project lint rule. Schema-first and
tuple-first declarations prevent the drift structurally.

### 6. Remaining impossible-state objects

**Status:** Completed

**Priority:** Low-medium

Some objects permitted combinations the implementation does not produce:

- `RemoteCompactionHookResult` can contain both `cancel` and `compaction`.
- `CodexTerminalState` can contain `response` without `type`.
- `CodexToolCallAssessment` duplicates `completedCount` as
  `hasCompletedCalls`.
- `GrammarJsonBuffer` permits `closed: true` with `started: false`.

Prioritize returned result contracts over temporary mutable accumulator state.

**Outcome:** The remote-compaction hook now returns mutually exclusive cancel
or Pi-native `CompactionResult` branches. Terminal capture is separate from
the terminal-state discriminated union, so a response cannot exist without its
terminal event type and completed or incomplete states always carry their
response. Tool-call assessment retains only the canonical count instead of a
derived boolean. The mutable grammar buffer uses one lifecycle phase instead
of contradictory `started` and `closed` booleans.

**Oxlint checkpoint:** No additional rule. Optional properties, multiple
booleans, and derived fields are each legitimate in other contexts. Detecting
whether their combinations represent impossible domain states requires
semantic knowledge that a syntax rule cannot infer reliably.

### 7. Selective primitive branding

**Status:** Completed — no brands introduced

**Priority:** Advisory

Session, thread, turn, response, and tool-call identifiers are all strings.
Consider brands only where semantically different identifiers appear together,
can be swapped accidentally, and have a clear construction or validation
boundary.

Do not brand every string or path.

**Outcome:** No identifier currently meets that threshold. These values enter
through Pi, Pi AI, and provider contracts that expose ordinary strings;
partially branding them would require widespread unchecked conversions and
would create stronger-looking types without stronger runtime guarantees.
Session-derived thread and cache identities are also intentionally
interconvertible in defined protocol paths.

Keep identifiers as strings at dependency and protocol boundaries. Prefer
named parameter objects if an API accumulates multiple easily swapped
identifiers, and reconsider branding only when a concrete swap risk appears or
an upstream contract provides a trustworthy branded construction boundary.

**Oxlint checkpoint:** No additional rule. Syntax cannot determine which
strings are semantically interchangeable, intentionally convertible, or worth
branding. Enforcing brands by identifier naming would be brittle and
encourage assertion-heavy code.

### 8. Focused type-level tests

**Status:** Completed — no dedicated type tests added

**Priority:** Low

The runtime test suite is comprehensive, but there are no dedicated negative
assignability tests. This is acceptable for an extension rather than a type
library.

Add type-level tests only for high-value generic or public contracts, such as:

- `ToolDefinitionWithContext`
- Schema/static-type parity
- Public transport debug contracts
- Future branded identifiers

**Outcome:** No current contract justifies a separate type-test mechanism.
Schema/static parity is structural because exported types derive directly from
their raw TypeBox schemas. `ToolDefinitionWithContext` is exercised by three
production tool implementations, and the public WebSocket debug contract is a
simple record covered by runtime tests. No branded identifiers were
introduced.

The main TypeScript project already includes production and test sources, and
real fixtures use `satisfies` for positive assignability coverage. Negative
tests based on `@ts-expect-error` would violate the project's
suppression-directive policy; custom conditional-type assertions or another
dependency would add machinery without protecting a high-value type
transformation.

Reconsider a compile-only `.test-d.ts` file without suppression comments if
the package later introduces a reusable public generic, complex conditional
types, brands, independent schema and static declarations, or a concrete type
regression not caught by production compilation.

**Oxlint checkpoint:** No additional rule. Syntax cannot determine whether a
contract is complex or public enough to warrant dedicated type-level tests.

## Approaches to Avoid

- Adding Zod alongside TypeBox
- Modeling the entire OpenAI Responses protocol
- Branding every identifier and path
- Converting every interface to a type alias as a stylistic rewrite
- Adding explicit annotations to every contextually typed callback
- Making all protocol and builder objects deeply readonly
- Replacing focused validators with one giant schema

## Reference Material

- [Method Shorthand Syntax Considered Harmful](https://www.totaltypescript.com/method-shorthand-syntax-considered-harmful)
- [Should You Declare Return Types?](https://www.totaltypescript.com/should-you-declare-return-types)
- [`any` Considered Harmful, Except For These Cases](https://www.totaltypescript.com/any-considered-harmful)
- [Clarifying the `satisfies` Operator](https://www.totaltypescript.com/clarifying-the-satisfies-operator)
- [Where To Put Your Types in Application Code](https://www.totaltypescript.com/where-to-put-your-types-in-application-code)
- [Type vs Interface: Which Should You Use?](https://www.totaltypescript.com/type-vs-interface-which-should-you-use)
- [When Should You Use Zod?](https://www.totaltypescript.com/when-should-you-use-zod)
- [How to Test Your Types](https://www.totaltypescript.com/how-to-test-your-types)
- [Matt Pocock's current code-review smell baseline](https://github.com/mattpocock/skills/blob/main/skills/engineering/code-review/SKILL.md)
