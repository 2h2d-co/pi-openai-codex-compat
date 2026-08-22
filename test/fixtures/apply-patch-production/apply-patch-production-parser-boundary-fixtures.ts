import type { ProductionApplyPatchFixture } from "./apply-patch-production-contracts.ts";

export const PRODUCTION_APPLY_PATCH_PARSER_BOUNDARY_FIXTURES: ProductionApplyPatchFixture[] = [
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
    id: "stale insertion context rejects the complete multi-operation patch",
    sourceFingerprints: ["f8e65c8b75037f8e"],
    productionObservation:
      "A 13-operation maintenance patch failed on stale README context and was retried with corrected context.",
    characteristics: [
      "production context rejection",
      "valid operation before conflict",
      "replacement operations after conflict",
      "ambiguous insertion around an extra line",
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
      outcome: "verification-error",
      messagePattern: /Failed to find expected lines/u,
    },
  },
];
