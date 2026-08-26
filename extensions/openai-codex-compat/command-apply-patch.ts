import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import {
  applyPatch,
  ApplyPatchExecutionError,
  ApplyPatchInputError,
  ApplyPatchVerificationError,
  formatApplyPatchFailureSummary,
  formatApplyPatchModelOutput,
  formatApplyPatchSummary,
  parsePatchDocument,
} from "./apply-patch-engine.ts";
import type { CommandOutputDetails } from "./command-output.ts";

const APPLY_PATCH_COMMANDS = new Set(["apply_patch", "applypatch"]);
const IMPLICIT_PATCH_ERROR =
  'apply_patch verification failed: patch detected without explicit call to apply_patch. Rerun as ["apply_patch", "<patch>"]';

// Adapted from OpenAI Codex's Apache-2.0 apply_patch invocation recognizer.
// Keep this conservative: only a sole top-level heredoc command is intercepted.
type ApplyPatchInvocation =
  | { kind: "not-apply-patch" }
  | { kind: "implicit-patch" }
  | { kind: "apply-patch"; patch: string; workdir?: string };

export type InterceptedApplyPatchResult = {
  content: Array<{ type: "text"; text: string }>;
  details: CommandOutputDetails;
};

function unquote(value: string): string {
  const first = value[0];
  return (first === "'" || first === '"') && value.at(-1) === first ? value.slice(1, -1) : value;
}

function supportsApplyPatchInterception(shell: string): boolean {
  const basename = shell.split(/[\\/]/u).at(-1)?.toLowerCase();
  const name = basename?.endsWith(".exe") ? basename.slice(0, -4) : basename;
  return (
    name === "bash" ||
    name === "zsh" ||
    name === "sh" ||
    name === "powershell" ||
    name === "pwsh" ||
    name === "cmd"
  );
}

function parseInvocationHeader(
  header: string,
): { command: string; delimiter: string; workdir?: string } | undefined {
  const match =
    /^[ \t]*(?:cd[ \t]+(?<workdir>'[^']*'|"[^"\\$`]*"|[^\s"';&|<>()\\]+)[ \t]*&&[ \t]*)?(?<command>apply_patch|applypatch)[ \t]*<<[ \t]*(?<delimiter>'[^'\r\n]+'|"[^"\r\n]+"|[A-Za-z0-9_]+)[ \t]*$/u.exec(
      header,
    );
  const command = match?.groups?.["command"];
  const delimiter = match?.groups?.["delimiter"];
  if (!command || !delimiter || !APPLY_PATCH_COMMANDS.has(command)) return undefined;
  const workdir = match.groups?.["workdir"];
  return {
    command,
    delimiter: unquote(delimiter),
    ...(workdir === undefined ? {} : { workdir: unquote(workdir) }),
  };
}

export function parseShellApplyPatchInvocation(script: string): ApplyPatchInvocation {
  try {
    parsePatchDocument(script);
    return { kind: "implicit-patch" };
  } catch (error) {
    void error;
  }

  const lines = script.replaceAll("\r\n", "\n").split("\n");
  while (lines[0]?.trim() === "") lines.shift();
  const header = lines[0];
  if (header === undefined) return { kind: "not-apply-patch" };
  const parsedHeader = parseInvocationHeader(header);
  if (!parsedHeader) return { kind: "not-apply-patch" };

  const delimiterIndex = lines.findIndex(
    (line, index) => index > 0 && line === parsedHeader.delimiter,
  );
  if (delimiterIndex === -1) return { kind: "not-apply-patch" };
  if (lines.slice(delimiterIndex + 1).some((line) => line.trim() !== "")) {
    return { kind: "not-apply-patch" };
  }
  return {
    kind: "apply-patch",
    patch: lines.slice(1, delimiterIndex).join("\n"),
    ...(parsedHeader.workdir === undefined ? {} : { workdir: parsedHeader.workdir }),
  };
}

function executionDuration(executionStartedAt: number | undefined): number {
  if (executionStartedAt === undefined) {
    throw new Error("apply_patch execution timing was not initialized.");
  }
  return performance.now() - executionStartedAt;
}

function applyPatchError(
  error: unknown,
  cwd: string,
  executionStartedAt: number | undefined,
): Error {
  if (error instanceof ApplyPatchExecutionError) {
    return new Error(
      formatApplyPatchModelOutput(
        1,
        executionDuration(executionStartedAt),
        formatApplyPatchFailureSummary(error.details, cwd),
      ),
      { cause: error },
    );
  }
  if (error instanceof ApplyPatchVerificationError) {
    return new Error(formatApplyPatchFailureSummary(error.details, cwd), { cause: error });
  }
  if (error instanceof ApplyPatchInputError && error.details) {
    return new Error(formatApplyPatchFailureSummary(error.details, cwd), { cause: error });
  }
  return error instanceof Error ? error : new Error(String(error));
}

export async function interceptShellApplyPatch(
  script: string,
  cwd: string,
  shell: string,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<CommandOutputDetails> | undefined,
): Promise<InterceptedApplyPatchResult | undefined> {
  if (!supportsApplyPatchInterception(shell)) return undefined;
  const invocation = parseShellApplyPatchInvocation(script);
  if (invocation.kind === "not-apply-patch") return undefined;
  if (invocation.kind === "implicit-patch") throw new Error(IMPLICIT_PATCH_ERROR);

  const effectiveCwd = invocation.workdir === undefined ? cwd : resolve(cwd, invocation.workdir);
  let executionStartedAt: number | undefined;
  try {
    const details = await applyPatch(effectiveCwd, invocation.patch, signal, {
      onExecutionStart() {
        executionStartedAt = performance.now();
      },
      onProgress() {
        onUpdate?.({ content: [{ type: "text", text: "" }], details: {} });
      },
    });
    return {
      content: [
        {
          type: "text",
          text: formatApplyPatchModelOutput(
            0,
            executionDuration(executionStartedAt),
            formatApplyPatchSummary(details, effectiveCwd),
          ),
        },
      ],
      details: {},
    };
  } catch (error) {
    throw applyPatchError(error, effectiveCwd, executionStartedAt);
  }
}
