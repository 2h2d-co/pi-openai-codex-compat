import assert from "node:assert/strict";
import test from "node:test";
import { changelogSection } from "../scripts/release-notes.ts";

// The release job runs after the tag is pushed and the package is staged, so a
// changelog-parsing mistake would surface only there. Cover the parsing rules offline.
const keepAChangelog = `# Changelog

## [Unreleased]

- Pending change.

## [0.0.10] - 2026-09-21

- Tenth release.

## [0.0.1] - 2026-09-20

- First release.

[Unreleased]: https://example.invalid/compare/v0.0.10...HEAD
[0.0.10]: https://example.invalid/compare/v0.0.1...v0.0.10
[0.0.1]: https://example.invalid/releases/tag/v0.0.1
`;

const plainHeadings = `# Changelog

## Unreleased

## 0.0.12 - 2026-09-20

- Twelfth release.

## 0.0.1 - 2026-09-20

- First release.
`;

test("matches the exact version under bracketed and plain headings", () => {
  assert.equal(changelogSection(keepAChangelog, "0.0.1"), "- First release.");
  assert.equal(changelogSection(keepAChangelog, "0.0.10"), "- Tenth release.");
  assert.equal(changelogSection(plainHeadings, "0.0.1"), "- First release.");
  assert.equal(changelogSection(plainHeadings, "0.0.12"), "- Twelfth release.");
});

test("prereleases take the Unreleased section", () => {
  assert.equal(changelogSection(keepAChangelog, "0.0.11-alpha.0"), "- Pending change.");
});

test("fails closed when the section is missing or empty", () => {
  assert.throws(() => changelogSection(keepAChangelog, "0.0.2"), /no 0\.0\.2 section/);
  assert.throws(
    () => changelogSection(plainHeadings, "0.0.13-beta.1"),
    /section Unreleased is empty/,
  );
});
