import type { GrammarName } from "@2h2d/tree-sitter-wasms";

export type {
  FormatterMatchCandidateRange,
  FormatterMatchFailureDetails,
  FormatterMatchFailureReason,
} from "./apply-patch-matcher-failure-schema.ts";

export type UpdateHunkLine = {
  kind: "add" | "context" | "delete";
  text: string;
};

export type UpdateChunk = {
  context?: string;
  oldLines: string[];
  newLines: string[];
  lines: UpdateHunkLine[];
  endOfFile: boolean;
};

export const MATCH_MODES = ["exact", "trim-end", "trim", "unicode"] as const;

export type MatchMode = (typeof MATCH_MODES)[number];

export type ByteEdit = {
  start: number;
  end: number;
  replacement: Buffer;
};

export type EditCandidate = {
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  edits: ByteEdit[];
};

export type EditGroup = {
  chunk: UpdateChunk;
  chunkIndex: number;
  chunkCount: number;
  oldLines: string[];
  newLines: string[];
  beforeContext: string[];
  afterContext: string[];
  endsChunk: boolean;
};

export type SyntaxPathEntry = {
  id: number;
  type: string;
};

export type SyntaxToken = {
  type: string;
  text: string;
  start: number;
  end: number;
  path: SyntaxPathEntry[];
  unsafe: boolean;
};

export type StructuralDocument = {
  grammar: GrammarName;
  tokens: SyntaxToken[];
};

export type WrappedFragment = {
  source: string;
  start: number;
  end: number;
};
