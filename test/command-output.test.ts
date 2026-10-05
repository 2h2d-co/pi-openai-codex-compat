import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import {
  CommandOutputAccumulator,
  CommandOutputSpool,
} from "../extensions/openai-codex-compat/command-output.ts";

const writers = [
  {
    name: "accumulator",
    create(prefix: string) {
      const output = new CommandOutputAccumulator(prefix);
      return {
        append: (data: string) => output.append(data),
        finish: () => output.close(),
        dispose: () => output.discard(),
      };
    },
  },
  {
    name: "spool",
    create(prefix: string) {
      const spool = new CommandOutputSpool(prefix);
      const output = new CommandOutputAccumulator(prefix, { retainCompleteOutput: false });
      return {
        append: (data: string) => spool.append(data),
        finish: () => spool.replayTo(output),
        dispose: () => spool.dispose(),
      };
    },
  },
];

for (const writer of writers) {
  test(`${writer.name} creates owner-only output and removes its own file`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-command-output-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const output = writer.create(relative(tmpdir(), join(directory, "output")));
    output.append("x".repeat(DEFAULT_MAX_BYTES + 1));
    await output.finish();

    const files = await readdir(directory);
    assert.equal(files.length, 1);
    const [filename] = files;
    assert.ok(filename);
    const outputPath = join(directory, filename);
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
    assert.equal(await readFile(outputPath, "utf8"), "x".repeat(DEFAULT_MAX_BYTES + 1));

    await output.dispose();
    assert.deepEqual(await readdir(directory), []);
    await writeFile(outputPath, "replacement file");
    await output.dispose();
    assert.equal(await readFile(outputPath, "utf8"), "replacement file");
  });

  test(`${writer.name} removes its own file after a write error`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-command-output-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const failure = Object.assign(new Error("synthetic write failure"), { code: "EIO" });
    const createWriteStream = fs.createWriteStream;
    let failed: () => void = () => {};
    const writeError = new Promise<void>((resolve) => {
      failed = resolve;
    });
    t.mock.method(fs, "createWriteStream", (...args: Parameters<typeof createWriteStream>) => {
      const stream = createWriteStream(...args);
      stream.once("open", () => stream.destroy(failure));
      stream.once("error", failed);
      return stream;
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });

    const output = writer.create(relative(tmpdir(), join(directory, "output")));
    output.append("x".repeat(DEFAULT_MAX_BYTES + 1));
    await writeError;
    await assert.rejects(output.finish(), failure);
    await assert.rejects(output.dispose(), failure);
    assert.deepEqual(await readdir(directory), []);
  });

  for (const collision of ["file", "symlink"] as const) {
    for (const earlyError of [false, true]) {
      test(
        `${writer.name} preserves a colliding ${collision} after ${
          earlyError ? "an earlier" : "a pending"
        } open error`,
        { timeout: 5_000 },
        async (t) => {
          const directory = await mkdtemp(join(tmpdir(), "pi-command-output-test-"));
          t.after(() => rm(directory, { recursive: true, force: true }));
          const target = join(directory, "existing");
          const prefix = relative(tmpdir(), join(directory, "output"));
          const outputPath = join(tmpdir(), `${prefix}-${"00".repeat(8)}.log`);
          await writeFile(target, "preserve existing data");
          if (collision === "symlink") {
            await symlink(target, outputPath);
          } else {
            await writeFile(outputPath, "preserve existing data");
          }

          t.mock.method(crypto, "randomBytes", () => Buffer.alloc(8));
          const createWriteStream = fs.createWriteStream;
          let openedWithError: () => void = () => {};
          const openError = new Promise<void>((resolve) => {
            openedWithError = resolve;
          });
          t.mock.method(
            fs,
            "createWriteStream",
            (...args: Parameters<typeof createWriteStream>) => {
              const stream = createWriteStream(...args);
              stream.once("error", openedWithError);
              return stream;
            },
          );
          syncBuiltinESMExports();
          t.after(() => {
            t.mock.restoreAll();
            syncBuiltinESMExports();
          });

          const output = writer.create(prefix);
          output.append("x".repeat(DEFAULT_MAX_BYTES + 1));
          if (earlyError) await openError;
          await assert.rejects(output.finish(), { code: "EEXIST" });
          await assert.rejects(output.dispose(), { code: "EEXIST" });
          assert.equal(await readFile(outputPath, "utf8"), "preserve existing data");
          assert.equal(await readFile(target, "utf8"), "preserve existing data");
          if (collision === "symlink") assert.equal(await fs.promises.readlink(outputPath), target);
        },
      );
    }
  }
}
