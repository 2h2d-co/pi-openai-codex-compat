import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ReleaseNotesInput = {
  changelog: string;
  packageName: string;
  version: string;
  npmTag: string;
  archiveName: string;
  archiveDigest: string;
};

/**
 * The changelog section for a version: `## [X.Y.Z] - date`, `## X.Y.Z - date`, or
 * `## vX.Y.Z`. Prereleases keep their entries under `Unreleased`, so their notes come
 * from that section instead.
 */
export function changelogSection(changelog: string, version: string): string {
  const prerelease = version.includes("-");
  const heading = prerelease
    ? /^##\s+\[?unreleased\]?\s*$/i
    : new RegExp(`^##\\s+\\[?v?${escapeRegExp(version)}\\]?(?:\\s+-\\s+\\S.*|\\s*)$`);
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) {
    throw new Error(
      `CHANGELOG.md has no ${prerelease ? "Unreleased" : version} section for release notes.`,
    );
  }
  let end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  if (end < 0) end = lines.length;
  const body = lines
    .slice(start + 1, end)
    .filter((line) => !/^\[[^\]]+\]:\s+\S+/.test(line))
    .join("\n")
    .trim();
  if (body.length === 0) {
    throw new Error(
      `CHANGELOG.md section ${prerelease ? "Unreleased" : version} is empty; add release entries first.`,
    );
  }
  return body;
}

export function releaseNotes(input: ReleaseNotesInput): string {
  const section = changelogSection(input.changelog, input.version);
  return [
    section,
    "",
    "## Installation",
    "",
    "```sh",
    `pi install npm:${input.packageName}@${input.version}`,
    "```",
    "",
    "## Integrity",
    "",
    `- npm: \`${input.packageName}@${input.version}\` on dist-tag \`${input.npmTag}\`, staged by this workflow and published after maintainer approval.`,
    `- \`${input.archiveName}\` SHA-256: \`${input.archiveDigest}\`, equal to the \`Npm-Artifact-SHA256\` trailer of the signed release commit and to the npm archive.`,
    "",
  ].join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Fail before any release artifact exists when the changelog lacks the version's section. */
export function assertChangelogSection(changelog: string, version: string): void {
  changelogSection(changelog, version);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required.`);
    return value;
  };
  const changelog = readFileSync(resolve(process.cwd(), "CHANGELOG.md"), "utf8");
  if (process.argv[2] === "--check") {
    // Pre-release gate: validate the section for the version in package.json.
    const manifest: unknown = JSON.parse(
      readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
    );
    const version =
      typeof manifest === "object" && manifest !== null && "version" in manifest
        ? manifest.version
        : undefined;
    if (typeof version !== "string") throw new Error("package.json has no version.");
    assertChangelogSection(changelog, version);
    console.log(`CHANGELOG.md has release notes for ${version}.`);
  } else {
    const output = required("RELEASE_NOTES_FILE");
    const notes = releaseNotes({
      changelog,
      packageName: required("PACKAGE_NAME"),
      version: required("PACKAGE_VERSION"),
      npmTag: required("NPM_DIST_TAG"),
      archiveName: required("ARCHIVE_NAME"),
      archiveDigest: required("ARCHIVE_DIGEST"),
    });
    writeFileSync(output, notes);
    console.log(
      `Wrote release notes for ${required("PACKAGE_NAME")}@${required("PACKAGE_VERSION")}.`,
    );
  }
}
