import type { ProductionApplyPatchFixture } from "./apply-patch-production-contracts.ts";

export const PRODUCTION_APPLY_PATCH_MULTI_CHUNK_FIXTURES: ProductionApplyPatchFixture[] = [
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
