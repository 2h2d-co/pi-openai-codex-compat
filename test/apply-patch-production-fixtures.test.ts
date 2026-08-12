import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
): Promise<Record<string, { bytes: string; mode: number }>> {
  const snapshot: Record<string, { bytes: string; mode: number }> = {};

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      const metadata = await lstat(path);
      snapshot[relative(root, path)] = {
        bytes: (await readFile(path)).toString("base64"),
        mode: metadata.mode & 0o777,
      };
    }
  }

  await visit(root);
  return snapshot;
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
  });
}

void test("production fixtures retain traceable, non-duplicated source fingerprints", () => {
  const fingerprints = PRODUCTION_APPLY_PATCH_FIXTURES.flatMap(
    (fixture) => fixture.sourceFingerprints,
  );
  assert.equal(PRODUCTION_APPLY_PATCH_FIXTURES.length, 9);
  assert.equal(new Set(fingerprints).size, fingerprints.length);
});
