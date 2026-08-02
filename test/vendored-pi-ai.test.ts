import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

void test("vendored pi-ai Responses sources are complete and current", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["scripts/vendor-pi-ai-responses.ts", "--check"],
    { cwd: repositoryRoot },
  );

  assert.match(stdout, /Verified \d+ vendored source files from @earendil-works\/pi-ai@/);
});
