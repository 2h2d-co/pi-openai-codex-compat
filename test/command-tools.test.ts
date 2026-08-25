import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import type {
  CommandProcess,
  CommandProcessExit,
  CommandProcessOptions,
  CommandProcessSpawner,
} from "../extensions/openai-codex-compat/command-process.ts";
import {
  executeShellCommand,
  UnifiedExecManager,
  type CommandRuntimeContext,
} from "../extensions/openai-codex-compat/command-runtime.ts";
import {
  EXEC_COMMAND_PARAMETERS,
  SHELL_COMMAND_PARAMETERS,
  WRITE_STDIN_PARAMETERS,
} from "../extensions/openai-codex-compat/command-tools.ts";

class FakeCommandProcess implements CommandProcess {
  readonly pid = 42;
  readonly tty: boolean;
  readonly exited: Promise<CommandProcessExit>;
  private resolveExit: (exit: CommandProcessExit) => void = () => {};
  private done = false;
  private code: number | null | undefined;
  private readonly onWrite: ((chars: string) => void) | undefined;

  constructor(tty: boolean, onWrite?: (chars: string) => void) {
    this.tty = tty;
    this.onWrite = onWrite;
    this.exited = new Promise((resolveExit) => {
      this.resolveExit = resolveExit;
    });
  }

  complete(exitCode: number): void {
    if (this.done) return;
    this.done = true;
    this.code = exitCode;
    this.resolveExit({ exitCode });
  }

  hasExited(): boolean {
    return this.done;
  }

  exitCode(): number | null | undefined {
    return this.code;
  }

  write(chars: string): void {
    this.onWrite?.(chars);
  }

  interrupt(): void {
    this.complete(130);
  }

  terminate(): void {
    this.complete(-1);
  }
}

function runtimeContext(cwd = process.cwd()): CommandRuntimeContext {
  return {
    cwd,
    model: undefined,
    sessionManager: {
      getSessionId: () => "command-tools-test",
      getSessionFile: () => undefined,
    },
  };
}

test("advertises the simplified official command schemas", () => {
  assert.deepEqual(Object.keys(EXEC_COMMAND_PARAMETERS.properties), [
    "cmd",
    "workdir",
    "shell",
    "login",
    "tty",
    "yield_time_ms",
    "max_output_tokens",
  ]);
  assert.deepEqual(Object.keys(WRITE_STDIN_PARAMETERS.properties), [
    "session_id",
    "chars",
    "yield_time_ms",
    "max_output_tokens",
  ]);
  assert.deepEqual(Object.keys(SHELL_COMMAND_PARAMETERS.properties), [
    "command",
    "workdir",
    "timeout_ms",
    "login",
  ]);
  assert.equal(Reflect.get(EXEC_COMMAND_PARAMETERS, "additionalProperties"), false);
  assert.equal(Reflect.get(WRITE_STDIN_PARAMETERS, "additionalProperties"), false);
  assert.equal(Reflect.get(SHELL_COMMAND_PARAMETERS, "additionalProperties"), false);
  assert.deepEqual(Reflect.get(EXEC_COMMAND_PARAMETERS, "required"), ["cmd"]);
  assert.deepEqual(Reflect.get(WRITE_STDIN_PARAMETERS, "required"), ["session_id"]);
  assert.deepEqual(Reflect.get(SHELL_COMMAND_PARAMETERS, "required"), ["command"]);
  for (const forbidden of [
    "environment_id",
    "sandbox_permissions",
    "additional_permissions",
    "justification",
    "prefix_rule",
  ]) {
    assert.equal(Object.hasOwn(EXEC_COMMAND_PARAMETERS.properties, forbidden), false);
    assert.equal(Object.hasOwn(SHELL_COMMAND_PARAMETERS.properties, forbidden), false);
  }
});

test("runs shell_command with Pi-style tail truncation and a complete temp file", async (t) => {
  const completeOutput = `${"x".repeat(60 * 1_024)}\nfinished\n`;
  const spawnProcess: CommandProcessSpawner = (options) => {
    const commandProcess = new FakeCommandProcess(false);
    queueMicrotask(() => {
      options.onData(Buffer.from(completeOutput));
      commandProcess.complete(0);
    });
    return commandProcess;
  };

  const result = await executeShellCommand(
    { command: "large-output", login: false },
    runtimeContext(),
    undefined,
    undefined,
    spawnProcess,
  );
  const fullOutputPath = result.details.fullOutputPath;
  assert.ok(fullOutputPath);
  t.after(async () => rm(fullOutputPath, { force: true }));

  assert.equal(await readFile(fullOutputPath, "utf8"), completeOutput);
  assert.equal(result.details.truncation?.truncated, true);
  assert.match(result.content[0]?.text ?? "", /finished/);
  assert.match(result.content[0]?.text ?? "", /Full output:/);
  assert.match(result.content[0]?.text ?? "", /Exit code: 0/);
});

test("reports shell_command timeouts with captured output", async () => {
  const spawnProcess: CommandProcessSpawner = (options) => {
    const commandProcess = new FakeCommandProcess(false);
    options.onData("started\n");
    return commandProcess;
  };

  await assert.rejects(
    executeShellCommand(
      { command: "slow-command", login: false, timeout_ms: 5 },
      runtimeContext(),
      undefined,
      undefined,
      spawnProcess,
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Exit code: 124/);
      assert.match(error.message, /started/);
      assert.match(error.message, /command timed out after 5 milliseconds/);
      return true;
    },
  );
});

test("applies unified exec's output-token budget within Pi's hard cap", async (t) => {
  const completeOutput = `${"u".repeat(45 * 1_024)}\nfinished\n`;
  const spawnProcess: CommandProcessSpawner = (options) => {
    const commandProcess = new FakeCommandProcess(false);
    queueMicrotask(() => {
      options.onData(completeOutput);
      commandProcess.complete(0);
    });
    return commandProcess;
  };
  const manager = new UnifiedExecManager(spawnProcess);
  t.after(async () => manager.terminateAll());

  const result = await manager.execCommand(
    { cmd: "large-unified-output", login: false, yield_time_ms: 250 },
    runtimeContext(),
    undefined,
    undefined,
  );
  const fullOutputPath = result.details.fullOutputPath;
  assert.ok(fullOutputPath);
  t.after(async () => rm(fullOutputPath, { force: true }));

  assert.equal(await readFile(fullOutputPath, "utf8"), completeOutput);
  assert.equal(result.details.truncation?.maxBytes, 40_000);
  assert.match(result.content[0]?.text ?? "", /finished/);
  assert.equal(result.details.exitCode, 0);
});

test("runs and interacts with a persistent unified exec session", async (t) => {
  let processOptions: CommandProcessOptions | undefined;
  const spawnProcess: CommandProcessSpawner = (options) => {
    processOptions = options;
    let commandProcess: FakeCommandProcess;
    commandProcess = new FakeCommandProcess(true, (chars) => {
      options.onData(`received:${chars}`);
      commandProcess.complete(0);
    });
    options.onData("ready\n");
    return commandProcess;
  };
  const manager = new UnifiedExecManager(spawnProcess);
  t.after(async () => manager.terminateAll());

  const started = await manager.execCommand(
    {
      cmd: "interactive",
      login: false,
      tty: true,
      yield_time_ms: 250,
    },
    runtimeContext(),
    undefined,
    undefined,
  );
  const sessionId = started.details.sessionId;
  assert.ok(sessionId);
  assert.equal(processOptions?.tty, true);
  assert.match(started.content[0]?.text ?? "", /Process running with session ID/);
  assert.match(started.content[0]?.text ?? "", /ready/);

  const completed = await manager.writeStdin(
    {
      session_id: sessionId,
      chars: "hello\n",
      yield_time_ms: 250,
    },
    undefined,
    undefined,
  );
  assert.equal(completed.details.exitCode, 0);
  assert.equal(completed.details.sessionId, undefined);
  assert.match(completed.content[0]?.text ?? "", /received:hello/);
  assert.equal(manager.activeSessionCount(), 0);
});

test("carries output forward when a process exits while an interaction is closing", async (t) => {
  const spawnProcess: CommandProcessSpawner = (options) => {
    const commandProcess = new FakeCommandProcess(false);
    let exitScheduled = false;
    const originalHasExited = commandProcess.hasExited.bind(commandProcess);
    commandProcess.hasExited = () => {
      const exited = originalHasExited();
      if (!exited && !exitScheduled) {
        exitScheduled = true;
        queueMicrotask(() => {
          options.onData("final output\n");
          commandProcess.complete(0);
        });
      }
      return exited;
    };
    return commandProcess;
  };
  const manager = new UnifiedExecManager(spawnProcess);
  t.after(async () => manager.terminateAll());

  const started = await manager.execCommand(
    {
      cmd: "racy-command",
      login: false,
      tty: false,
      yield_time_ms: 250,
    },
    runtimeContext(),
    undefined,
    undefined,
  );
  const sessionId = started.details.sessionId;
  assert.ok(sessionId);
  assert.doesNotMatch(started.content[0]?.text ?? "", /final output/);

  const completed = await manager.writeStdin(
    { session_id: sessionId, yield_time_ms: 5_000 },
    undefined,
    undefined,
  );
  assert.equal(completed.details.exitCode, 0);
  assert.match(completed.content[0]?.text ?? "", /final output/);
  assert.equal(manager.activeSessionCount(), 0);
});

test("executes a real node-pty session", { skip: process.platform === "win32" }, async (t) => {
  const manager = new UnifiedExecManager();
  t.after(async () => manager.terminateAll());

  const started = await manager.execCommand(
    {
      cmd: "printf 'ready\\n'; read value; printf 'received:%s\\n' \"$value\"",
      login: false,
      tty: true,
      yield_time_ms: 250,
    },
    runtimeContext(),
    undefined,
    undefined,
  );
  const sessionId = started.details.sessionId;
  assert.ok(sessionId);
  assert.match(started.content[0]?.text ?? "", /ready/);

  const completed = await manager.writeStdin(
    {
      session_id: sessionId,
      chars: "hello\n",
      yield_time_ms: 250,
    },
    undefined,
    undefined,
  );
  assert.equal(completed.details.exitCode, 0);
  assert.match(completed.content[0]?.text ?? "", /received:hello/);
});

test(
  "interrupts a real non-TTY unified exec session with Ctrl-C",
  { skip: process.platform === "win32" },
  async (t) => {
    const manager = new UnifiedExecManager();
    t.after(async () => manager.terminateAll());

    const started = await manager.execCommand(
      {
        cmd: "sleep 5",
        login: false,
        tty: false,
        yield_time_ms: 250,
      },
      runtimeContext(),
      undefined,
      undefined,
    );
    const sessionId = started.details.sessionId;
    assert.ok(sessionId);

    const completed = await manager.writeStdin(
      {
        session_id: sessionId,
        chars: "\u0003",
        yield_time_ms: 250,
      },
      undefined,
      undefined,
    );
    assert.equal(completed.details.exitCode, 130);
    assert.equal(manager.activeSessionCount(), 0);
  },
);
