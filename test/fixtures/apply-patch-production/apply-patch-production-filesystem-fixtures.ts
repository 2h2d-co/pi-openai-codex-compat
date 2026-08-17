import type { ProductionApplyPatchFixture } from "./apply-patch-production-contracts.ts";

export const PRODUCTION_APPLY_PATCH_FILESYSTEM_FIXTURES: ProductionApplyPatchFixture[] = [
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
];
