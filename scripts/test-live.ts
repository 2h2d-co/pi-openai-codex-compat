import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Runs the release-gating Codex tests through the repository's Pi dependency. Pi finds its own
// package directory, so an inherited PI_PACKAGE_DIR is removed rather than replaced.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pi = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const env: NodeJS.ProcessEnv = { ...process.env };
delete env["PI_PACKAGE_DIR"];

function runTests(files: string[], testEnv: NodeJS.ProcessEnv): void {
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files], {
    cwd: root,
    env: testEnv,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// The packaged terminal tests run offline first, so a rendering failure stops the gate before
// any billed request.
runTests(["test/settings-cli.test.ts", "test/command-render-cli.test.ts"], env);
const token = execFileSync(
  process.execPath,
  [pi, "auth", "print-bearer-token", "--provider", "openai-codex", "--model", "gpt-5.6-luna"],
  { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
).trim();
runTests(
  [
    "test/codex-host.live.test.ts",
    "test/codex-cli.live.test.ts",
    "test/command-render-cli.test.ts",
  ],
  { ...env, PI_CODEX_LIVE_TEST: "1", PI_CODEX_LIVE_API_KEY: token },
);
