export type ProductionFileFixture = {
  path: string;
  content: string;
  mode?: number;
};

export type ProductionApplyPatchFixture = {
  id: string;
  sourceFingerprints: string[];
  productionObservation: string;
  characteristics: string[];
  initialFiles: ProductionFileFixture[];
  patch: string;
  expected:
    | {
        outcome: "success";
        files: ProductionFileFixture[];
        absent: string[];
        changeKinds: Array<"add" | "delete" | "move" | "update">;
      }
    | {
        outcome: "verification-error";
        messagePattern: RegExp;
      };
};

// Sanitized, minimized fixtures derived from apply_patch calls found in Pi's
// production session corpus. Fingerprints are truncated SHA-256 values of the
// original patches; no session paths, identifiers, or sensitive contents are
// retained here.
export const PRODUCTION_APPLY_PATCH_FIXTURES: ProductionApplyPatchFixture[] = [
  {
    id: "batch move-only extension entrypoints",
    sourceFingerprints: ["2185f36ad7ccc865"],
    productionObservation:
      "A 15-operation patch containing three move-only hunks was rejected at the first move.",
    characteristics: [
      "absolute paths",
      "three move-only updates",
      "interleaved related text updates",
      "template path containing spaces and braces",
    ],
    initialFiles: [
      {
        path: "<CWD>/packages/alpha/extensions/alpha/index.ts",
        content: "export const alpha = true;\n",
      },
      {
        path: "<CWD>/packages/alpha/package.json",
        content: '{\n  "entry": "extensions/alpha/index.ts"\n}\n',
      },
      {
        path: "<CWD>/packages/beta/extensions/beta/index.ts",
        content: "export const beta = true;\n",
      },
      {
        path: "<CWD>/packages/beta/package.json",
        content: '{\n  "entry": "extensions/beta/index.ts"\n}\n',
      },
      {
        path: "<CWD>/templates/files/extensions/{{ extensionId }}/index.ts.eta",
        content: "export const generated = true;\n",
      },
      {
        path: "<CWD>/templates/template.toml",
        content: [
          "[[variables]]",
          'name = "extensionId"',
          'default = "{{ projectName }}"',
          "",
          "[[variables]]",
          'name = "authorName"',
          "",
        ].join("\n"),
      },
      {
        path: "<CWD>/templates/files/package.json.eta",
        content: '{\n  "entry": "extensions/<%= it.extensionId %>/index.ts"\n}\n',
      },
    ],
    patch: `*** Begin Patch
*** Update File: <CWD>/packages/alpha/extensions/alpha/index.ts
*** Move to: <CWD>/packages/alpha/extensions/index.ts
*** Update File: <CWD>/packages/alpha/package.json
@@
-  "entry": "extensions/alpha/index.ts"
+  "entry": "extensions/index.ts"
*** Update File: <CWD>/packages/beta/extensions/beta/index.ts
*** Move to: <CWD>/packages/beta/extensions/index.ts
*** Update File: <CWD>/packages/beta/package.json
@@
-  "entry": "extensions/beta/index.ts"
+  "entry": "extensions/index.ts"
*** Update File: <CWD>/templates/files/extensions/{{ extensionId }}/index.ts.eta
*** Move to: <CWD>/templates/files/extensions/index.ts.eta
*** Update File: <CWD>/templates/template.toml
@@
-[[variables]]
-name = "extensionId"
-default = "{{ projectName }}"
-
*** Update File: <CWD>/templates/files/package.json.eta
@@
-  "entry": "extensions/<%= it.extensionId %>/index.ts"
+  "entry": "extensions/index.ts"
*** End Patch`,
    expected: {
      outcome: "success",
      files: [
        {
          path: "<CWD>/packages/alpha/extensions/index.ts",
          content: "export const alpha = true;\n",
        },
        {
          path: "<CWD>/packages/alpha/package.json",
          content: '{\n  "entry": "extensions/index.ts"\n}\n',
        },
        {
          path: "<CWD>/packages/beta/extensions/index.ts",
          content: "export const beta = true;\n",
        },
        {
          path: "<CWD>/packages/beta/package.json",
          content: '{\n  "entry": "extensions/index.ts"\n}\n',
        },
        {
          path: "<CWD>/templates/files/extensions/index.ts.eta",
          content: "export const generated = true;\n",
        },
        {
          path: "<CWD>/templates/template.toml",
          content: '[[variables]]\nname = "authorName"\n',
        },
        {
          path: "<CWD>/templates/files/package.json.eta",
          content: '{\n  "entry": "extensions/index.ts"\n}\n',
        },
      ],
      absent: [
        "<CWD>/packages/alpha/extensions/alpha/index.ts",
        "<CWD>/packages/beta/extensions/beta/index.ts",
        "<CWD>/templates/files/extensions/{{ extensionId }}/index.ts.eta",
      ],
      changeKinds: ["move", "update", "move", "update", "move", "update", "update"],
    },
  },
  {
    id: "move-only report followed by unicode add",
    sourceFingerprints: ["abb44bee9eb57d9e", "d3af31f72c5a83d4"],
    productionObservation:
      "A move-only report rename followed by a large Markdown add was rejected before either operation.",
    characteristics: [
      "move-only update",
      "source outside cwd",
      "missing destination parent",
      "Unicode add",
    ],
    initialFiles: [
      {
        path: "<ROOT>/external/report.md",
        content: "# Historical report\n\nSuperseded.\n",
      },
    ],
    patch: `*** Begin Patch
*** Update File: <ROOT>/external/report.md
*** Move to: <CWD>/archive/report.md
*** Add File: <CWD>/findings.md
+# Findings
+
+Status: **complete** — validation passed.
*** End Patch`,
    expected: {
      outcome: "success",
      files: [
        {
          path: "<CWD>/archive/report.md",
          content: "# Historical report\n\nSuperseded.\n",
        },
        {
          path: "<CWD>/findings.md",
          content: "# Findings\n\nStatus: **complete** — validation passed.\n",
        },
      ],
      absent: ["<ROOT>/external/report.md"],
      changeKinds: ["move", "add"],
    },
  },
  {
    id: "identity-context move and reference update",
    sourceFingerprints: ["10f1fd04a78ec9df"],
    productionObservation:
      "A successful rename used an unchanged context line solely to satisfy the old parser.",
    characteristics: ["move with identity-only chunk", "related update", "relative paths"],
    initialFiles: [
      {
        path: "<CWD>/description.md",
        content: "Tool for accessing the internet.\n",
      },
      {
        path: "<CWD>/runtime.ts",
        content: 'const description = "./description.md";\n',
      },
    ],
    patch: `*** Begin Patch
*** Update File: description.md
*** Move to: description.txt
@@
 Tool for accessing the internet.
*** Update File: runtime.ts
@@
-const description = "./description.md";
+const description = "./description.txt";
*** End Patch`,
    expected: {
      outcome: "success",
      files: [
        {
          path: "<CWD>/description.txt",
          content: "Tool for accessing the internet.\n",
        },
        {
          path: "<CWD>/runtime.ts",
          content: 'const description = "./description.txt";\n',
        },
      ],
      absent: ["<CWD>/description.md"],
      changeKinds: ["move", "update"],
    },
  },
  {
    id: "two executable identity moves and manifest update",
    sourceFingerprints: ["c8f47e8e86293d62"],
    productionObservation:
      "Two executable entrypoints were renamed with identity chunks before their manifest was updated.",
    characteristics: ["two identity-only moves", "executable mode preservation", "absolute paths"],
    initialFiles: [
      {
        path: "<CWD>/bin/import.js",
        content: '#!/usr/bin/env node\nimport "../dist/import.js";\n',
        mode: 0o755,
      },
      {
        path: "<CWD>/bin/convert.js",
        content: '#!/usr/bin/env node\nimport "../dist/convert.js";\n',
        mode: 0o755,
      },
      {
        path: "<CWD>/package.json",
        content: [
          "{",
          '  "bin": {',
          '    "import": "bin/import.js",',
          '    "convert": "bin/convert.js"',
          "  }",
          "}",
          "",
        ].join("\n"),
      },
    ],
    patch: `*** Begin Patch
*** Update File: <CWD>/bin/import.js
*** Move to: <CWD>/bin/import
@@
 #!/usr/bin/env node
*** Update File: <CWD>/bin/convert.js
*** Move to: <CWD>/bin/convert
@@
 #!/usr/bin/env node
*** Update File: <CWD>/package.json
@@
-    "import": "bin/import.js",
-    "convert": "bin/convert.js"
+    "import": "bin/import",
+    "convert": "bin/convert"
*** End Patch`,
    expected: {
      outcome: "success",
      files: [
        {
          path: "<CWD>/bin/import",
          content: '#!/usr/bin/env node\nimport "../dist/import.js";\n',
          mode: 0o755,
        },
        {
          path: "<CWD>/bin/convert",
          content: '#!/usr/bin/env node\nimport "../dist/convert.js";\n',
          mode: 0o755,
        },
        {
          path: "<CWD>/package.json",
          content: [
            "{",
            '  "bin": {',
            '    "import": "bin/import",',
            '    "convert": "bin/convert"',
            "  }",
            "}",
            "",
          ].join("\n"),
        },
      ],
      absent: ["<CWD>/bin/import.js", "<CWD>/bin/convert.js"],
      changeKinds: ["move", "move", "update"],
    },
  },
  {
    id: "text update and move in a mixed absolute-path batch",
    sourceFingerprints: ["669d85af377a1dbe", "d36762ba049454fc"],
    productionObservation:
      "Successful temporary-workspace patches combined update-and-move, another update, and deletion.",
    characteristics: ["update and move", "multiple chunks", "absolute paths outside cwd", "delete"],
    initialFiles: [
      {
        path: "<ROOT>/external/service.ts",
        content: [
          "export interface ServiceConfig {",
          "  endpoint: string;",
          "  retries: number;",
          "}",
          "",
          "export function connect(config: ServiceConfig): string {",
          "  return `Connecting to ${config.endpoint}`;",
          "}",
          "",
        ].join("\n"),
      },
      {
        path: "<ROOT>/external/settings.json",
        content: '{\n  "enabled": true,\n  "timeout": 3000\n}\n',
      },
      {
        path: "<ROOT>/external/obsolete.md",
        content: "Obsolete.\n",
      },
    ],
    patch: `*** Begin Patch
*** Update File: <ROOT>/external/service.ts
*** Move to: <ROOT>/external/client.ts
@@
 export interface ServiceConfig {
   endpoint: string;
   retries: number;
+  secure: boolean;
 }
@@
 export function connect(config: ServiceConfig): string {
-  return \`Connecting to \${config.endpoint}\`;
+  return \`Connecting securely to \${config.endpoint}\`;
 }
*** Update File: <ROOT>/external/settings.json
@@
-  "timeout": 3000
+  "timeout": 5000
*** Delete File: <ROOT>/external/obsolete.md
*** End Patch`,
    expected: {
      outcome: "success",
      files: [
        {
          path: "<ROOT>/external/client.ts",
          content: [
            "export interface ServiceConfig {",
            "  endpoint: string;",
            "  retries: number;",
            "  secure: boolean;",
            "}",
            "",
            "export function connect(config: ServiceConfig): string {",
            "  return `Connecting securely to ${config.endpoint}`;",
            "}",
            "",
          ].join("\n"),
        },
        {
          path: "<ROOT>/external/settings.json",
          content: '{\n  "enabled": true,\n  "timeout": 5000\n}\n',
        },
      ],
      absent: ["<ROOT>/external/service.ts", "<ROOT>/external/obsolete.md"],
      changeKinds: ["update", "update", "delete"],
    },
  },
  {
    id: "repeated delete-add replacements under template paths",
    sourceFingerprints: ["8860c0616ecf0117", "effdc759dbf1fbf7"],
    productionObservation:
      "Successful template maintenance repeatedly deleted and recreated the same resolved paths.",
    characteristics: [
      "repeated resolved paths",
      "delete then add",
      "template path containing spaces and braces",
      "mixed update and replacement operations",
    ],
    initialFiles: [
      {
        path: "<CWD>/template.toml",
        content: [
          "[[variables]]",
          'name = "displayName"',
          "",
          "[[variables]]",
          'name = "authorName"',
          "",
        ].join("\n"),
      },
      {
        path: "<CWD>/files/extensions/{{ extensionId }}/index.ts.eta",
        content: "export function oldExtension() {}\n",
      },
      {
        path: "<CWD>/files/test/extension.test.ts.eta",
        content: "old test\n",
      },
      {
        path: "<CWD>/files/CHANGELOG.md",
        content: "# Old changelog\n",
      },
    ],
    patch: `*** Begin Patch
*** Update File: <CWD>/template.toml
@@
-[[variables]]
-name = "displayName"
-
*** Delete File: <CWD>/files/extensions/{{ extensionId }}/index.ts.eta
*** Add File: <CWD>/files/extensions/{{ extensionId }}/index.ts.eta
+export function extension() {}
*** Delete File: <CWD>/files/test/extension.test.ts.eta
*** Add File: <CWD>/files/test/extension.test.ts.eta
+import test from "node:test";
*** Delete File: <CWD>/files/CHANGELOG.md
*** Add File: <CWD>/files/CHANGELOG.md
+# Changelog
+
+## Unreleased
*** End Patch`,
    expected: {
      outcome: "success",
      files: [
        {
          path: "<CWD>/template.toml",
          content: '[[variables]]\nname = "authorName"\n',
        },
        {
          path: "<CWD>/files/extensions/{{ extensionId }}/index.ts.eta",
          content: "export function extension() {}\n",
        },
        {
          path: "<CWD>/files/test/extension.test.ts.eta",
          content: 'import test from "node:test";\n',
        },
        {
          path: "<CWD>/files/CHANGELOG.md",
          content: "# Changelog\n\n## Unreleased\n",
        },
      ],
      absent: [],
      changeKinds: ["update", "delete", "add", "delete", "add", "delete", "add"],
    },
  },
  {
    id: "trailing empty context marker before the next update",
    sourceFingerprints: ["4b65d52df0f298d3", "c749afa2a651cd60"],
    productionObservation:
      "Two otherwise valid patches were rejected when an empty @@ marker preceded the next file header.",
    characteristics: ["formerly rejected parser shape", "empty identity chunk", "multiple updates"],
    initialFiles: [
      {
        path: "<CWD>/AGENTS.md",
        content: "# Guidance\n\nKeep this rule.\n",
      },
      {
        path: "<CWD>/README.md",
        content: "# Before\n",
      },
    ],
    patch: `*** Begin Patch
*** Update File: <CWD>/AGENTS.md
@@
 Keep this rule.
+Add this rule.
@@
*** Update File: <CWD>/README.md
@@
-# Before
+# After
*** End Patch`,
    expected: {
      outcome: "success",
      files: [
        {
          path: "<CWD>/AGENTS.md",
          content: "# Guidance\n\nKeep this rule.\nAdd this rule.\n",
        },
        {
          path: "<CWD>/README.md",
          content: "# After\n",
        },
      ],
      absent: [],
      changeKinds: ["update", "update"],
    },
  },
  {
    id: "stale context recovers the complete multi-operation patch",
    sourceFingerprints: ["f8e65c8b75037f8e"],
    productionObservation:
      "A 13-operation maintenance patch failed on stale README context and was retried with corrected context.",
    characteristics: [
      "production context recovery",
      "valid operation before conflict",
      "replacement operations after conflict",
      "uniquely located insertion around an extra line",
    ],
    initialFiles: [
      {
        path: "<CWD>/package.json",
        content: '{\n  "scripts": {\n    "check": "hk check"\n  }\n}\n',
      },
      {
        path: "<CWD>/README.md",
        content: "```text\nnpm run check\nnpm test\nnpm run build\n```\n",
      },
      {
        path: "<CWD>/CHANGELOG.md",
        content: "# Existing changelog\n",
      },
    ],
    patch: `*** Begin Patch
*** Update File: <CWD>/package.json
@@
   "scripts": {
-    "check": "hk check"
+    "check": "hk check",
+    "pack:dry": "npm pack --dry-run"
   }
*** Update File: <CWD>/README.md
@@
 npm run check
 npm test
+npm run pack:dry
 \`\`\`
*** Delete File: <CWD>/CHANGELOG.md
*** Add File: <CWD>/CHANGELOG.md
+# Changelog
+
+## Unreleased
*** End Patch`,
    expected: {
      outcome: "success",
      files: [
        {
          path: "<CWD>/package.json",
          content:
            '{\n  "scripts": {\n    "check": "hk check",\n    "pack:dry": "npm pack --dry-run"\n  }\n}\n',
        },
        {
          path: "<CWD>/README.md",
          content: "```text\nnpm run check\nnpm test\nnpm run pack:dry\nnpm run build\n```\n",
        },
        {
          path: "<CWD>/CHANGELOG.md",
          content: "# Changelog\n\n## Unreleased\n",
        },
      ],
      absent: [],
      changeKinds: ["update", "update", "delete", "add"],
    },
  },
  {
    id: "current-session formatter-reflowed engine method",
    sourceFingerprints: ["684cab162b03aa44"],
    productionObservation:
      "An implementation patch missed after the formatter collapsed a method signature.",
    characteristics: [
      "current-session failure",
      "formatter-reflowed TypeScript",
      "single structural replacement",
      "current formatting preserved",
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
      outcome: "success",
      files: [
        {
          path: "<CWD>/planner.ts",
          content: [
            "class Planner {",
            "  private describe(index: number, operation: string): string {",
            "    return `${index}=${operation}`;",
            "  }",
            "}",
            "",
          ].join("\n"),
        },
      ],
      absent: [],
      changeKinds: ["update"],
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
      "current formatting preserved",
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
      outcome: "success",
      files: [
        {
          path: "<CWD>/fixture.test.ts",
          content: [
            'void test("fixture", async () => {',
            "  await assert.rejects(applyPatch(cwd, ambiguousPatch), ApplyPatchVerificationError);",
            "});",
            "",
          ].join("\n"),
        },
      ],
      absent: [],
      changeKinds: ["update"],
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
      "preflight batch recovery",
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
      outcome: "success",
      files: [
        {
          path: "<CWD>/README.md",
          content: [
            "# Package API",
            "",
            "```ts",
            "const grammar = new URL(",
            '  import.meta.resolve("@scope/package/grammar.wasm"),',
            ");",
            "```",
            "",
          ].join("\n"),
        },
      ],
      absent: [],
      changeKinds: ["update"],
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
      outcome: "success",
      files: [
        {
          path: "<CWD>/policy.md",
          content: [
            "- publisher identity is bound to the workflow;",
            "- registry provenance is recorded;",
            "- artifact attestations are retained.",
            "",
            "These controls preserve exact-artifact authorization.",
            "",
            "The initial publication follows a separately reviewed bootstrap process.",
            "",
          ].join("\n"),
        },
      ],
      absent: [],
      changeKinds: ["update"],
    },
  },
  {
    id: "recent reflowed Markdown paragraph insertion",
    sourceFingerprints: ["de34398026b29d09"],
    productionObservation:
      "A research-note insertion failed after its plain-text anchor paragraph was reflowed from two lines to one.",
    characteristics: [
      "last-two-days failure",
      "plain Markdown prose",
      "paragraph reflow",
      "unique insertion",
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
      outcome: "success",
      files: [
        {
          path: "<CWD>/research.md",
          content:
            "Existing automation separately exercises alpha-only, beta-only, and mixed outputs.\n\nA final audit confirmed the expected processing semantics.\n",
        },
      ],
      absent: [],
      changeKinds: ["update"],
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
      outcome: "success",
      files: [
        {
          path: "<CWD>/follow-up.md",
          content:
            "Current introduction.\n\nThe practical risk is transient load rather than data loss.\n\nThe follow-up runbook records how to validate that risk.\n",
        },
      ],
      absent: [],
      changeKinds: ["update"],
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
    id: "multi-chunk unicode insertion and deletion",
    sourceFingerprints: ["2ed7736dbe45facc", "46fbd0dc973e9eec"],
    productionObservation:
      "Successful maintenance patches commonly combined many chunks, insertions, deletions, and Unicode.",
    characteristics: ["multi-chunk update", "pure insertion", "deletion-only chunk", "Unicode"],
    initialFiles: [
      {
        path: "<CWD>/runbook.md",
        content: [
          "# Runbook",
          "",
          "## Current status",
          "Legacy.",
          "",
          "## Steps",
          "- deploy",
          "",
          "## Notes",
          "Temporary.",
          "",
        ].join("\n"),
      },
      {
        path: "<CWD>/config.ts",
        content: "export const values = [];\n",
      },
    ],
    patch: `*** Begin Patch
*** Update File: <CWD>/runbook.md
@@
 ## Current status
-Legacy.
+Ready — verified.
@@
-## Steps
+## Steps
+- validate
@@
 ## Notes
-Temporary.
*** Update File: <CWD>/config.ts
@@
+export const enabled = true;
*** End Patch`,
    expected: {
      outcome: "success",
      files: [
        {
          path: "<CWD>/runbook.md",
          content: [
            "# Runbook",
            "",
            "## Current status",
            "Ready — verified.",
            "",
            "## Steps",
            "- validate",
            "- deploy",
            "",
            "## Notes",
            "",
          ].join("\n"),
        },
        {
          path: "<CWD>/config.ts",
          content: "export const values = [];\nexport const enabled = true;\n",
        },
      ],
      absent: [],
      changeKinds: ["update", "update"],
    },
  },
];
