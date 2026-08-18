import type { UpdateChunk, UpdateHunkLine } from "../apply-patch-matcher.ts";
import type {
  ApplyPatchInstructionDetails,
  ParsedPatch,
  PatchOperation,
} from "./apply-patch-engine-contracts.ts";
import { ApplyPatchParseError } from "./apply-patch-engine-errors.ts";

export const BEGIN_PATCH = "*** Begin Patch";

export const END_PATCH = "*** End Patch";

export const ADD_FILE = "*** Add File: ";

export const DELETE_FILE = "*** Delete File: ";

export const UPDATE_FILE = "*** Update File: ";

export const MOVE_TO = "*** Move to: ";

export const END_OF_FILE = "*** End of File";

export const CHANGE_CONTEXT = "@@ ";

export const EMPTY_CHANGE_CONTEXT = "@@";

export const ENVIRONMENT_ID = "*** Environment ID:";

export function isRustWhitespace(codePoint: number): boolean {
  return (
    (codePoint >= 0x0009 && codePoint <= 0x000d) ||
    codePoint === 0x0020 ||
    codePoint === 0x0085 ||
    codePoint === 0x00a0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000
  );
}

export function rustTrimStart(value: string): string {
  let index = 0;
  while (index < value.length && isRustWhitespace(value.charCodeAt(index))) index += 1;
  return value.slice(index);
}

export function rustTrimEnd(value: string): string {
  let index = value.length;
  while (index > 0 && isRustWhitespace(value.charCodeAt(index - 1))) index -= 1;
  return value.slice(0, index);
}

export function rustTrim(value: string): string {
  return rustTrimEnd(rustTrimStart(value));
}

export type ParserMode =
  | { kind: "not-started" }
  | { kind: "started" }
  | { kind: "add" }
  | { kind: "delete" }
  | { kind: "update"; hunkLineNumber: number }
  | { kind: "ended" };

export class PatchParser {
  private mode: ParserMode = { kind: "not-started" };
  private readonly operations: PatchOperation[] = [];
  private environmentId?: string;
  private lineNumber = 0;

  parse(lines: readonly string[], patch: string): ParsedPatch {
    for (const [index, line] of lines.entries()) {
      this.lineNumber += 1;
      if (index === lines.length - 1 && rustTrim(line) === END_PATCH) {
        this.mode = { kind: "ended" };
      } else {
        this.processLine(line);
      }
    }
    if (this.mode.kind !== "ended") {
      throw new ApplyPatchParseError("patch", `The last line of the patch must be '${END_PATCH}'`);
    }
    const result: ParsedPatch = {
      patch,
      operations: this.operations,
    };
    if (this.environmentId) result.environmentId = this.environmentId;
    return result;
  }

  private lastUpdate(): Extract<PatchOperation, { kind: "update" }> | undefined {
    const operation = this.operations.at(-1);
    return operation?.kind === "update" ? operation : undefined;
  }

  private invalidHunkHeader(line: string): ApplyPatchParseError {
    return new ApplyPatchParseError(
      "hunk",
      `'${line}' is not a valid hunk header. Valid hunk headers: '${ADD_FILE}{path}', '${DELETE_FILE}{path}', '${UPDATE_FILE}{path}'`,
      this.lineNumber,
    );
  }

  private unexpectedUpdateLine(line: string): ApplyPatchParseError {
    return new ApplyPatchParseError(
      "hunk",
      `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
      this.lineNumber,
    );
  }

  private handleHeadersAndEnd(line: string): boolean {
    if (this.mode.kind === "started" && line.startsWith(ENVIRONMENT_ID)) {
      if (this.environmentId) {
        throw new ApplyPatchParseError(
          "patch",
          "apply_patch environment_id cannot be specified more than once",
        );
      }
      const environmentId = rustTrim(line.slice(ENVIRONMENT_ID.length));
      if (!environmentId) {
        throw new ApplyPatchParseError("patch", "apply_patch environment_id cannot be empty");
      }
      this.environmentId = environmentId;
      return true;
    }
    if (line === END_PATCH) {
      this.mode = { kind: "ended" };
      return true;
    }
    if (line.startsWith(ADD_FILE)) {
      this.operations.push({ kind: "add", path: line.slice(ADD_FILE.length), content: "" });
      this.mode = { kind: "add" };
      return true;
    }
    if (line.startsWith(DELETE_FILE)) {
      this.operations.push({ kind: "delete", path: line.slice(DELETE_FILE.length) });
      this.mode = { kind: "delete" };
      return true;
    }
    if (line.startsWith(UPDATE_FILE)) {
      this.operations.push({
        kind: "update",
        path: line.slice(UPDATE_FILE.length),
        chunks: [],
      });
      this.mode = { kind: "update", hunkLineNumber: this.lineNumber };
      return true;
    }
    return false;
  }

  private ensureUpdateChunk(operation: Extract<PatchOperation, { kind: "update" }>): UpdateChunk {
    let chunk = operation.chunks.at(-1);
    if (!chunk) {
      chunk = { oldLines: [], newLines: [], lines: [], endOfFile: false };
      operation.chunks.push(chunk);
    }
    return chunk;
  }

  private appendUpdateLine(
    operation: Extract<PatchOperation, { kind: "update" }>,
    line: UpdateHunkLine,
  ): void {
    const chunk = this.ensureUpdateChunk(operation);
    chunk.lines.push(line);
    if (line.kind !== "add") chunk.oldLines.push(line.text);
    if (line.kind !== "delete") chunk.newLines.push(line.text);
  }

  private processLine(line: string): void {
    const trimmed = rustTrim(line);
    switch (this.mode.kind) {
      case "not-started":
        if (trimmed === BEGIN_PATCH) {
          this.mode = { kind: "started" };
          return;
        }
        throw new ApplyPatchParseError(
          "patch",
          `The first line of the patch must be '${BEGIN_PATCH}'`,
        );

      case "started":
        if (this.handleHeadersAndEnd(trimmed)) return;
        throw this.invalidHunkHeader(trimmed);

      case "add": {
        if (this.handleHeadersAndEnd(trimmed)) return;
        const operation = this.operations.at(-1);
        if (operation?.kind === "add" && line.startsWith("+")) {
          operation.content += `${line.slice(1)}\n`;
          return;
        }
        throw this.invalidHunkHeader(trimmed);
      }

      case "delete":
        if (this.handleHeadersAndEnd(trimmed)) return;
        throw this.invalidHunkHeader(trimmed);

      case "update": {
        const updateLine = rustTrimEnd(line);
        if (this.handleHeadersAndEnd(updateLine)) return;
        const operation = this.lastUpdate();
        if (!operation) throw this.unexpectedUpdateLine(line);

        const lastChunk = operation.chunks.at(-1);
        if (lastChunk?.endOfFile) {
          if (!updateLine) return;
          if (updateLine !== EMPTY_CHANGE_CONTEXT && !updateLine.startsWith(CHANGE_CONTEXT)) {
            throw new ApplyPatchParseError(
              "hunk",
              `Expected update hunk to start with a @@ context marker, got: '${line}'`,
              this.lineNumber,
            );
          }
        }

        if (operation.chunks.length === 0 && !operation.moveTo && updateLine.startsWith(MOVE_TO)) {
          operation.moveTo = updateLine.slice(MOVE_TO.length);
          return;
        }

        if (updateLine === EMPTY_CHANGE_CONTEXT) {
          operation.chunks.push({ oldLines: [], newLines: [], lines: [], endOfFile: false });
          return;
        }
        if (updateLine.startsWith(CHANGE_CONTEXT)) {
          operation.chunks.push({
            context: updateLine.slice(CHANGE_CONTEXT.length),
            oldLines: [],
            newLines: [],
            lines: [],
            endOfFile: false,
          });
          return;
        }
        if (updateLine === END_OF_FILE) {
          const chunk = operation.chunks.at(-1);
          if (chunk) chunk.endOfFile = true;
          return;
        }

        if (line === "") {
          this.appendUpdateLine(operation, { kind: "context", text: "" });
          return;
        }
        if (line.startsWith(" ")) {
          this.appendUpdateLine(operation, { kind: "context", text: line.slice(1) });
          return;
        }
        if (line.startsWith("+")) {
          this.appendUpdateLine(operation, { kind: "add", text: line.slice(1) });
          return;
        }
        if (line.startsWith("-")) {
          this.appendUpdateLine(operation, { kind: "delete", text: line.slice(1) });
          return;
        }

        const currentChunk = operation.chunks.at(-1);
        if (
          currentChunk &&
          (currentChunk.oldLines.length > 0 || currentChunk.newLines.length > 0)
        ) {
          throw new ApplyPatchParseError(
            "hunk",
            `Expected update hunk to start with a @@ context marker, got: '${line}'`,
            this.lineNumber,
          );
        }
        throw this.unexpectedUpdateLine(line);
      }

      case "ended":
        if (!trimmed) return;
        throw new ApplyPatchParseError(
          "patch",
          `The last line of the patch must be '${END_PATCH}'`,
        );
    }
  }
}

export function normalizedLines(patch: string): string[] {
  const normalized = rustTrim(patch);
  if (!normalized) return [];
  return normalized.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

export function checkBoundaries(lines: readonly string[]): void {
  const first = lines[0] === undefined ? undefined : rustTrim(lines[0]);
  const lastLine = lines.at(-1);
  const last = lastLine === undefined ? undefined : rustTrim(lastLine);
  if (first !== undefined && first !== BEGIN_PATCH) {
    throw new ApplyPatchParseError("patch", `The first line of the patch must be '${BEGIN_PATCH}'`);
  }
  if (last !== END_PATCH) {
    throw new ApplyPatchParseError("patch", `The last line of the patch must be '${END_PATCH}'`);
  }
}

export function parsePatchDocument(patch: string): ParsedPatch {
  const originalLines = normalizedLines(patch);
  let lines = originalLines;
  try {
    checkBoundaries(lines);
  } catch (originalError) {
    const first = originalLines[0];
    const last = originalLines.at(-1);
    const heredocStart = first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"';
    if (!heredocStart || !last?.endsWith("EOF") || originalLines.length < 4) {
      throw originalError;
    }
    lines = originalLines.slice(1, -1);
    checkBoundaries(lines);
  }

  const normalizedPatch = lines.join("\n");
  return new PatchParser().parse(lines, normalizedPatch);
}

export function parsePatch(patch: string): PatchOperation[] {
  return parsePatchDocument(patch).operations;
}

export type ScannedPatchInstruction = ApplyPatchInstructionDetails & { sourceLine: number };

export function scanPatchInstructions(patch: string): ScannedPatchInstruction[] {
  const instructions: ScannedPatchInstruction[] = [];
  let current: ScannedPatchInstruction | undefined;
  let mode: ParserMode["kind"] = "not-started";
  let lines = patch.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const first = lines[0];
  const last = lines.at(-1);
  if ((first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"') && last?.endsWith("EOF")) {
    lines = lines.slice(1, -1);
  }

  for (const [lineIndex, rawLine] of lines.entries()) {
    const line: string = mode === "update" ? rustTrimEnd(rawLine) : rustTrim(rawLine);
    if (mode === "not-started") {
      if (rustTrim(line) === BEGIN_PATCH) mode = "started";
      continue;
    }
    if (mode === "ended") continue;
    if (line === END_PATCH) {
      mode = "ended";
      continue;
    }
    const headers = [
      { prefix: ADD_FILE, kind: "add" as const },
      { prefix: DELETE_FILE, kind: "delete" as const },
      { prefix: UPDATE_FILE, kind: "update" as const },
    ];
    const header: (typeof headers)[number] | undefined = headers.find(({ prefix }) =>
      line.startsWith(prefix),
    );
    if (header) {
      current = {
        index: instructions.length + 1,
        kind: header.kind,
        path: line.slice(header.prefix.length),
        status: "not-run",
        sourceLine: lineIndex + 1,
      };
      instructions.push(current);
      mode = header.kind;
      continue;
    }
    if (mode === "update" && current?.kind === "update" && line.startsWith(MOVE_TO)) {
      current.kind = "move";
      current.moveTo = line.slice(MOVE_TO.length);
    }
  }
  return instructions;
}
