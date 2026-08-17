import type { GrammarName } from "@2h2d/tree-sitter-wasms";

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

export type MatchMode = "exact" | "trim-end" | "trim" | "unicode";

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

export type FormatterMatchCandidateRange = {
  startLine: number;
  endLine: number;
};

export type FormatterMatchFailureReason =
  | "no-candidate"
  | "no-ordered-mapping"
  | "too-many-candidates"
  | "ambiguous-output"
  | "mapping-limit"
  | "overlapping-edits";

export type FormatterMatchFailureDetails = {
  reason: FormatterMatchFailureReason;
  path: string;
  groupCount: number;
  groupIndex?: number;
  chunkCount?: number;
  chunkIndex?: number;
  candidateCount: number;
  candidates: FormatterMatchCandidateRange[];
  previousGroupIndex?: number;
  previousCandidates?: FormatterMatchCandidateRange[];
  reverseOrdered?: boolean;
  overlapping?: boolean;
  replacementCandidateCount?: number;
  replacementCandidates?: FormatterMatchCandidateRange[];
  oldExcerpt?: string;
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
