import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { setTimeout } from "node:timers/promises";
import { spawn } from "node-pty";
import { packageArchive } from "./support/package-archive.ts";
import { linkProductionDependencies } from "./support/codex-cli-harness.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const mode of ["regular", "fullscreen"]) {
  test(`packaged settings menu in ${mode} Pi TUI`, { timeout: 30_000 }, async (t) => {
    const temporary = await mkdtemp(join(tmpdir(), "codex-settings-cli-"));
    const agent = join(temporary, "agent");
    await mkdir(agent);
    const archive = await packageArchive(root, temporary, process.env["PI_CODEX_PACKAGE_ARCHIVE"]);
    execFileSync("tar", ["-xzf", archive.path, "-C", temporary]);
    await linkProductionDependencies(join(temporary, "package"));
    await writeFile(
      join(agent, "settings.json"),
      JSON.stringify({
        tuiMode: mode,
        quietStartup: true,
        defaultProjectTrust: "never",
        enableInstallTelemetry: false,
        defaultProvider: "openai-codex",
        defaultModel: "gpt-6-astra",
      }),
    );
    const piPackage = join(root, "node_modules/@earendil-works/pi-coding-agent");
    const cli = join(piPackage, "dist/bundle/cli.js");
    assert.equal(
      execFileSync(process.execPath, [cli, "--version"], {
        env: { ...process.env, PI_PACKAGE_DIR: piPackage },
        encoding: "utf8",
      }).trim(),
      "0.87.1",
    );
    // No credentials or provider requests. Keep normal extension loading enabled.
    const terminal = spawn(process.execPath, [cli, "-e", join(temporary, "package")], {
      cwd: temporary,
      cols: 120,
      rows: 35,
      name: "xterm-256color",
      env: {
        PATH: process.env["PATH"],
        HOME: temporary,
        TERM: "xterm-256color",
        PI_CODING_AGENT_DIR: agent,
        PI_PACKAGE_DIR: piPackage,
      },
    });
    let output = "";
    let exited = false;
    terminal.onData((data) => {
      output = (output + data).slice(-50_000);
    });
    terminal.onExit(() => {
      exited = true;
    });
    t.after(async () => {
      if (!exited) terminal.kill();
      for (let attempt = 0; attempt < 100 && !exited; attempt++) await setTimeout(10);
      await rm(temporary, { recursive: true, force: true });
    });
    const wait = async (text: string) => {
      for (let attempt = 0; attempt < 500 && !output.includes(text) && !exited; attempt++)
        await setTimeout(20);
      assert.ok(output.includes(text), `Missing ${text}; terminal output:\n${output}`);
    };
    await wait("No models available");
    terminal.write("/codex-settings\r");
    await wait("Draft changes apply");
    terminal.write("Fast mode");
    await setTimeout(100);
    terminal.write("\r");
    await wait("draft change");
    const file = join(agent, "openai-codex-compat.json");
    await assert.rejects(readFile(file), { code: "ENOENT" });
    terminal.write("\t\t\r");
    await wait("Applied to session");
    await assert.rejects(readFile(file), { code: "ENOENT" });
    terminal.write("\u001b");
    await setTimeout(150);
    output = "";
    terminal.write("/codex-settings\r");
    await wait("Session settings shown");
    assert.match(stripVTControlCharacters(output), /Fast mode\s+on ~/);
    terminal.write("\u0013");
    await wait("Saved and applied");
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { fastMode: true });
    terminal.resize(50, 14);
    await setTimeout(100);
    terminal.write("\r");
    await setTimeout(100);
    terminal.write("\u001b");
    await setTimeout(100);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { fastMode: true });
    terminal.write("\u0004");
    for (let attempt = 0; attempt < 100 && !exited; attempt++) await setTimeout(20);
    assert.ok(exited, "Pi should exit cleanly after the menu closes.");
  });
}
