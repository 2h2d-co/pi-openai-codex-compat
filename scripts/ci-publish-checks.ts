import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

type PackageJson = {
  name: string;
  version: string;
};

const packageJsonPath = resolve(process.cwd(), "package.json");
const parsedPackage: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
if (!isPackageJson(parsedPackage)) {
  throw new Error(`Missing or invalid package name/version in ${packageJsonPath}`);
}
const packageName = parsedPackage.name;
const version = parsedPackage.version;

if (process.argv.length > 2) {
  throw new Error("ci-publish-checks.ts does not accept arguments.");
}

assertCiReleaseGitState(version);
const npmTag = deriveNpmTag(version);
writeGithubOutput("npm_tag", npmTag);

console.log(`Validated CI release for ${packageName}@${version} with npm dist-tag "${npmTag}".`);

function assertCiReleaseGitState(version: string): void {
  const releaseTag = `v${version}`;
  const releaseTagRef = `refs/tags/${releaseTag}`;
  const eventName = getRequiredEnv("GITHUB_EVENT_NAME");
  const ref = getRequiredEnv("GITHUB_REF");
  const sha = getRequiredEnv("GITHUB_SHA");

  if (getRequiredEnv("GITHUB_ACTIONS") !== "true") {
    throw new Error("Refusing release because GITHUB_ACTIONS is not true.");
  }
  if (eventName !== "push") {
    throw new Error(`Refusing release for event "${eventName}".`);
  }
  if (ref !== releaseTagRef) {
    throw new Error(
      `Refusing release from ref "${ref}"; expected "${releaseTagRef}" for package version "${version}".`,
    );
  }

  const insideWorkTree = runGit(["rev-parse", "--is-inside-work-tree"]);
  if (insideWorkTree !== "true") {
    throw new Error("Refusing release outside of a Git work tree.");
  }

  if (!gitSucceeds(["rev-parse", "--verify", "--quiet", `${releaseTagRef}^{commit}`])) {
    throw new Error(`Refusing release because tag "${releaseTag}" does not exist.`);
  }

  const tagCommit = runGit(["rev-parse", `${releaseTagRef}^{commit}`]);
  const head = runGit(["rev-parse", "HEAD"]);
  if (tagCommit !== head) {
    throw new Error(`Refusing release because tag "${releaseTag}" does not point at HEAD.`);
  }

  const eventCommit = runGit(["rev-parse", `${sha}^{commit}`]);
  if (eventCommit !== tagCommit) {
    throw new Error(`Refusing release because GITHUB_SHA does not match tag "${releaseTag}".`);
  }

  const subject = runGit(["log", "-1", "--pretty=%s", tagCommit]);
  const expectedSubject = `release: ${releaseTag}`;
  if (subject !== expectedSubject) {
    throw new Error(
      `Refusing release because tag "${releaseTag}" points to commit with subject "${subject}", not "${expectedSubject}".`,
    );
  }

  if (!gitSucceeds(["merge-base", "--is-ancestor", tagCommit, "origin/main"])) {
    throw new Error(
      `Refusing release because tag "${releaseTag}" does not point to a commit on origin/main.`,
    );
  }
}

function deriveNpmTag(version: string): string {
  const prerelease = version.match(/-([0-9A-Za-z.-]+)$/)?.[1];
  if (!prerelease) {
    return "latest";
  }

  const firstIdentifier = prerelease.split(".")[0]?.toLowerCase();
  if (!firstIdentifier) {
    throw new Error(`Could not derive npm dist-tag from version "${version}"`);
  }

  if (/^\d+$/.test(firstIdentifier)) {
    throw new Error(
      `Version "${version}" has a numeric prerelease identifier. Use a named prerelease like alpha, beta, rc, or publish manually.`,
    );
  }

  if (!/^[a-z][a-z0-9-]*$/.test(firstIdentifier)) {
    throw new Error(
      `Derived npm dist-tag "${firstIdentifier}" from version "${version}" is invalid. Use a prerelease like alpha.0, beta.1, or rc.2.`,
    );
  }

  if (firstIdentifier === "latest") {
    throw new Error(
      `Refusing prerelease version "${version}" because it derives the reserved "latest" npm dist-tag.`,
    );
  }

  return firstIdentifier;
}

function isPackageJson(value: unknown): value is PackageJson {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  if (!("version" in value) || typeof value.version !== "string" || value.version.length === 0) {
    return false;
  }

  return "name" in value && typeof value.name === "string" && value.name.length > 0;
}

function writeGithubOutput(name: string, value: string): void {
  const outputPath = getRequiredEnv("GITHUB_OUTPUT");
  appendFileSync(outputPath, `${name}=${value}\n`);
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
}

function runGit(args: string[]): string {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
  return result.stdout.trim();
}

function gitSucceeds(args: string[]): boolean {
  const result = spawnSync("git", args, {
    stdio: "ignore",
    shell: false,
  });
  if (result.error) {
    throw result.error;
  }
  return result.status === 0;
}
