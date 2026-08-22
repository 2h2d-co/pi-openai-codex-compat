import type { ProductionApplyPatchFixture } from "./apply-patch-production-contracts.ts";

export const PRODUCTION_APPLY_PATCH_FAIL_CLOSED_FIXTURES: ProductionApplyPatchFixture[] = [
  {
    id: "recent insertion after stale preceding Markdown context",
    sourceFingerprints: ["7181933d46feab70"],
    productionObservation:
      "A multi-document policy patch failed because an extra bullet made the full insertion context stale even though the insertion boundary remained unique.",
    characteristics: [
      "last-two-days failure",
      "stale preceding context",
      "unique pure insertion",
      "extra unrelated bullet",
      "official strict mismatch",
    ],
    initialFiles: [
      {
        path: "<CWD>/policy.md",
        content: [
          "- publisher identity is bound to the workflow;",
          "- registry provenance is recorded;",
          "- artifact attestations are retained.",
          "",
          "These controls preserve exact-artifact authorization.",
          "",
        ].join("\n"),
      },
    ],
    patch: `*** Begin Patch
*** Update File: <CWD>/policy.md
@@
 - publisher identity is bound to the workflow;
 - registry provenance is recorded;

 These controls preserve exact-artifact authorization.
+
+The initial publication follows a separately reviewed bootstrap process.
*** End Patch`,
    expected: {
      outcome: "verification-error",
      messagePattern: /Failed to find expected lines/u,
    },
  },
  {
    id: "recent reflowed Markdown paragraph insertion rejects",
    sourceFingerprints: ["de34398026b29d09"],
    productionObservation:
      "A research-note insertion failed after its plain-text anchor paragraph was reflowed from two lines to one.",
    characteristics: [
      "last-two-days failure",
      "plain Markdown prose",
      "paragraph reflow",
      "unsupported prose recovery",
    ],
    initialFiles: [
      {
        path: "<CWD>/research.md",
        content:
          "Existing automation separately exercises alpha-only, beta-only, and mixed outputs.\n",
      },
    ],
    patch: `*** Begin Patch
*** Update File: <CWD>/research.md
@@
 Existing automation separately exercises alpha-only, beta-only, and mixed
 outputs.
+
+A final audit confirmed the expected processing semantics.
*** End Patch`,
    expected: {
      outcome: "verification-error",
      messagePattern: /Failed to find expected lines/u,
    },
  },
  {
    id: "recent semantically stale Java constructor rejects",
    sourceFingerprints: ["beb765abe18a5b84"],
    productionObservation:
      "A multi-file Java patch failed because the target constructor had gained a real dependency, not merely formatter changes.",
    characteristics: [
      "last-two-days failure",
      "semantic Java drift",
      "extra constructor dependency",
      "preflight prevents earlier write",
    ],
    initialFiles: [
      {
        path: "<CWD>/Service.java",
        content: [
          "class Service {",
          "  Service(String queue, Repository repository, Logger logger) {",
          "    this.queue = queue;",
          "    this.repository = repository;",
          "    this.logger = logger;",
          "  }",
          "}",
          "",
        ].join("\n"),
      },
    ],
    patch: `*** Begin Patch
*** Add File: <CWD>/Policy.java
+class Policy {}
*** Update File: <CWD>/Service.java
@@
-  Service(
-      String queue,
-      Repository repository) {
-    this.queue = queue;
-    this.repository = repository;
+  Service(
+      String queue,
+      Repository repository,
+      Policy policy) {
+    this.queue = queue;
+    this.repository = repository;
+    this.policy = policy;
*** End Patch`,
    expected: {
      outcome: "verification-error",
      messagePattern: /Failed to find expected lines/,
    },
  },
  {
    id: "recent semantically stale Markdown paragraph rejects",
    sourceFingerprints: ["f0f72fe844683e35"],
    productionObservation:
      "A note insertion failed because one expected total contained an extra backtick and no longer described the current paragraph.",
    characteristics: [
      "last-two-days failure",
      "semantic prose mismatch",
      "inline-code punctuation",
      "must not anchor to older context",
    ],
    initialFiles: [
      {
        path: "<CWD>/totals.md",
        content: [
          "The first sentence remains unchanged.",
          "The fixture changes from 9 total / 5 completed /",
          "2 failed to 8 total / 4 completed / 2 failed.",
          "",
        ].join("\n"),
      },
    ],
    patch: `*** Begin Patch
*** Update File: <CWD>/totals.md
@@
 The first sentence remains unchanged.
 The fixture changes from 9 total / 5 completed /
 \`2 failed to 8 total / 4 completed / 2 failed.
+
+Add a conclusion based on those totals.
*** End Patch`,
    expected: {
      outcome: "verification-error",
      messagePattern: /Failed to find expected lines/,
    },
  },
  {
    id: "recent obsolete context-only chunk before insertion",
    sourceFingerprints: ["7383283abf4aba57"],
    productionObservation:
      "A documentation insertion failed on an obsolete context-only chunk that had no content effect and preceded the uniquely anchored insertion.",
    characteristics: [
      "last-two-days failure",
      "context-only chunk",
      "stale no-effect anchor",
      "later unique insertion",
      "official strict mismatch",
    ],
    initialFiles: [
      {
        path: "<CWD>/follow-up.md",
        content:
          "Current introduction.\n\nThe practical risk is transient load rather than data loss.\n",
      },
    ],
    patch: `*** Begin Patch
*** Update File: <CWD>/follow-up.md
@@ obsolete introduction
@@
 The practical risk is transient load rather than data loss.
+
+The follow-up runbook records how to validate that risk.
*** End Patch`,
    expected: {
      outcome: "verification-error",
      messagePattern: /Failed to find context/u,
    },
  },
  {
    id: "current-session omitted second file header rejects",
    sourceFingerprints: ["96c7ea1eb34da115"],
    productionObservation:
      "A patch in this session accidentally placed a second file's count update inside the first file's update hunk.",
    characteristics: [
      "current-session failure",
      "grammar-valid caller error",
      "omitted update-file header",
      "preflight prevents partial write",
    ],
    initialFiles: [
      {
        path: "<CWD>/fixtures.ts",
        content: 'export const fixtures = ["existing"];\n',
      },
      {
        path: "<CWD>/fixtures.test.ts",
        content: "assert.equal(fixtures.length, 19);\n",
      },
    ],
    patch: `*** Begin Patch
*** Update File: <CWD>/fixtures.ts
@@
-export const fixtures = ["existing"];
+export const fixtures = ["existing", "new"];
@@
-assert.equal(fixtures.length, 19);
+assert.equal(fixtures.length, 20);
*** End Patch`,
    expected: {
      outcome: "verification-error",
      messagePattern: /Failed to find expected lines/,
    },
  },
  {
    id: "current-session stale Markdown section context recovers",
    sourceFingerprints: ["90cc8f2c4c1d38f4"],
    productionObservation:
      "A large semantic-reference update failed after a Markdown section heading gained its marker prefix; the current matcher recovers the uniquely located edits beneath it.",
    characteristics: [
      "current-session failure",
      "stale Markdown heading context",
      "multiple ordered edit groups",
      "current heading preserved",
      "official strict mismatch",
    ],
    initialFiles: [
      {
        path: "<CWD>/semantics.md",
        content: [
          "### Add file",
          "",
          "`Add File: P` unconditionally writes its grammar-provided content to `P`.",
          "Existing destination overwrite behavior is retained.",
          "",
          "- If `P` already contains exactly the requested bytes, the operation is a",
          "  no-op.",
          "- If `P` is absent, it is created along with missing parent directories.",
          "",
        ].join("\n"),
      },
    ],
    patch: `*** Begin Patch
*** Update File: <CWD>/semantics.md
@@
 Add file

 \`Add File: P\` unconditionally writes its grammar-provided content to \`P\`.
-Existing destination overwrite behavior is retained.
+It establishes a regular-file entry at the exact requested path spelling.

 - If \`P\` already contains exactly the requested bytes, the operation is a
-  no-op.
+  no-op only when \`P\` is already a regular file at the requested exact
+  spelling.
 - If \`P\` is absent, it is created along with missing parent directories.
*** End Patch`,
    expected: {
      outcome: "verification-error",
      messagePattern: /Failed to find expected lines/u,
    },
  },
  {
    id: "current-session reverse-ordered Markdown hunks reject",
    sourceFingerprints: ["fb56a75092a777bc"],
    productionObservation:
      "Two independently meaningful documentation insertions were supplied in reverse source order within one file update.",
    characteristics: [
      "current-session failure",
      "reverse source order",
      "pure insertions",
      "ordered mapping requirement",
    ],
    initialFiles: [
      {
        path: "<CWD>/semantics.md",
        content: [
          "## Dead operations",
          "",
          "An inapplicable operation may be marked dead only when:",
          "",
          "Unsupported proofs must become conflicts, not unsafe acceptance.",
          "",
          "## Hard links",
          "",
          "For a pure move, the required postcondition remains unchanged.",
          "",
          "The executor must account for that case without deleting the destination.",
          "",
        ].join("\n"),
      },
    ],
    patch: `*** Begin Patch
*** Update File: <CWD>/semantics.md
@@
 For a pure move, the required postcondition remains unchanged.

 The executor must account for that case without deleting the destination.
+
+Replacing a hard-linked destination replaces only the named entry.
@@
 An inapplicable operation may be marked dead only when:

 Unsupported proofs must become conflicts, not unsafe acceptance.
+
+A failed move is dead only when all of its effects are dominated.
*** End Patch`,
    expected: {
      outcome: "verification-error",
      messagePattern: /Failed to find expected lines/,
    },
  },
  {
    id: "current-session repeated and out-of-order matcher edits reject",
    sourceFingerprints: ["0e900184894b9986"],
    productionObservation:
      "A follow-up implementation patch repeated changes already made by earlier patches, then revisited an earlier source region after a later hunk.",
    characteristics: [
      "current-session failure",
      "already-applied edits",
      "reverse source traversal",
      "stale old call",
    ],
    initialFiles: [
      {
        path: "<CWD>/matcher.ts",
        content: [
          "async function parseDocument(source: string, signal?: AbortSignal) {",
          "  return source;",
          "}",
          "",
          "function lineBounds(source: string): number {",
          "  return source.length;",
          "}",
          "",
          'const document = await parseDocument("source", signal);',
          "",
        ].join("\n"),
      },
    ],
    patch: `*** Begin Patch
*** Update File: <CWD>/matcher.ts
@@
 function lineBounds(source: string): number {
-  return source.length;
+  return Buffer.byteLength(source);
 }
@@
-async function parseDocument(source: string) {
+async function parseDocument(source: string, signal?: AbortSignal) {
   return source;
 }
@@
-const document = await parseDocument("source");
+const document = await parseDocument("source", signal);
*** End Patch`,
    expected: {
      outcome: "verification-error",
      messagePattern: /Failed to find expected lines/,
    },
  },
];
