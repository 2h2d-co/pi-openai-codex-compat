import assert from "node:assert/strict";
import childProcess, { type SpawnSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const releaseScript = join(root, "scripts/release.ts");
const liveCommand = "mise run test:live:codex";
const version = "0.0.14"; // Has a CHANGELOG.md section; every Git and npm call is mocked.
const candidate = "synthetic release archive";
const digest = createHash("sha256").update(candidate).digest("hex");
const packageFiles = readFileSync(join(root, ".github/npm-package-files"), "utf8")
  .trim()
  .split("\n")
  .map((path) => ({ path, mode: 0o644 }));

type Scenario = {
  version?: string;
  branch?: string;
  status?: string;
  originMain?: string;
  tagExists?: boolean;
  /** Exit status or spawn error for the live validation child. */
  live?: number | Error;
  /** Exit status for `npm ci` in the isolated source checkout. */
  npmCi?: number;
  /** Exit status for the signed `git commit`. */
  commit?: number;
  /** Digest reported for the post-commit rebuild; defaults to the staged digest. */
  rebuildContents?: string;
};

type Observed = {
  calls: string[];
  archives: string[];
  liveRuns: Array<{ cwd: unknown; archive: unknown; archiveContents: string | undefined }>;
  logs: string[];
  committed: boolean;
  tagged: boolean;
};

/**
 * Run the real release script with every child process intercepted. No Git,
 * npm, Mise, or provider call occurs; the archive the mocked `npm pack` writes
 * is the only filesystem effect, inside the script's own temporary directory.
 */
async function runRelease(
  t: TestContext,
  scenario: Scenario,
): Promise<{ observed: Observed; failure: unknown }> {
  const observed: Observed = {
    calls: [],
    archives: [],
    liveRuns: [],
    logs: [],
    committed: false,
    tagged: false,
  };
  const releaseVersion = scenario.version ?? version;
  const releaseTag = `v${releaseVersion}`;
  const previousArgv = process.argv;
  const previousNpm = process.env["npm_execpath"];
  process.argv = [process.execPath, releaseScript, releaseVersion];
  process.env["npm_execpath"] = "synthetic-npm";
  let packCount = 0;
  const mocked = t.mock.method(
    childProcess,
    "spawnSync",
    (command: string, args: string[] = [], options: SpawnSyncOptions = {}) => {
      const operation = [command === process.execPath ? "npm" : command, ...args].join(" ");
      observed.calls.push(operation);
      let stdout = "";
      let status: number | null = 0;
      let error: Error | undefined;
      if (command === "git") {
        assert.equal(options.cwd, root, `${operation} runs in the repository root`);
        const verb = args[0];
        if (verb === "branch") stdout = scenario.branch ?? "main";
        else if (verb === "status") stdout = scenario.status ?? "";
        else if (verb === "fetch" || verb === "add" || verb === "checkout-index") stdout = "";
        else if (verb === "rev-parse" && args.includes("--verify")) {
          status = scenario.tagExists ? 0 : 1;
        } else if (verb === "rev-parse" && args.includes("origin/main")) {
          stdout = scenario.originMain ?? "initial-commit";
        } else if (verb === "rev-parse") {
          stdout = observed.committed ? "release-commit" : "initial-commit";
        } else if (verb === "diff") stdout = "package-lock.json\npackage.json";
        else if (verb === "commit") {
          assert.deepEqual(args.slice(0, 4), ["commit", "-S", "-m", `release: ${releaseTag}`]);
          status = scenario.commit ?? 0;
          observed.committed = status === 0;
        } else if (verb === "-c") assert.equal(args.at(-2), "verify-commit");
        else if (verb === "tag") observed.tagged = true;
        else if (verb === "cat-file") stdout = "commit";
        else if (verb === "log") {
          stdout = args.includes("--pretty=%s") ? `release: ${releaseTag}` : digest;
        } else throw new Error(`Unexpected Git command: ${operation}`);
      } else if (command === process.execPath) {
        assert.equal(args[0], "synthetic-npm");
        assert.equal(typeof options.cwd, "string");
        const cwd = String(options.cwd);
        const verb = args[1];
        if (verb === "version") {
          assert.equal(cwd, root);
          assert.equal(args[2], releaseVersion);
        } else if (verb === "ci") {
          assert.notEqual(cwd, root, "npm ci runs in the isolated checkout");
          status = scenario.npmCi ?? 0;
          if (status === 0) {
            writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: {} }));
          }
        } else if (verb === "pack") {
          assert.notEqual(cwd, root, "npm pack runs in the isolated checkout");
          const output = args[args.indexOf("--pack-destination") + 1];
          assert.ok(output);
          const filename = `pi-openai-codex-compat-${releaseVersion}.tgz`;
          const archive = join(output, filename);
          packCount += 1;
          writeFileSync(
            archive,
            packCount === 2 ? (scenario.rebuildContents ?? candidate) : candidate,
          );
          observed.archives.push(archive);
          stdout = JSON.stringify([
            {
              name: "pi-openai-codex-compat",
              version: releaseVersion,
              filename,
              files: packageFiles,
            },
          ]);
        } else throw new Error(`Unexpected npm command: ${operation}`);
      } else if (command === "mise") {
        assert.equal(operation, liveCommand);
        const archive = options.env?.["PI_CODEX_PACKAGE_ARCHIVE"];
        observed.liveRuns.push({
          cwd: options.cwd,
          archive,
          archiveContents:
            typeof archive === "string" && existsSync(archive)
              ? readFileSync(archive, "utf8")
              : undefined,
        });
        if (scenario.live instanceof Error) {
          error = scenario.live;
          status = null;
        } else {
          status = scenario.live ?? 0;
        }
      } else throw new Error(`Unexpected child command: ${operation}`);
      return {
        pid: 0,
        output: [null, stdout, ""],
        stdout,
        stderr: "",
        status,
        signal: null,
        error,
      };
    },
  );
  syncBuiltinESMExports();
  const log = t.mock.method(console, "log", (...values: unknown[]) => {
    observed.logs.push(values.map(String).join(" "));
  });
  t.after(() => {
    log.mock.restore();
    mocked.mock.restore();
    syncBuiltinESMExports();
    process.argv = previousArgv;
    if (previousNpm === undefined) delete process.env["npm_execpath"];
    else process.env["npm_execpath"] = previousNpm;
  });
  // Each import evaluates the script's top-level release flow once.
  const script = new URL(
    `../scripts/release.ts?scenario=${t.name.replace(/\W+/g, "-")}`,
    import.meta.url,
  );
  let failure: unknown;
  try {
    await import(script.href);
  } catch (error) {
    failure = error;
  }
  return { observed, failure };
}

function assertFailure(failure: unknown, expected: RegExp): void {
  assert.ok(failure instanceof Error, "the release script failed");
  assert.match(failure.message, expected);
}

function assertCleanTemporaries(observed: Observed): void {
  assert.ok(
    observed.archives.every((archive) => !existsSync(archive)),
    "temporary candidates are cleaned up",
  );
}

test("release validates the exact archive live once before signing and tagging", async (t) => {
  const { observed, failure } = await runRelease(t, {});
  assert.equal(failure, undefined);
  assert.equal(observed.liveRuns.length, 1);
  assert.equal(observed.liveRuns[0]?.cwd, root);
  assert.equal(observed.liveRuns[0]?.archive, observed.archives[0]);
  assert.equal(observed.liveRuns[0]?.archiveContents, candidate);
  assert.equal(observed.committed, true);
  assert.equal(observed.tagged, true);
  assert.ok(observed.calls.includes(`git tag v${version}`));
  // The staged tree is validated live, signed, then rebuilt from the commit
  // without repeating live validation.
  assert.equal(observed.archives.length, 2);
  const liveIndex = observed.calls.indexOf(liveCommand);
  const commitIndex = observed.calls.findIndex((call) => call.startsWith("git commit "));
  const rebuildIndex = observed.calls.findLastIndex((call) =>
    call.startsWith("git checkout-index "),
  );
  const tagIndex = observed.calls.indexOf(`git tag v${version}`);
  assert.ok(liveIndex < commitIndex && commitIndex < rebuildIndex && rebuildIndex < tagIndex);
  assert.deepEqual(observed.logs, [
    "Created signed release commit release-commit.",
    `Created lightweight tag v${version}.`,
    `Locally attested npm package SHA-256: ${digest}`,
    `Push with: git push --atomic origin main v${version}`,
  ]);
  assertCleanTemporaries(observed);
});

test("release stops before signing when live validation exits nonzero", async (t) => {
  const { observed, failure } = await runRelease(t, { live: 1 });
  assertFailure(failure, /mise run test:live:codex exited with 1/);
  assert.equal(observed.liveRuns.length, 1);
  assert.equal(observed.liveRuns[0]?.archiveContents, candidate);
  assert.equal(observed.committed, false);
  assert.equal(observed.tagged, false);
  assert.equal(observed.archives.length, 1);
  assertCleanTemporaries(observed);
});

test("release stops before signing when the live process cannot start", async (t) => {
  const spawnError = Object.assign(new Error("spawn mise ENOENT"), { code: "ENOENT" });
  const { observed, failure } = await runRelease(t, { live: spawnError });
  assert.equal(failure, spawnError);
  assert.equal(observed.liveRuns.length, 1);
  assert.equal(observed.committed, false);
  assert.equal(observed.tagged, false);
  assertCleanTemporaries(observed);
});

for (const [description, scenario, expected] of [
  ["a dirty worktree", { status: " M README.md" }, /clean worktree and index/],
  ["a branch other than main", { branch: "feature" }, /created from main/],
  ["a missing changelog section", { version: "9.9.9" }, /no 9\.9\.9 section/],
  ["HEAD behind origin/main", { originMain: "newer-commit" }, /does not match origin\/main/],
  ["an existing release tag", { tagExists: true }, /already exists/],
] as const) {
  test(`release refuses ${description} before changing anything`, async (t) => {
    const { observed, failure } = await runRelease(t, scenario);
    assertFailure(failure, expected);
    // No version bump, build, live validation, commit, or tag happened.
    assert.equal(
      observed.calls.some((call) => call.startsWith("npm ")),
      false,
    );
    assert.deepEqual(observed.liveRuns, []);
    assert.deepEqual(observed.archives, []);
    assert.equal(observed.committed, false);
    assert.equal(observed.tagged, false);
  });
}

test("release stops when the isolated dependency install exits nonzero", async (t) => {
  const { observed, failure } = await runRelease(t, { npmCi: 1 });
  assertFailure(failure, /npm ci --ignore-scripts exited with 1/);
  assert.deepEqual(observed.liveRuns, []);
  assert.equal(observed.committed, false);
  assert.equal(observed.tagged, false);
  assertCleanTemporaries(observed);
});

test("release creates no tag when the signed commit fails", async (t) => {
  const { observed, failure } = await runRelease(t, { commit: 1 });
  assertFailure(failure, /^git commit -S .* exited with 1\.$/);
  assert.equal(observed.liveRuns.length, 1);
  assert.equal(observed.committed, false);
  assert.equal(observed.tagged, false);
  assert.equal(observed.archives.length, 1);
  assertCleanTemporaries(observed);
});

test("release keeps the commit but creates no tag when the rebuild is not reproducible", async (t) => {
  const { observed, failure } = await runRelease(t, {
    rebuildContents: "different archive bytes",
  });
  assertFailure(failure, /not reproducible/);
  assert.equal(observed.liveRuns.length, 1);
  assert.equal(observed.committed, true);
  assert.equal(observed.tagged, false);
  assert.equal(observed.archives.length, 2);
  assertCleanTemporaries(observed);
});
