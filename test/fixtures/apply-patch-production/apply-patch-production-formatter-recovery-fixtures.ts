import type { ProductionApplyPatchFixture } from "./apply-patch-production-contracts.ts";

export const PRODUCTION_APPLY_PATCH_FORMATTER_RECOVERY_FIXTURES: ProductionApplyPatchFixture[] = [
  {
    id: "current-session formatter-reflowed engine method",
    sourceFingerprints: ["684cab162b03aa44"],
    productionObservation:
      "An implementation patch missed after the formatter collapsed a method signature.",
    characteristics: [
      "current-session failure",
      "formatter-reflowed TypeScript",
      "single structural replacement",
      "punctuation-changing formatter reflow",
      "intentional rejection",
    ],
    initialFiles: [
      {
        path: "<CWD>/planner.ts",
        content: [
          "class Planner {",
          "  private describe(index: number, operation: string): string {",
          "    return `${index}:${operation}`;",
          "  }",
          "}",
          "",
        ].join("\n"),
      },
    ],
    patch: `*** Begin Patch
*** Update File: <CWD>/planner.ts
@@
 class Planner {
-  private describe(
-    index: number,
-    operation: string,
-  ): string {
-    return \`\${index}:\${operation}\`;
-  }
+  private describe(
+    index: number,
+    operation: string,
+  ): string {
+    return \`\${index}=\${operation}\`;
+  }
 }
*** End Patch`,
    expected: {
      outcome: "verification-error",
      messagePattern: /No formatter-tolerant candidate/u,
    },
  },
  {
    id: "current-session formatter-reflowed production assertion",
    sourceFingerprints: ["a197ec50edaaa85b"],
    productionObservation:
      "A production-fixture test patch missed after the formatter collapsed an assertion call.",
    characteristics: [
      "current-session failure",
      "formatter-reflowed TypeScript",
      "single structural replacement",
      "punctuation-changing formatter reflow",
      "intentional rejection",
    ],
    initialFiles: [
      {
        path: "<CWD>/fixture.test.ts",
        content: [
          'void test("fixture", async () => {',
          "  await assert.rejects(applyPatch(cwd, invalidPatch), ApplyPatchVerificationError);",
          "});",
          "",
        ].join("\n"),
      },
    ],
    patch: `*** Begin Patch
*** Update File: <CWD>/fixture.test.ts
@@
 void test("fixture", async () => {
-  await assert.rejects(
-    applyPatch(cwd, invalidPatch),
-    ApplyPatchVerificationError,
-  );
+  await assert.rejects(
+    applyPatch(cwd, ambiguousPatch),
+    ApplyPatchVerificationError,
+  );
 });
*** End Patch`,
    expected: {
      outcome: "verification-error",
      messagePattern: /No formatter-tolerant candidate/u,
    },
  },
  {
    id: "current-session insertion after formatter-collapsed assertion",
    sourceFingerprints: ["78202d6763884f63"],
    productionObservation:
      "A test insertion failed in this session because the formatter collapsed the preceding assertion while the insertion boundary and following test remained unchanged.",
    characteristics: [
      "current-session failure",
      "pure insertion",
      "formatter-collapsed preceding context",
      "repeated blank-line boundary",
    ],
    initialFiles: [
      {
        path: "<CWD>/matcher.test.ts",
        content: [
          'void test("tail", () => {',
          '  assert.equal(result, "appended");',
          "});",
          "",
          'void test("ambiguity", () => {});',
          "",
        ].join("\n"),
      },
    ],
    patch: `*** Begin Patch
*** Update File: <CWD>/matcher.test.ts
@@
 void test("tail", () => {
   assert.equal(
     result,
     "appended",
   );
 });

+void test("empty", () => {
+  assert.equal(result, "");
+});
+
 void test("ambiguity", () => {});
*** End Patch`,
    expected: {
      outcome: "success",
      files: [
        {
          path: "<CWD>/matcher.test.ts",
          content: [
            'void test("tail", () => {',
            '  assert.equal(result, "appended");',
            "});",
            "",
            'void test("empty", () => {',
            '  assert.equal(result, "");',
            "});",
            "",
            'void test("ambiguity", () => {});',
            "",
          ].join("\n"),
        },
      ],
      absent: [],
      changeKinds: ["update"],
    },
  },
  {
    id: "recent Markdown fence formatter reflow",
    sourceFingerprints: ["dfcff1278f741d85"],
    productionObservation:
      "A large package-maintenance patch failed when formatter-collapsed TypeScript inside a Markdown fence no longer matched multiline old lines.",
    characteristics: [
      "last-two-days failure",
      "typed Markdown fence",
      "formatter-reflowed TypeScript",
      "punctuation-changing formatter reflow",
      "intentional rejection",
    ],
    initialFiles: [
      {
        path: "<CWD>/README.md",
        content: [
          "# Package API",
          "",
          "```ts",
          'const grammar = new URL("@scope/package/grammar.wasm", import.meta.url);',
          "```",
          "",
        ].join("\n"),
      },
    ],
    patch: `*** Begin Patch
*** Update File: <CWD>/README.md
@@
 \`\`\`ts
-const grammar = new URL(
-  "@scope/package/grammar.wasm",
-  import.meta.url,
-);
+const grammar = new URL(
+  import.meta.resolve("@scope/package/grammar.wasm"),
+);
 \`\`\`
*** End Patch`,
    expected: {
      outcome: "verification-error",
      messagePattern: /No formatter-tolerant candidate/u,
    },
  },
  {
    id: "recent formatter-aligned Markdown table insertion",
    sourceFingerprints: ["5ea8602a0c78dbca"],
    productionObservation:
      "A documentation update failed because the Markdown formatter padded table cells after the patch context was composed.",
    characteristics: [
      "last-two-days failure",
      "Markdown table alignment",
      "pure insertion",
      "cell-equivalent context",
    ],
    initialFiles: [
      {
        path: "<CWD>/SECURITY.md",
        content: [
          "| Job                         | Read | Write | OIDC |",
          "| --------------------------- | ---- | ----- | ---- |",
          "| Pull-request validation     | Yes  | No    | No   |",
          "| Release construction        | Yes  | No    | No   |",
          "| Package publication         | No   | No    | Yes  |",
          "| Release finalization        | No   | Yes   | No   |",
          "",
        ].join("\n"),
      },
    ],
    patch: `*** Begin Patch
*** Update File: <CWD>/SECURITY.md
@@
 | Pull-request validation | Yes | No | No |
 | Release construction | Yes | No | No |
 | Package publication | No | No | Yes |
+| Public-package integration | Yes | No | No |
 | Release finalization | No | Yes | No |
*** End Patch`,
    expected: {
      outcome: "success",
      files: [
        {
          path: "<CWD>/SECURITY.md",
          content: [
            "| Job                         | Read | Write | OIDC |",
            "| --------------------------- | ---- | ----- | ---- |",
            "| Pull-request validation     | Yes  | No    | No   |",
            "| Release construction        | Yes  | No    | No   |",
            "| Package publication         | No   | No    | Yes  |",
            "| Public-package integration | Yes | No | No |",
            "| Release finalization        | No   | Yes   | No   |",
            "",
          ].join("\n"),
        },
      ],
      absent: [],
      changeKinds: ["update"],
    },
  },
];
