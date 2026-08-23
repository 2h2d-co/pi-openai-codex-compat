import type { Static } from "typebox";

const INTEGER_ARRAY_SCHEMA = {
  type: "array",
  items: { type: "integer" },
} as const;

const PATCH_ENTRY_TYPE_SCHEMA = {
  enum: ["regular-file", "symlink"],
} as const;

export const APPLIED_PATCH_CHANGE_SCHEMA = {
  anyOf: [
    {
      type: "object",
      properties: {
        kind: { const: "add" },
        path: { type: "string" },
        content: { type: "string" },
        overwrittenContent: { type: "string" },
        displayDiff: { type: "string" },
        additions: { type: "integer" },
        deletions: { type: "integer" },
      },
      required: ["kind", "path", "content", "displayDiff", "additions", "deletions"],
    },
    {
      type: "object",
      properties: {
        kind: { const: "delete" },
        path: { type: "string" },
        entryType: PATCH_ENTRY_TYPE_SCHEMA,
        content: { type: "string" },
        displayDiff: { type: "string" },
        additions: { type: "integer" },
        deletions: { type: "integer" },
      },
      required: ["kind", "path", "entryType", "displayDiff", "additions", "deletions"],
    },
    {
      type: "object",
      properties: {
        kind: { const: "update" },
        path: { type: "string" },
        moveTo: { type: "string" },
        oldContent: { type: "string" },
        newContent: { type: "string" },
        overwrittenMoveContent: { type: "string" },
        displayDiff: { type: "string" },
        additions: { type: "integer" },
        deletions: { type: "integer" },
      },
      required: [
        "kind",
        "path",
        "oldContent",
        "newContent",
        "displayDiff",
        "additions",
        "deletions",
      ],
    },
    {
      type: "object",
      properties: {
        kind: { const: "move" },
        sourcePath: { type: "string" },
        destinationPath: { type: "string" },
        replacedDestination: { type: "boolean" },
        entryType: PATCH_ENTRY_TYPE_SCHEMA,
        exact: { type: "boolean" },
        displayDiff: { const: "" },
        additions: { const: 0 },
        deletions: { const: 0 },
      },
      required: [
        "kind",
        "sourcePath",
        "destinationPath",
        "replacedDestination",
        "entryType",
        "exact",
        "displayDiff",
        "additions",
        "deletions",
      ],
    },
  ],
} as const;

export type AppliedPatchChange = Static<typeof APPLIED_PATCH_CHANGE_SCHEMA>;

const ORDINARY_APPLY_PATCH_INSTRUCTION_REASON_CODES = [
  "empty-update",
  "identity-update",
  "content-already-present",
  "update-result-unchanged",
  "path-already-absent",
  "same-entry-move",
  "dead-dominated",
] as const;

const APPLY_PATCH_INSTRUCTION_REASON_CODES = [
  ...ORDINARY_APPLY_PATCH_INSTRUCTION_REASON_CODES,
  "move-already-fulfilled",
] as const;

export const APPLY_PATCH_INSTRUCTION_REASON_SCHEMA = {
  type: "object",
  properties: {
    code: {
      enum: APPLY_PATCH_INSTRUCTION_REASON_CODES,
    },
    message: { type: "string" },
    dominatingInstructions: INTEGER_ARRAY_SCHEMA,
    relatedInstructions: INTEGER_ARRAY_SCHEMA,
  },
  required: ["code", "message"],
  anyOf: [
    {
      properties: {
        code: {
          enum: ORDINARY_APPLY_PATCH_INSTRUCTION_REASON_CODES,
        },
      },
      required: ["code"],
    },
    {
      properties: {
        code: { const: "move-already-fulfilled" },
        relatedInstructions: {
          type: "array",
          items: { type: "integer" },
          minItems: 1,
          maxItems: 1,
        },
      },
      required: ["code", "relatedInstructions"],
    },
  ],
} as const;

export type ApplyPatchInstructionReason = Static<typeof APPLY_PATCH_INSTRUCTION_REASON_SCHEMA>;
export type ApplyPatchInstructionReasonCode = ApplyPatchInstructionReason["code"];

export const APPLY_PATCH_FILE_ENTRY_SCHEMA = {
  anyOf: [
    {
      type: "object",
      properties: {
        entryType: { const: "regular-file" },
      },
      required: ["entryType"],
    },
    {
      type: "object",
      properties: {
        entryType: { const: "symlink" },
        target: { type: "string" },
      },
      required: ["entryType", "target"],
    },
  ],
} as const;

export type ApplyPatchFileEntryDetails = Static<typeof APPLY_PATCH_FILE_ENTRY_SCHEMA>;

export const APPLY_PATCH_INSTRUCTION_EFFECT_SCHEMA = {
  anyOf: [
    {
      type: "object",
      properties: {
        kind: {
          enum: [
            "created",
            "updated",
            "deleted",
            "directory-created",
            "temporary-entry-remains",
            "source-remains",
          ],
        },
        path: { type: "string" },
      },
      required: ["kind", "path"],
    },
    {
      type: "object",
      properties: {
        kind: { const: "replaced" },
        path: { type: "string" },
        previousEntry: APPLY_PATCH_FILE_ENTRY_SCHEMA,
        replacementEntry: APPLY_PATCH_FILE_ENTRY_SCHEMA,
      },
      required: ["kind", "path", "previousEntry", "replacementEntry"],
    },
    {
      type: "object",
      properties: {
        kind: {
          enum: ["symlink-removed", "symlink-moved", "symlink-target-modified"],
        },
        path: { type: "string" },
        target: { type: "string" },
      },
      required: ["kind", "path", "target"],
    },
  ],
} as const;

export type ApplyPatchInstructionEffect = Static<typeof APPLY_PATCH_INSTRUCTION_EFFECT_SCHEMA>;

export const APPLY_PATCH_FINAL_PATH_STATE_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string" },
    error: { type: "string" },
    state: {
      enum: [
        "absent",
        "regular-file",
        "symlink",
        "directory",
        "other-entry",
        "unchanged",
        "requested-content",
        "different-from-requested-content",
        "different-from-requested-and-previous-content",
        "different-from-previous-content",
        "different-entry",
        "different-entry-type",
        "not-verified",
      ],
    },
  },
  required: ["path", "state"],
} as const;

export type ApplyPatchFinalPathState = Static<typeof APPLY_PATCH_FINAL_PATH_STATE_SCHEMA>;

export const APPLY_PATCH_INSTRUCTION_SCHEMA = {
  type: "object",
  properties: {
    index: { type: "integer" },
    kind: { enum: ["add", "delete", "update", "move"] },
    path: { type: "string" },
    moveTo: { type: "string" },
    status: { enum: ["applied", "planned", "no-op", "dead", "failed", "not-run"] },
    reason: APPLY_PATCH_INSTRUCTION_REASON_SCHEMA,
    effects: {
      type: "array",
      items: APPLY_PATCH_INSTRUCTION_EFFECT_SCHEMA,
    },
    finalStates: {
      type: "array",
      items: APPLY_PATCH_FINAL_PATH_STATE_SCHEMA,
    },
    changeIndexes: INTEGER_ARRAY_SCHEMA,
    error: { type: "string" },
  },
  required: ["index", "kind", "path", "status"],
} as const;

export type ApplyPatchInstructionDetails = Static<typeof APPLY_PATCH_INSTRUCTION_SCHEMA>;
export type ApplyPatchInstructionStatus = ApplyPatchInstructionDetails["status"];

export const APPLY_PATCH_FAILURE_SCHEMA = {
  type: "object",
  properties: {
    phase: { enum: ["input", "parse", "preflight", "execution"] },
    message: { type: "string" },
    failedInstruction: { type: "integer" },
  },
  required: ["phase", "message"],
} as const;

export type ApplyPatchFailureDetails = Static<typeof APPLY_PATCH_FAILURE_SCHEMA>;

export const APPLY_PATCH_DETAILS_SCHEMA = {
  type: "object",
  properties: {
    status: { enum: ["completed", "failed"] },
    exact: { type: "boolean" },
    changes: {
      type: "array",
      items: APPLIED_PATCH_CHANGE_SCHEMA,
    },
    added: {
      type: "array",
      items: { type: "string" },
    },
    modified: {
      type: "array",
      items: { type: "string" },
    },
    deleted: {
      type: "array",
      items: { type: "string" },
    },
    instructions: {
      type: "array",
      items: APPLY_PATCH_INSTRUCTION_SCHEMA,
    },
    failure: APPLY_PATCH_FAILURE_SCHEMA,
    error: { type: "string" },
  },
  required: ["status", "exact", "changes", "added", "modified", "deleted"],
} as const;

export type ApplyPatchDetails = Static<typeof APPLY_PATCH_DETAILS_SCHEMA>;
