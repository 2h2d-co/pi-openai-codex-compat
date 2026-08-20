import type { Static } from "typebox";

export const FORMATTER_MATCH_CANDIDATE_RANGE_SCHEMA = {
  type: "object",
  properties: {
    startLine: { type: "integer" },
    endLine: { type: "integer" },
  },
  required: ["startLine", "endLine"],
} as const;

export type FormatterMatchCandidateRange = Static<typeof FORMATTER_MATCH_CANDIDATE_RANGE_SCHEMA>;

export const FORMATTER_MATCH_FAILURE_SCHEMA = {
  type: "object",
  properties: {
    reason: {
      enum: [
        "no-candidate",
        "no-ordered-mapping",
        "too-many-candidates",
        "ambiguous-output",
        "mapping-limit",
        "overlapping-edits",
      ],
    },
    path: { type: "string" },
    groupCount: { type: "integer" },
    groupIndex: { type: "integer" },
    chunkCount: { type: "integer" },
    chunkIndex: { type: "integer" },
    candidateCount: { type: "integer" },
    candidates: {
      type: "array",
      items: FORMATTER_MATCH_CANDIDATE_RANGE_SCHEMA,
    },
    previousGroupIndex: { type: "integer" },
    previousCandidates: {
      type: "array",
      items: FORMATTER_MATCH_CANDIDATE_RANGE_SCHEMA,
    },
    reverseOrdered: { type: "boolean" },
    overlapping: { type: "boolean" },
    replacementCandidateCount: { type: "integer" },
    replacementCandidates: {
      type: "array",
      items: FORMATTER_MATCH_CANDIDATE_RANGE_SCHEMA,
    },
    oldExcerpt: { type: "string" },
  },
  required: ["reason", "path", "groupCount", "candidateCount", "candidates"],
} as const;

export type FormatterMatchFailureDetails = Static<typeof FORMATTER_MATCH_FAILURE_SCHEMA>;
export type FormatterMatchFailureReason = FormatterMatchFailureDetails["reason"];
