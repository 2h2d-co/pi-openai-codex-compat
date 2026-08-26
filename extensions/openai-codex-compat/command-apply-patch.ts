import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import Parser, { Query } from "tree-sitter";
import Bash from "tree-sitter-bash";
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

type ApplyPatchInvocation =
  | { kind: "not-apply-patch" }
  | { kind: "implicit-patch" }
  | { kind: "apply-patch"; patch: string; workdir?: string };

export type InterceptedApplyPatchResult = {
  content: Array<{ type: "text"; text: string }>;
  details: CommandOutputDetails;
};

type ApplyPatchShell = "unix" | "powershell" | "cmd";

const APPLY_PATCH_QUERY = new Query(
  Bash,
  String.raw`
    (
      program
        . (redirected_statement
            body: (command
                    name: (command_name (word) @apply_name) .)
            (#any-of? @apply_name "apply_patch" "applypatch")
            redirect: (heredoc_redirect
                        . (heredoc_start)
                        . (heredoc_body) @heredoc
                        . (heredoc_end)
                        .))
        .)

    (
      program
        . (redirected_statement
            body: (list
                    . (command
                        name: (command_name (word) @cd_name) .
                        argument: [
                          (word) @cd_path
                          (string (string_content) @cd_path)
                          (raw_string) @cd_raw_string
                        ] .)
                    "&&"
                    . (command
                        name: (command_name (word) @apply_name))
                    .)
            (#eq? @cd_name "cd")
            (#any-of? @apply_name "apply_patch" "applypatch")
            redirect: (heredoc_redirect
                        . (heredoc_start)
                        . (heredoc_body) @heredoc
                        . (heredoc_end)
                        .))
        .)
  `,
);

function isWindowsPath(path: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/u.test(path) ||
    /^file:\/\/\/[A-Za-z]:\//u.test(path) ||
    path.startsWith("\\\\")
  );
}

function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/gu, (character) => String.fromCharCode(character.charCodeAt(0) + 32));
}

function classifyShellName(shell: string, cwd: string): string | undefined {
  const separator = isWindowsPath(cwd) ? /[\\/]/u : /\//u;
  const basename = shell.split(separator).at(-1);
  if (!basename) return undefined;
  const dot = basename.lastIndexOf(".");
  const stem = dot > 0 ? basename.slice(0, dot) : basename;
  return asciiLowercase(stem);
}

function classifyShell(shell: string, flag: string, cwd: string): ApplyPatchShell | undefined {
  const name = classifyShellName(shell, cwd);
  if ((name === "bash" || name === "zsh" || name === "sh") && (flag === "-lc" || flag === "-c")) {
    return "unix";
  }
  if ((name === "pwsh" || name === "powershell") && asciiLowercase(flag) === "-command") {
    return "powershell";
  }
  if (name === "cmd" && asciiLowercase(flag) === "/c") return "cmd";
  return undefined;
}

function canSkipFlag(shell: string, flag: string, cwd: string): boolean {
  const name = classifyShellName(shell, cwd);
  return (name === "pwsh" || name === "powershell") && asciiLowercase(flag) === "-noprofile";
}

function parseShellScript(
  argv: readonly string[],
  cwd: string,
): { shell: ApplyPatchShell; script: string } | undefined {
  if (argv.length === 3) {
    const [shell, flag, script] = argv;
    if (shell === undefined || flag === undefined || script === undefined) return undefined;
    const shellType = classifyShell(shell, flag, cwd);
    return shellType === undefined ? undefined : { shell: shellType, script };
  }
  if (argv.length === 4) {
    const [shell, skipFlag, flag, script] = argv;
    if (
      shell === undefined ||
      skipFlag === undefined ||
      flag === undefined ||
      script === undefined ||
      !canSkipFlag(shell, skipFlag, cwd)
    ) {
      return undefined;
    }
    const shellType = classifyShell(shell, flag, cwd);
    return shellType === undefined ? undefined : { shell: shellType, script };
  }
  return undefined;
}

function isPatchDocument(body: string): boolean {
  try {
    parsePatchDocument(body);
    return true;
  } catch (error) {
    void error;
    return false;
  }
}

function trimTrailingNewlines(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "\n") end--;
  return value.slice(0, end);
}

function extractApplyPatchFromBash(script: string): ApplyPatchInvocation {
  const parser = new Parser();
  parser.setLanguage(Bash);
  const tree = parser.parse(script);
  for (const match of APPLY_PATCH_QUERY.matches(tree.rootNode)) {
    let patch: string | undefined;
    let workdir: string | undefined;
    for (const capture of match.captures) {
      if (capture.name === "heredoc") {
        patch = trimTrailingNewlines(capture.node.text);
      } else if (capture.name === "cd_path") {
        workdir = capture.node.text;
      } else if (capture.name === "cd_raw_string") {
        const raw = capture.node.text;
        workdir = raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : raw;
      }
    }
    if (patch !== undefined) {
      return {
        kind: "apply-patch",
        patch,
        ...(workdir === undefined ? {} : { workdir }),
      };
    }
  }
  return { kind: "not-apply-patch" };
}

export function parseShellApplyPatchInvocation(
  argv: readonly string[],
  cwd: string,
): ApplyPatchInvocation {
  if (argv.length === 1) {
    const body = argv[0];
    return body !== undefined && isPatchDocument(body)
      ? { kind: "implicit-patch" }
      : { kind: "not-apply-patch" };
  }
  if (argv.length === 2) {
    const [command, body] = argv;
    return command !== undefined && body !== undefined && APPLY_PATCH_COMMANDS.has(command)
      ? { kind: "apply-patch", patch: body }
      : { kind: "not-apply-patch" };
  }

  const shellScript = parseShellScript(argv, cwd);
  if (!shellScript) return { kind: "not-apply-patch" };
  if (isPatchDocument(shellScript.script)) return { kind: "implicit-patch" };
  return extractApplyPatchFromBash(shellScript.script);
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
  argv: readonly string[],
  cwd: string,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<CommandOutputDetails> | undefined,
): Promise<InterceptedApplyPatchResult | undefined> {
  const invocation = parseShellApplyPatchInvocation(argv, cwd);
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
