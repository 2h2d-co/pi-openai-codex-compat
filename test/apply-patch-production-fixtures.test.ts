import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test, { type TestContext } from "node:test";
import {
  applyPatch,
  ApplyPatchVerificationError,
} from "../extensions/openai-codex-compat/apply-patch-engine.ts";
import {
  PRODUCTION_APPLY_PATCH_FIXTURES,
  type ProductionApplyPatchFixture,
  type ProductionFileFixture,
} from "./fixtures/apply-patch-production.ts";

type MaterializedFixture = {
  root: string;
  cwd: string;
  patch: string;
};

async function workspace(t: TestContext): Promise<{ root: string; cwd: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-codex-production-patch-"));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  t.after(async () => rm(root, { recursive: true, force: true }));
  return { root, cwd };
}

function materialize(value: string, root: string, cwd: string): string {
  return value.replaceAll("<ROOT>", root).replaceAll("<CWD>", cwd);
}

async function writeFixtureFile(
  fixture: ProductionFileFixture,
  root: string,
  cwd: string,
): Promise<void> {
  const path = materialize(fixture.path, root, cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, fixture.content);
  if (fixture.mode !== undefined) await chmod(path, fixture.mode);
}

async function materializeFixture(
  t: TestContext,
  fixture: ProductionApplyPatchFixture,
): Promise<MaterializedFixture> {
  const { root, cwd } = await workspace(t);
  for (const file of fixture.initialFiles) await writeFixtureFile(file, root, cwd);
  return {
    root,
    cwd,
    patch: materialize(fixture.patch, root, cwd),
  };
}

async function snapshotTree(
  root: string,
): Promise<
  Record<
    string,
    | { type: "directory"; mode: number }
    | { type: "regular"; bytes: string; mode: number }
    | { type: "symlink"; target: string; mode: number }
  >
> {
  const snapshot: Awaited<ReturnType<typeof snapshotTree>> = {};

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = relative(root, path);
      const metadata = await lstat(path);
      if (entry.isDirectory()) {
        snapshot[relativePath] = {
          type: "directory",
          mode: metadata.mode & 0o777,
        };
        await visit(path);
        continue;
      }
      if (entry.isSymbolicLink()) {
        snapshot[relativePath] = {
          type: "symlink",
          target: await readlink(path),
          mode: metadata.mode & 0o777,
        };
        continue;
      }
      snapshot[relativePath] = {
        type: "regular",
        bytes: (await readFile(path)).toString("base64"),
        mode: metadata.mode & 0o777,
      };
    }
  }

  await visit(root);
  return snapshot;
}

function expectedSuccessTree(
  before: Awaited<ReturnType<typeof snapshotTree>>,
  fixture: ProductionApplyPatchFixture,
  materialized: MaterializedFixture,
): Awaited<ReturnType<typeof snapshotTree>> {
  if (fixture.expected.outcome !== "success") throw new Error("success fixture required");
  const expected = structuredClone(before);

  for (const absentPath of fixture.expected.absent) {
    const relativePath = relative(
      materialized.root,
      materialize(absentPath, materialized.root, materialized.cwd),
    );
    for (const path of Object.keys(expected)) {
      if (path === relativePath || path.startsWith(`${relativePath}/`)) delete expected[path];
    }
  }

  for (const file of fixture.expected.files) {
    const absolutePath = materialize(file.path, materialized.root, materialized.cwd);
    const relativePath = relative(materialized.root, absolutePath);
    let parent = dirname(relativePath);
    while (parent !== "." && parent !== "") {
      expected[parent] ??= {
        type: "directory",
        mode: 0o777 & ~process.umask(),
      };
      parent = dirname(parent);
    }
    const prior = expected[relativePath];
    expected[relativePath] = {
      type: "regular",
      bytes: Buffer.from(file.content).toString("base64"),
      mode: file.mode ?? (prior?.type === "regular" ? prior.mode : 0o666 & ~process.umask()),
    };
  }
  return expected;
}

for (const fixture of PRODUCTION_APPLY_PATCH_FIXTURES) {
  void test(`production fixture: ${fixture.id}`, async (t) => {
    const materialized = await materializeFixture(t, fixture);
    const before = await snapshotTree(materialized.root);
    const expected = fixture.expected;

    if (expected.outcome === "verification-error") {
      await assert.rejects(applyPatch(materialized.cwd, materialized.patch), (error: unknown) => {
        assert.ok(error instanceof ApplyPatchVerificationError);
        assert.match(error.message, expected.messagePattern);
        if (fixture.sourceFingerprints.includes("fb56a75092a777bc")) {
          assert.deepEqual(error.details.failure?.matcher, {
            reason: "no-ordered-mapping",
            path: materialize("<CWD>/semantics.md", materialized.root, materialized.cwd),
            groupCount: 2,
            groupIndex: 2,
            chunkCount: 2,
            chunkIndex: 2,
            candidateCount: 1,
            candidates: [{ startLine: 6, endLine: 6 }],
            previousGroupIndex: 1,
            previousCandidates: [{ startLine: 12, endLine: 12 }],
            reverseOrdered: true,
          });
          assert.match(error.message, /hunks may be in reverse source order or overlap/u);
        }
        if (fixture.sourceFingerprints.includes("0e900184894b9986")) {
          assert.equal(error.details.failure?.matcher?.reason, "no-candidate");
          assert.equal(error.details.failure?.matcher?.groupIndex, 2);
          assert.deepEqual(error.details.failure?.matcher?.replacementCandidates, [
            { startLine: 1, endLine: 1 },
          ]);
          assert.match(error.message, /requested replacement already appears at line 1/u);
        }
        return true;
      });
      assert.deepEqual(await snapshotTree(materialized.root), before);
      return;
    }

    const details = await applyPatch(materialized.cwd, materialized.patch);
    assert.deepEqual(
      details.changes.map((change) => change.kind),
      expected.changeKinds,
    );

    for (const expectedFile of expected.files) {
      const path = materialize(expectedFile.path, materialized.root, materialized.cwd);
      assert.equal(await readFile(path, "utf8"), expectedFile.content);
      if (expectedFile.mode !== undefined) {
        assert.equal((await lstat(path)).mode & 0o777, expectedFile.mode);
      }
    }
    for (const absentPath of expected.absent) {
      await assert.rejects(lstat(materialize(absentPath, materialized.root, materialized.cwd)), {
        code: "ENOENT",
      });
    }
    assert.deepEqual(
      await snapshotTree(materialized.root),
      expectedSuccessTree(before, fixture, materialized),
    );
  });
}

void test("production fixtures retain traceable, non-duplicated source fingerprints", () => {
  const fingerprints = PRODUCTION_APPLY_PATCH_FIXTURES.flatMap(
    (fixture) => fixture.sourceFingerprints,
  );
  assert.equal(PRODUCTION_APPLY_PATCH_FIXTURES.length, 23);
  assert.equal(new Set(fingerprints).size, fingerprints.length);
});
