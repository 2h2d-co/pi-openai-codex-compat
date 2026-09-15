import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  APPLY_PATCH_CLI_USAGE,
  runApplyPatchCli,
  type ApplyPatchCliIo,
} from "../extensions/openai-codex-compat/apply-patch-cli.ts";
import type { PatchOperation } from "../extensions/openai-codex-compat/apply-patch-engine.ts";

const BIN_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/pi-apply-patch.ts");

const PATCH = `*** Begin Patch
*** Update File: old/name.txt
*** Move to: renamed/name.txt
@@
-from
+to
*** Delete File: gone.txt
*** Add File: fresh.txt
+hello
*** End Patch
`;

type CapturedIo = ApplyPatchCliIo & { stdout: string[]; stderr: string[] };

function capturedIo(stdin = ""): CapturedIo {
  const io: CapturedIo = {
    stdout: [],
    stderr: [],
    readStdin: () => Promise.resolve(stdin),
    writeStdout: (text) => {
      io.stdout.push(text);
    },
    writeStderr: (text) => {
      io.stderr.push(text);
    },
  };
  return io;
}

type ParsedOutput = { environmentId?: string; operations: PatchOperation[] };

function isParsedOutput(value: unknown): value is ParsedOutput {
  return (
    typeof value === "object" &&
    value !== null &&
    "operations" in value &&
    Array.isArray(value.operations)
  );
}

function parsedOutput(stdout: string): ParsedOutput {
  const value: unknown = JSON.parse(stdout);
  assert.ok(isParsedOutput(value), "stdout is not a parse output document");
  return value;
}

test("parse prints operations from standard input", async () => {
  const io = capturedIo(PATCH);
  assert.equal(await runApplyPatchCli(["parse"], io), 0);
  assert.deepEqual(io.stderr, []);
  const output = parsedOutput(io.stdout.join(""));
  const operations = output.operations;
  assert.deepEqual(
    operations.map((operation) => [
      operation.kind,
      operation.path,
      operation.kind === "update" ? operation.moveTo : undefined,
    ]),
    [
      ["update", "old/name.txt", "renamed/name.txt"],
      ["delete", "gone.txt", undefined],
      ["add", "fresh.txt", undefined],
    ],
  );
  assert.equal(operations[2]?.kind === "add" ? operations[2].content : undefined, "hello\n");
  assert.equal("environmentId" in output, false);
});

test("parse reads a file argument and retains the environment identifier", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-apply-patch-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const patchPath = join(directory, "patch.txt");
  await writeFile(
    patchPath,
    `*** Begin Patch\n*** Environment ID: env-1\n*** Delete File: gone.txt\n*** End Patch\n`,
  );

  const io = capturedIo();
  assert.equal(await runApplyPatchCli(["parse", patchPath], io), 0);
  assert.deepEqual(parsedOutput(io.stdout.join("")), {
    environmentId: "env-1",
    operations: [{ kind: "delete", path: "gone.txt" }],
  });
});

test("parse reports an invalid patch on standard error with exit status 1", async () => {
  const io = capturedIo("not a patch\n");
  assert.equal(await runApplyPatchCli(["parse"], io), 1);
  assert.deepEqual(io.stdout, []);
  assert.match(io.stderr.join(""), /^pi-apply-patch: invalid patch: /);
});

test("usage errors print usage with exit status 2", async () => {
  const missingCommand = capturedIo();
  assert.equal(await runApplyPatchCli([], missingCommand), 2);
  assert.deepEqual(missingCommand.stdout, [APPLY_PATCH_CLI_USAGE]);

  const unknownCommand = capturedIo();
  assert.equal(await runApplyPatchCli(["apply"], unknownCommand), 2);
  assert.deepEqual(unknownCommand.stderr, [APPLY_PATCH_CLI_USAGE]);

  const help = capturedIo();
  assert.equal(await runApplyPatchCli(["--help"], help), 0);
  assert.deepEqual(help.stdout, [APPLY_PATCH_CLI_USAGE]);

  const missingFile = capturedIo();
  assert.equal(await runApplyPatchCli(["parse", "/nonexistent/patch.txt"], missingFile), 2);
  assert.match(missingFile.stderr.join(""), /^pi-apply-patch: cannot read patch: /);
});

test("bin entry runs under node with a piped patch", () => {
  const result = spawnSync(process.execPath, [BIN_PATH, "parse"], {
    input: PATCH,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(parsedOutput(result.stdout).operations.length, 3);
});
