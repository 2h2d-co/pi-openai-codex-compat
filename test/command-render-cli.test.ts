import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { spawn } from "node-pty";
import { linkProductionDependencies } from "./support/codex-cli-harness.ts";
import { packageArchive } from "./support/package-archive.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errorMessage = "Codex error: Our servers are currently overloaded. Please try again later.";

for (const { mode, live } of [
  { mode: "regular", live: false },
  { mode: "fullscreen", live: false },
  { mode: "regular", live: true },
]) {
  test(
    `packaged exec_command error stays boxed in ${mode} Pi TUI (live=${live})`,
    {
      skip: live && process.env["PI_CODEX_LIVE_TEST"] !== "1",
      timeout: 90_000,
    },
    async (t) => {
      const temporary = await mkdtemp(join(tmpdir(), "codex-command-render-cli-"));
      const agent = join(temporary, "agent");
      await mkdir(agent);
      const archive = await packageArchive(
        root,
        temporary,
        process.env["PI_CODEX_PACKAGE_ARCHIVE"],
      );
      execFileSync("tar", ["-xzf", archive.path, "-C", temporary]);
      await linkProductionDependencies(join(temporary, "package"));
      await writeFile(
        join(agent, "settings.json"),
        JSON.stringify({
          tuiMode: mode,
          quietStartup: true,
          defaultProjectTrust: "never",
          enableInstallTelemetry: false,
          retry: { enabled: false, provider: { timeoutMs: 60_000, maxRetries: 0 } },
        }),
      );
      const piPackage = join(root, "node_modules/@earendil-works/pi-coding-agent");
      const cli = join(piPackage, "dist/bundle/cli.js");
      assert.equal(
        execFileSync(process.execPath, [cli, "--version"], {
          env: { ...process.env, PI_PACKAGE_DIR: piPackage },
          encoding: "utf8",
        }).trim(),
        "1.0.0",
      );
      const manager = SessionManager.create(temporary, join(temporary, "sessions"));
      manager.appendMessage({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "interrupted-command",
            name: "exec_command",
            arguments: { cmd: "printf diagnostic", yield_time_ms: 10_000 },
          },
        ],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "gpt-6.1-sol",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage,
        timestamp: Date.now(),
      });
      const sessionFile = manager.getSessionFile();
      assert.ok(sessionFile);
      const args = [cli, "--session", sessionFile, "-e", join(temporary, "package")];
      const observedCall = join(temporary, "observed-call.json");
      if (live) {
        assert.ok(
          process.env["PI_CODEX_LIVE_API_KEY"],
          "Live rendering requires Codex credentials",
        );
        await writeFile(
          join(agent, "models.json"),
          JSON.stringify({
            providers: { "openai-codex": { apiKey: "$PI_CODEX_LIVE_API_KEY" } },
          }),
        );
        const guard = join(temporary, "guard.ts");
        // Exercise Pi's metadata-free tool error with a real Codex tool call.
        // Block execution and stop after the first turn to bound the request.
        await writeFile(
          guard,
          `
import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.on("tool_call", (event) => {
    writeFileSync(${JSON.stringify(observedCall)}, JSON.stringify({
      toolName: event.toolName, cmd: event.input.cmd,
    }));
    return { block: true, reason: ${JSON.stringify(errorMessage)} };
  });
  pi.on("turn_end", (_event, ctx) => { ctx.abort(); });
}
`,
        );
        args.splice(1, 2, "--no-session");
        args.push(
          "-e",
          guard,
          "--provider",
          "openai-codex",
          "--model",
          "gpt-5.6-luna",
          "--thinking",
          "low",
          "--tools",
          "bash,exec_command",
          "Call exec_command exactly once with cmd='printf diagnostic' and workdir=" +
            temporary +
            ". Do not call other tools.",
        );
      }
      // Offline cases only resume history. The live case blocks every tool execution.
      const terminal = spawn(process.execPath, args, {
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
          ...(live ? { PI_CODEX_LIVE_API_KEY: process.env["PI_CODEX_LIVE_API_KEY"] } : {}),
        },
      });
      let output = "";
      let exited = false;
      terminal.onData((data) => {
        output += data;
      });
      terminal.onExit(() => {
        exited = true;
      });
      t.after(async () => {
        if (!exited) terminal.kill();
        for (let attempt = 0; attempt < 100 && !exited; attempt++) await setTimeout(10);
        await rm(temporary, { recursive: true, force: true });
      });
      for (let attempt = 0; attempt < 3_000 && !output.includes(errorMessage) && !exited; attempt++)
        await setTimeout(20);
      assert.ok(output.includes(errorMessage), "Pi should render the interrupted tool call");
      if (live) {
        assert.deepEqual(JSON.parse(await readFile(observedCall, "utf8")), {
          toolName: "exec_command",
          cmd: "printf diagnostic",
        });
      }
      await setTimeout(100);
      // Capture a complete repaint, not a streaming delta that leaves unchanged
      // padding rows on screen and rewrites rows with cursor movement.
      output = "";
      terminal.resize(121, 35);
      for (let attempt = 0; attempt < 500 && !output.includes(errorMessage) && !exited; attempt++)
        await setTimeout(20);
      assert.ok(output.includes(errorMessage), "The error must survive a terminal repaint");
      await setTimeout(100);
      const lines = output.split(
        mode === "fullscreen" ? new RegExp(String.raw`\u001b\[\d+;1H`, "u") : /\r?\n/u,
      );
      const row = lines.findIndex((line) => line.includes(errorMessage));
      assert.ok(row > 0);
      assert.equal(stripVTControlCharacters(lines[row] ?? "").trimEnd(), ` ${errorMessage}`);
      for (const index of [row - 1, row, row + 1]) {
        assert.ok(
          lines[index]?.includes("\u001b[48;"),
          "Error and padding retain the tool surface",
        );
      }
      assert.equal(stripVTControlCharacters(lines[row - 1] ?? "").trim(), "");
      assert.equal(stripVTControlCharacters(lines[row + 1] ?? "").trim(), "");
      terminal.write("\u0004");
      for (let attempt = 0; attempt < 100 && !exited; attempt++) await setTimeout(20);
      assert.ok(exited, "Pi should exit cleanly");
    },
  );
}
