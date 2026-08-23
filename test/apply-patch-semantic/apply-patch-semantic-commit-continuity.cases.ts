import type { BigIntStats, PathLike, Stats, StatOptions } from "node:fs";
import { copyFile } from "node:fs/promises";
import {
  assert,
  mkdir,
  stat,
  readFile,
  readlink,
  rename,
  symlink,
  writeFile,
  join,
  test,
  applyPatch,
  ApplyPatchExecutionError,
  workspace,
  assertMissing,
  patch,
} from "./apply-patch-semantic-harness.ts";

function statWithAfterRead(afterRead: (path: PathLike) => Promise<void>): typeof stat {
  function wrappedStat(
    path: PathLike,
    options?: StatOptions & { bigint?: false | undefined },
  ): Promise<Stats>;
  function wrappedStat(
    path: PathLike,
    options: StatOptions & { bigint: true },
  ): Promise<BigIntStats>;
  function wrappedStat(path: PathLike, options?: StatOptions): Promise<BigIntStats | Stats>;
  async function wrappedStat(path: PathLike, options?: StatOptions): Promise<BigIntStats | Stats> {
    const metadata =
      options?.bigint === true
        ? await stat(path, { ...options, bigint: true })
        : await stat(path, { ...options, bigint: false });
    await afterRead(path);
    return metadata;
  }
  return wrappedStat;
}

test("rejects changed replacement content before committing", async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, "added.txt");
  let substituted = false;

  await assert.rejects(
    applyPatch(cwd, patch("*** Add File: added.txt\n+intended\n"), undefined, {
      filesystem: {
        async rename(source, destination) {
          await rename(source, destination);
          if (!substituted && destination === target) {
            substituted = true;
            await writeFile(target, "external\n");
          }
        },
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchExecutionError);
      assert.equal(error.details.instructions?.[0]?.status, "failed");
      assert.equal(error.details.exact, false);
      return true;
    },
  );
  assert.equal(await readFile(target, "utf8"), "external\n");
});

test("rejects substitutions of created parents and their children", async (t) => {
  const cwd = await workspace(t);
  const parent = join(cwd, "created");
  const destination = join(parent, "added.txt");
  const displacedParent = join(cwd, "displaced");
  let substituted = false;

  await assert.rejects(
    applyPatch(cwd, patch("*** Add File: created/added.txt\n+intended\n"), undefined, {
      filesystem: {
        async rename(source, target) {
          await rename(source, target);
          if (!substituted && target === destination) {
            substituted = true;
            await rename(parent, displacedParent);
            await mkdir(parent);
            await writeFile(destination, "external\n");
          }
        },
      },
    }),
    ApplyPatchExecutionError,
  );
  assert.equal(await readFile(destination, "utf8"), "external\n");
  assert.equal(await readFile(join(displacedParent, "added.txt"), "utf8"), "intended\n");
});

test("rejects a substituted source moved by native rename", async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, "source.txt");
  const destination = join(cwd, "destination.txt");
  const displaced = join(cwd, "displaced.txt");
  await writeFile(source, "intended\n");
  let substituted = false;

  await assert.rejects(
    applyPatch(
      cwd,
      patch("*** Update File: source.txt\n*** Move to: destination.txt\n"),
      undefined,
      {
        filesystem: {
          async rename(from, to) {
            if (!substituted && from === source && to === destination) {
              substituted = true;
              await rename(source, displaced);
              await writeFile(source, "external\n");
            }
            await rename(from, to);
          },
        },
      },
    ),
    ApplyPatchExecutionError,
  );
  await assertMissing(source);
  assert.equal(await readFile(destination, "utf8"), "external\n");
  assert.equal(await readFile(displaced, "utf8"), "intended\n");
});

test("retains symlink provenance through native moves", async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, "source-link");
  const destination = join(cwd, "destination-link");
  const displaced = join(cwd, "displaced-link");
  await symlink("intended-target", source);
  let substituted = false;

  await assert.rejects(
    applyPatch(
      cwd,
      patch("*** Update File: source-link\n*** Move to: destination-link\n"),
      undefined,
      {
        filesystem: {
          async rename(from, to) {
            if (!substituted && from === source && to === destination) {
              substituted = true;
              await rename(source, displaced);
              await symlink("external-target", source);
            }
            await rename(from, to);
          },
        },
      },
    ),
    ApplyPatchExecutionError,
  );
  assert.equal(await readlink(destination), "external-target");
  assert.equal(await readlink(displaced), "intended-target");
});

test("rejects source substitution during a cross-device copy", async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, "source.txt");
  const destination = join(cwd, "destination.txt");
  const displaced = join(cwd, "displaced.txt");
  await writeFile(source, "intended\n");
  let substituted = false;

  await assert.rejects(
    applyPatch(
      cwd,
      patch("*** Update File: source.txt\n*** Move to: destination.txt\n"),
      undefined,
      {
        selectMoveStrategy: () => "copy-unlink",
        filesystem: {
          async copyFile(from, to, mode) {
            if (!substituted && from === source) {
              substituted = true;
              await rename(source, displaced);
              await writeFile(source, "external\n");
            }
            await copyFile(from, to, mode);
          },
        },
      },
    ),
    ApplyPatchExecutionError,
  );
  assert.equal(await readFile(source, "utf8"), "external\n");
  assert.equal(await readFile(displaced, "utf8"), "intended\n");
  await assertMissing(destination);
});

test("revalidates symlinks while preparing cross-device moves", async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, "source-link");
  const destination = join(cwd, "destination-link");
  const displaced = join(cwd, "displaced-link");
  await symlink("intended-target", source);
  let substituted = false;

  await assert.rejects(
    applyPatch(
      cwd,
      patch("*** Update File: source-link\n*** Move to: destination-link\n"),
      undefined,
      {
        selectMoveStrategy: () => "copy-unlink",
        filesystem: {
          async symlink(target, path, type) {
            await symlink(target, path, type);
            if (!substituted) {
              substituted = true;
              await rename(source, displaced);
              await symlink("external-target", source);
            }
          },
        },
      },
    ),
    ApplyPatchExecutionError,
  );
  assert.equal(await readlink(source), "external-target");
  assert.equal(await readlink(displaced), "intended-target");
  await assertMissing(destination);
});

test("revalidates a text-move source immediately before unlink", async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, "source.txt");
  const destination = join(cwd, "destination.txt");
  const displaced = join(cwd, "displaced.txt");
  await writeFile(source, "before\n");
  let substituted = false;

  await assert.rejects(
    applyPatch(
      cwd,
      patch(
        "*** Update File: source.txt\n",
        "*** Move to: destination.txt\n",
        "@@\n-before\n+after\n",
      ),
      undefined,
      {
        filesystem: {
          async rename(from, to) {
            await rename(from, to);
            if (!substituted && to === destination) {
              substituted = true;
              await rename(source, displaced);
              await writeFile(source, "external\n");
            }
          },
        },
      },
    ),
    ApplyPatchExecutionError,
  );
  assert.equal(await readFile(source, "utf8"), "external\n");
  assert.equal(await readFile(displaced, "utf8"), "before\n");
  assert.equal(await readFile(destination, "utf8"), "after\n");
});

test("does not bless a pathname substituted after a descriptor-bound write", async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, "source.txt");
  const displaced = join(cwd, "displaced.txt");
  await writeFile(source, "before\n");
  let substituted = false;

  await assert.rejects(
    applyPatch(cwd, patch("*** Update File: source.txt\n@@\n-before\n+after\n"), undefined, {
      filesystem: {
        stat: statWithAfterRead(async (path) => {
          if (!substituted && path === source) {
            substituted = true;
            await rename(source, displaced);
            await writeFile(source, "external\n");
          }
        }),
      },
    }),
    ApplyPatchExecutionError,
  );
  assert.equal(await readFile(source, "utf8"), "external\n");
  assert.equal(await readFile(displaced, "utf8"), "after\n");
});
