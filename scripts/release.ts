import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;

type PackFile = {
  path: string;
  mode: number;
};

type PackResult = {
  filename: string;
  files: PackFile[];
  name: string;
  version: string;
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageName = "pi-openai-codex-compat";
const packageDirectory = ".";
const packWorkspace: string | undefined = undefined;
const versionWorkspaces: string[] = [];
const releaseMetadataFiles: string[] = ["package-lock.json", "package.json"];
const buildScripts: string[] = [];
const executablePackageFiles: string[] = [];
const forbiddenInstallScripts = ["preinstall", "install", "postinstall"];
const npmExecPath = process.env["npm_execpath"];

if (!npmExecPath) {
  throw new Error("Run this release command through npm so npm_execpath is available.");
}

const version = process.argv[2];
if (!version || process.argv.length !== 3) {
  throw new Error("Usage: npm run release -- <version>");
}
if (!isSemver(version)) {
  throw new Error(`Invalid release version: ${version}`);
}

const expectedPackageFiles = await readExpectedPackageFiles();
const tag = `v${version}`;
await createRelease(version, tag);

async function createRelease(releaseVersion: string, releaseTag: string): Promise<void> {
  requireCleanMain();
  git(["fetch", "--quiet", "--tags", "origin", "main"]);

  const head = gitOutput(["rev-parse", "HEAD"]);
  const originMain = gitOutput(["rev-parse", "origin/main"]);
  if (head !== originMain) {
    throw new Error(`HEAD ${head} does not match origin/main ${originMain}.`);
  }
  if (gitSucceeds(["rev-parse", "--verify", "--quiet", `refs/tags/${releaseTag}`])) {
    throw new Error(`Release tag ${releaseTag} already exists.`);
  }

  npm(["version", releaseVersion, "--no-git-tag-version", "--ignore-scripts"], root);
  for (const workspace of versionWorkspaces) {
    npm(
      [
        "version",
        releaseVersion,
        "--workspace",
        workspace,
        "--no-git-tag-version",
        "--ignore-scripts",
      ],
      root,
    );
  }
  git(["add", ...releaseMetadataFiles]);
  assertStagedReleaseFiles();

  const localDigest = await buildPackageFromIndex(releaseVersion);
  git([
    "commit",
    "-S",
    "-m",
    `release: ${releaseTag}`,
    "-m",
    `Npm-Artifact-SHA256: ${localDigest}`,
  ]);

  const releaseCommit = gitOutput(["rev-parse", "HEAD"]);
  verifyReleaseCommit(releaseCommit, releaseTag, localDigest);

  const committedDigest = await buildPackageFromIndex(releaseVersion);
  if (committedDigest !== localDigest) {
    throw new Error(
      `Release package is not reproducible: staged tree produced ${localDigest}, committed tree produced ${committedDigest}.`,
    );
  }

  git(["tag", releaseTag]);
  if (gitOutput(["cat-file", "-t", `refs/tags/${releaseTag}`]) !== "commit") {
    throw new Error(`Release tag ${releaseTag} is not lightweight.`);
  }
  if (gitOutput(["rev-parse", `refs/tags/${releaseTag}^{commit}`]) !== releaseCommit) {
    throw new Error(`Release tag ${releaseTag} does not point to ${releaseCommit}.`);
  }

  console.log(`Created signed release commit ${releaseCommit}.`);
  console.log(`Created lightweight tag ${releaseTag}.`);
  console.log(`Locally attested npm package SHA-256: ${localDigest}`);
  console.log(`Push with: git push --atomic origin main ${releaseTag}`);
}

function requireCleanMain(): void {
  if (gitOutput(["branch", "--show-current"]) !== "main") {
    throw new Error("Releases must be created from main.");
  }
  if (gitOutput(["status", "--porcelain"]) !== "") {
    throw new Error("Releases require a clean worktree and index.");
  }
}

function assertStagedReleaseFiles(): void {
  const files = gitOutput(["diff", "--cached", "--name-only"]).split("\n").filter(Boolean).sort();
  const expected = [...releaseMetadataFiles].sort();
  if (JSON.stringify(files) !== JSON.stringify(expected)) {
    throw new Error(`Release metadata changed unexpected files: ${files.join(", ")}`);
  }
}

async function buildPackageFromIndex(releaseVersion: string): Promise<string> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-openai-codex-compat-release-"));
  const source = join(temporaryRoot, "source");
  const output = join(temporaryRoot, "package");
  await mkdir(source);
  await mkdir(output);

  try {
    git(["checkout-index", "--all", "--force", `--prefix=${source}/`]);
    npm(["ci", "--ignore-scripts"], source);
    for (const buildScript of buildScripts) {
      npm(["run", buildScript], source);
    }

    const packArgs = [
      "pack",
      "--json",
      "--ignore-scripts",
      "--allow-directory=all",
      "--pack-destination",
      output,
    ];
    if (packWorkspace) {
      packArgs.push("--workspace", packWorkspace);
    }
    const result = parsePackResult(npmOutput(packArgs, source));
    await validatePackage(source, result, releaseVersion);

    const archive = join(output, result.filename);
    const contents = await readFile(archive);
    return createHash("sha256").update(contents).digest("hex");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function validatePackage(
  source: string,
  result: PackResult,
  releaseVersion: string,
): Promise<void> {
  if (result.name !== packageName || result.version !== releaseVersion) {
    throw new Error(`Unexpected package identity ${result.name}@${result.version}.`);
  }

  const actualFiles = result.files.map((file) => file.path).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedPackageFiles)) {
    throw new Error(
      `Unexpected npm package files:\nexpected ${expectedPackageFiles.join(", ")}\nactual ${actualFiles.join(", ")}`,
    );
  }

  for (const executablePath of executablePackageFiles) {
    const executable = result.files.find((file) => file.path === executablePath);
    if (!executable || (executable.mode & 0o111) === 0) {
      throw new Error(`${executablePath} is not executable in the npm package.`);
    }
  }

  const manifestPath = join(source, packageDirectory, "package.json");
  const manifest = parseJsonRecord(await readFile(manifestPath, "utf8"));
  const scripts = isJsonRecord(manifest["scripts"]) ? manifest["scripts"] : {};
  const forbidden = forbiddenInstallScripts.filter((script) => typeof scripts[script] === "string");
  if (forbidden.length > 0) {
    throw new Error(`Install lifecycle scripts are forbidden: ${forbidden.join(", ")}`);
  }

  const bundled = manifest["bundledDependencies"] ?? manifest["bundleDependencies"];
  if (bundled === true || (Array.isArray(bundled) && bundled.length > 0)) {
    throw new Error("Bundled npm dependencies are forbidden.");
  }
}

async function readExpectedPackageFiles(): Promise<string[]> {
  const manifestPath = join(root, ".github", "npm-package-files");
  const contents = await readFile(manifestPath, "utf8");
  const files = contents.split(/\r?\n/).filter(Boolean).sort();
  if (
    files.length === 0 ||
    files.some((file) => file.trim() !== file || file.startsWith("/") || file.includes("..")) ||
    new Set(files).size !== files.length
  ) {
    throw new Error(`${manifestPath} contains invalid package paths.`);
  }
  return files;
}

function parsePackResult(output: string): PackResult {
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isJsonRecord(parsed[0])) {
    throw new Error("npm pack did not report exactly one package.");
  }
  const result = parsed[0];
  if (
    typeof result["filename"] !== "string" ||
    typeof result["name"] !== "string" ||
    typeof result["version"] !== "string" ||
    !Array.isArray(result["files"])
  ) {
    throw new Error("npm pack returned invalid package metadata.");
  }
  const files = result["files"].map((value) => {
    if (
      !isJsonRecord(value) ||
      typeof value["path"] !== "string" ||
      typeof value["mode"] !== "number"
    ) {
      throw new Error("npm pack returned invalid file metadata.");
    }
    return { path: value["path"], mode: value["mode"] };
  });
  return {
    filename: result["filename"],
    files,
    name: result["name"],
    version: result["version"],
  };
}

function verifyReleaseCommit(commit: string, releaseTag: string, digest: string): void {
  git([
    "-c",
    "gpg.format=ssh",
    "-c",
    `gpg.ssh.allowedSignersFile=${join(root, ".github", "release-signers")}`,
    "verify-commit",
    commit,
  ]);
  if (gitOutput(["log", "-1", "--pretty=%s", commit]) !== `release: ${releaseTag}`) {
    throw new Error("Release commit subject is invalid.");
  }
  const trailer = gitOutput([
    "log",
    "-1",
    "--format=%(trailers:key=Npm-Artifact-SHA256,valueonly)",
    commit,
  ]);
  if (trailer !== digest) {
    throw new Error(`Release commit artifact digest ${trailer} does not match ${digest}.`);
  }
}

function npm(args: string[], cwd: string): void {
  run(process.execPath, [npmExecPath!, ...args], cwd, false);
}

function npmOutput(args: string[], cwd: string): string {
  return run(process.execPath, [npmExecPath!, ...args], cwd, true);
}

function git(args: string[]): void {
  run("git", args, root, false);
}

function gitOutput(args: string[]): string {
  return run("git", args, root, true);
}

function gitSucceeds(args: string[]): boolean {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: "ignore",
  });
  if (result.error) {
    throw result.error;
  }
  return result.status === 0;
}

function run(command: string, args: string[], cwd: string, capture: boolean): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? "no status"}.`);
  }
  return capture ? result.stdout.trim() : "";
}

function parseJsonRecord(value: string): JsonRecord {
  const parsed: unknown = JSON.parse(value);
  if (!isJsonRecord(parsed)) {
    throw new Error("Expected a JSON object.");
  }
  return parsed;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSemver(value: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
    value,
  );
}
