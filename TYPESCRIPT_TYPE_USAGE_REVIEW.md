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

**Status:** Completed; Oxlint follow-up pending discussion

**Priority:** High

The codebase contains 59 object method signatures, including internal adapter,
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

**Outcome:** All 59 non-vendored object method signatures were converted to
function properties. The structural scan now reports zero method signatures.
`npm run check` and `npm test` pass.

**Oxlint checkpoint:** Decide whether to enforce property-style function
signatures after the code change is complete.

### 2. `Type.Unsafe` schema/type parity

**Status:** Pending

**Priority:** High-medium

`image-generation-schema.ts` and `web-run-schema.ts` manually pair a static
type with raw JSON Schema through `Type.Unsafe`. TypeScript cannot prove that
the two contracts agree.

The web-run static type deliberately accepts several `null` values that the
emitted schema does not advertise. Exact schema hash tests preserve the wire
schema but do not prove static/runtime parity.

Prefer deriving the static type from TypeBox constructors. If the exact raw
schema makes that impractical, isolate and document the unsafe boundary and
add representative parity tests.

Do not add Zod alongside TypeBox.

**Oxlint checkpoint:** Consider whether direct `Type.Unsafe` calls should be
forbidden outside one reviewed compatibility helper.

### 3. Overclaiming hand-written type predicates

**Status:** Pending

**Priority:** High-medium

`isAppliedPatchChange` does not validate every optional field promised by
`AppliedPatchChange`, including:

- `overwrittenContent`
- `overwrittenMoveContent`

`isWebSocketConstructor` also checks only that a value is callable while
claiming that it is newable and implements the complete constructor contract.

Audit substantive type predicates field-by-field and add malformed-input
tests. TypeScript trusts a predicate's claim without checking its
implementation.

**Oxlint checkpoint:** Discuss whether a project-specific rule can identify
high-risk predicates or whether tests and code review are the appropriate
enforcement mechanism.

### 4. Broad wire types leaking into domain logic

**Status:** Pending

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

**Oxlint checkpoint:** This is primarily architectural; determine whether any
narrow rule, such as restricting `JsonRecord` in domain contract files, would
be reliable enough to help.

### 5. Duplicated literal domains and types

**Status:** Pending

**Priority:** Medium

Several closed string domains are declared independently as both unions and
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

Also remove localized residue such as the unused duplicate `CodexCompat` and
the duplicate `ImageGenerationArgs`.

**Oxlint checkpoint:** Consider enforcing type derivation for typed literal
sets only if a rule can distinguish closed domains from intentionally partial
sets.

### 6. Remaining impossible-state objects

**Status:** Pending

**Priority:** Low-medium

Some objects still permit combinations the implementation does not produce:

- `RemoteCompactionHookResult` can contain both `cancel` and `compaction`.
- `CodexTerminalState` can contain `response` without `type`.
- `CodexToolCallAssessment` duplicates `completedCount` as
  `hasCompletedCalls`.
- `GrammarJsonBuffer` permits `closed: true` with `started: false`.

Prioritize returned result contracts over temporary mutable accumulator state.

**Oxlint checkpoint:** Likely better handled through domain modeling than a
syntax rule, but discuss after the refactor.

### 7. Selective primitive branding

**Status:** Pending

**Priority:** Advisory

Session, thread, turn, response, and tool-call identifiers are all strings.
Consider brands only where semantically different identifiers appear together,
can be swapped accidentally, and have a clear construction or validation
boundary.

Do not brand every string or path.

**Oxlint checkpoint:** Branding policy is likely too domain-specific for a
general syntax rule.

### 8. Focused type-level tests

**Status:** Pending

**Priority:** Low

The runtime test suite is comprehensive, but there are no dedicated negative
assignability tests. This is acceptable for an extension rather than a type
library.

Add type-level tests only for high-value generic or public contracts, such as:

- `ToolDefinitionWithContext`
- Schema/static-type parity
- Public transport debug contracts
- Future branded identifiers

**Oxlint checkpoint:** Ensure any type-test mechanism remains compatible with
the project's suppression-directive policy.

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
