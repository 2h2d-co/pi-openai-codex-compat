import { readFile } from "node:fs/promises";
import type { ParsedPatch } from "./apply-patch-engine.ts";
import { ApplyPatchParseError, parsePatchDocument } from "./apply-patch-engine.ts";
import { errorMessage } from "./apply-patch-engine/apply-patch-engine-errors.ts";

export const APPLY_PATCH_CLI_NAME = "pi-apply-patch";

export const APPLY_PATCH_CLI_USAGE = `Usage: ${APPLY_PATCH_CLI_NAME} parse [<file>]

Parse a Codex apply_patch document and print its operations as JSON.
Reads <file>, or standard input when <file> is omitted or "-".

Exit status: 0 parsed, 1 invalid patch, 2 usage error.
`;

export type ApplyPatchCliIo = {
  readStdin: () => Promise<string>;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
};

export type ApplyPatchCliParseOutput = Pick<ParsedPatch, "operations" | "environmentId">;

export function applyPatchCliParseOutput(parsed: ParsedPatch): ApplyPatchCliParseOutput {
  return parsed.environmentId === undefined
    ? { operations: parsed.operations }
    : { environmentId: parsed.environmentId, operations: parsed.operations };
}

export async function runApplyPatchCli(
  argv: readonly string[],
  io: ApplyPatchCliIo,
): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    io.writeStdout(APPLY_PATCH_CLI_USAGE);
    return command === undefined ? 2 : 0;
  }
  if (command !== "parse" || rest.length > 1) {
    io.writeStderr(APPLY_PATCH_CLI_USAGE);
    return 2;
  }

  const source = rest[0];
  let patch: string;
  try {
    patch =
      source === undefined || source === "-"
        ? await io.readStdin()
        : await readFile(source, "utf8");
  } catch (error) {
    io.writeStderr(`${APPLY_PATCH_CLI_NAME}: cannot read patch: ${errorMessage(error)}\n`);
    return 2;
  }

  try {
    const output = applyPatchCliParseOutput(parsePatchDocument(patch));
    io.writeStdout(`${JSON.stringify(output, null, 2)}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof ApplyPatchParseError)) throw error;
    io.writeStderr(`${APPLY_PATCH_CLI_NAME}: ${error.message}\n`);
    return 1;
  }
}
