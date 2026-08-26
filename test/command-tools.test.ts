import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseShellApplyPatchInvocation } from "../extensions/openai-codex-compat/command-apply-patch.ts";
import { CommandOutputAccumulator } from "../extensions/openai-codex-compat/command-output.ts";
import type {
  CommandProcess,
  CommandProcessExit,
  CommandProcessOptions,
  CommandProcessSpawner,
} from "../extensions/openai-codex-compat/command-process.ts";
import {
  commandArguments,
  unifiedExecEnvironment,
} from "../extensions/openai-codex-compat/command-process.ts";
import {
  executeShellCommand,
  UnifiedExecManager,
  type CommandRuntimeContext,
  unifiedExecProcessIdToPrune,
} from "../extensions/openai-codex-compat/command-runtime.ts";
import {
  EXEC_COMMAND_DESCRIPTION,
  WRITE_STDIN_DESCRIPTION,
  SHELL_COMMAND_DESCRIPTION,
} from "../extensions/openai-codex-compat/command-tool-contract.ts";
import {
  createBackgroundProcessBrowser,
  createBackgroundProcessDetails,
} from "../extensions/openai-codex-compat/background-process-browser.ts";
import {
  EXEC_COMMAND_PARAMETERS,
  formatBackgroundProcesses,
  prepareShellCommandArguments,
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
  terminateCalls = 0;
  gracefulTerminationGraceMs: number[] = [];

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
    this.terminateCalls++;
    this.complete(-1);
  }

  terminateGracefully(graceMs: number): Promise<void> {
    this.gracefulTerminationGraceMs.push(graceMs);
    this.complete(1);
    return Promise.resolve();
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

test("uses the exact official descriptions for retained command fields", () => {
  if (process.platform === "win32") {
    assert.match(
      EXEC_COMMAND_DESCRIPTION,
      /^Runs a command in a PTY, returning output or a session ID for ongoing interaction\.\n\nWindows safety rules:/u,
    );
    assert.match(
      SHELL_COMMAND_DESCRIPTION,
      /^Runs a Powershell command \(Windows\) and returns its output\.\n\nExamples of valid command strings:/u,
    );
  } else {
    assert.equal(
      EXEC_COMMAND_DESCRIPTION,
      "Runs a command in a PTY, returning output or a session ID for ongoing interaction.",
    );
    assert.equal(
      SHELL_COMMAND_DESCRIPTION,
      "Runs a shell command and returns its output.\n- Always set the `workdir` param when using the shell_command function. Do not use `cd` unless absolutely necessary.",
    );
  }
  assert.equal(
    WRITE_STDIN_DESCRIPTION,
    "Writes characters to an existing unified exec session and returns recent output.",
  );
  assert.equal(
    Reflect.get(EXEC_COMMAND_PARAMETERS.properties.workdir, "description"),
    "Working directory for the command. Defaults to the turn cwd.",
  );
  assert.equal(
    Reflect.get(EXEC_COMMAND_PARAMETERS.properties.shell, "description"),
    "Shell binary to launch. Defaults to the user's default shell.",
  );
  assert.equal(
    Reflect.get(EXEC_COMMAND_PARAMETERS.properties.login, "description"),
    "True runs the shell with -l/-i semantics; false disables them. Defaults to true.",
  );
  assert.equal(
    Reflect.get(EXEC_COMMAND_PARAMETERS.properties.max_output_tokens, "description"),
    "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.",
  );
  assert.equal(
    Reflect.get(WRITE_STDIN_PARAMETERS.properties.chars, "description"),
    "Bytes to write to stdin. Defaults to empty, which polls without writing.",
  );
  assert.equal(
    Reflect.get(WRITE_STDIN_PARAMETERS.properties.yield_time_ms, "description"),
    "Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait 5000-300000 ms by default.",
  );
  assert.equal(
    Reflect.get(SHELL_COMMAND_PARAMETERS.properties.timeout_ms, "description"),
    "Maximum command runtime. Defaults to 10000 ms.",
  );
});

test("normalizes the unified exec environment without claiming Codex CI", () => {
  const environment = unifiedExecEnvironment(runtimeContext());
  assert.equal(environment["NO_COLOR"], "1");
  assert.equal(environment["TERM"], "dumb");
  assert.equal(environment["LANG"], "C.UTF-8");
  assert.equal(environment["LC_CTYPE"], "C.UTF-8");
  assert.equal(environment["LC_ALL"], "C.UTF-8");
  assert.equal(environment["COLORTERM"], "");
  assert.equal(environment["PAGER"], "cat");
  assert.equal(environment["GIT_PAGER"], "cat");
  assert.equal(environment["GH_PAGER"], "cat");
  assert.equal(environment["CODEX_CI"], process.env["CODEX_CI"]);
});

test("uses Codex PowerShell launch arguments without NonInteractive", () => {
  assert.deepEqual(commandArguments("/usr/bin/pwsh", "Get-ChildItem", false), [
    "-NoLogo",
    "-NoProfile",
    "-Command",
    "Get-ChildItem",
  ]);
});

test("accepts shell_command's hidden legacy timeout alias", () => {
  assert.deepEqual(prepareShellCommandArguments({ command: "pwd", timeout: 15 }), {
    command: "pwd",
    timeout_ms: 15,
  });
  assert.throws(
    () =>
      prepareShellCommandArguments({
        command: "pwd",
        timeout: 15,
        timeout_ms: 20,
      }),
    /failed to parse function arguments: duplicate field `timeout_ms`/u,
  );
});

test("recognizes only official top-level shell apply_patch forms", () => {
  const patch = "*** Begin Patch\n*** Add File: added.txt\n+added\n*** End Patch";
  assert.deepEqual(parseShellApplyPatchInvocation(`apply_patch <<'PATCH'\n${patch}\nPATCH`), {
    kind: "apply-patch",
    patch,
  });
  assert.deepEqual(
    parseShellApplyPatchInvocation(`cd "nested dir" && applypatch <<EOF\n${patch}\nEOF`),
    { kind: "apply-patch", patch, workdir: "nested dir" },
  );
  assert.deepEqual(parseShellApplyPatchInvocation(patch), { kind: "implicit-patch" });
  for (const script of [
    `echo before; apply_patch <<'PATCH'\n${patch}\nPATCH`,
    `apply_patch extra <<'PATCH'\n${patch}\nPATCH`,
    `apply_patch <<'PATCH'\n${patch}\nPATCH\n&& echo after`,
    `cd first && cd second && apply_patch <<'PATCH'\n${patch}\nPATCH`,
  ]) {
    assert.deepEqual(parseShellApplyPatchInvocation(script), { kind: "not-apply-patch" });
  }
});

test("intercepts shell_command and exec_command apply_patch heredocs without a shell binary", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-command-patch-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  let spawnCalls = 0;
  const spawnProcess: CommandProcessSpawner = () => {
    spawnCalls++;
    throw new Error("shell spawning must be bypassed");
  };
  const shellPatch =
    "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: shell.txt\n+shell\n*** End Patch\nPATCH";
  const shellResult = await executeShellCommand(
    { command: shellPatch, login: false },
    runtimeContext(cwd),
    undefined,
    undefined,
    spawnProcess,
  );
  assert.equal(await readFile(join(cwd, "shell.txt"), "utf8"), "shell\n");
  assert.match(shellResult.content[0]?.text ?? "", /shell\.txt/u);

  const manager = new UnifiedExecManager(spawnProcess);
  t.after(async () => manager.terminateAll());
  const execPatch =
    "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: exec.txt\n+exec\n*** End Patch\nPATCH";
  const execResult = await manager.execCommand(
    { cmd: execPatch, login: false, tty: true },
    runtimeContext(cwd),
    undefined,
    undefined,
  );
  assert.equal(await readFile(join(cwd, "exec.txt"), "utf8"), "exec\n");
  assert.match(execResult.content[0]?.text ?? "", /exec\.txt/u);
  assert.equal(execResult.details.sessionId, undefined);
  assert.equal(manager.activeSessionCount(), 0);
  assert.equal(spawnCalls, 0);

  let unsupportedShellSpawns = 0;
  const unsupportedShellManager = new UnifiedExecManager(() => {
    unsupportedShellSpawns++;
    const process = new FakeCommandProcess(false);
    queueMicrotask(() => process.complete(0));
    return process;
  });
  const unsupportedResult = await unsupportedShellManager.execCommand(
    {
      cmd: "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: ignored.txt\n+ignored\n*** End Patch\nPATCH",
      shell: "/usr/bin/fish",
      yield_time_ms: 0,
    },
    runtimeContext(cwd),
    undefined,
    undefined,
  );
  assert.equal(unsupportedResult.details.exitCode, 0);
  assert.equal(unsupportedShellSpawns, 1);
  await assert.rejects(readFile(join(cwd, "ignored.txt"), "utf8"), /ENOENT/u);
});

test("fails closed on explicit malformed and implicit shell patches", async () => {
  let spawnCalls = 0;
  const spawnProcess: CommandProcessSpawner = () => {
    spawnCalls++;
    throw new Error("shell spawning must be bypassed");
  };
  await assert.rejects(
    executeShellCommand(
      {
        command:
          "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: broken.txt\nbroken\n*** End Patch\nPATCH",
        login: false,
      },
      runtimeContext(),
      undefined,
      undefined,
      spawnProcess,
    ),
    /Patch failed at instruction/u,
  );
  await assert.rejects(
    executeShellCommand(
      {
        command: "*** Begin Patch\n*** Add File: implicit.txt\n+implicit\n*** End Patch",
        login: false,
      },
      runtimeContext(),
      undefined,
      undefined,
      spawnProcess,
    ),
    /patch detected without explicit call to apply_patch/u,
  );
  assert.equal(spawnCalls, 0);
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

test("returns shell_command timeouts as successful results with captured output", async () => {
  const spawnProcess: CommandProcessSpawner = (options) => {
    const commandProcess = new FakeCommandProcess(false);
    options.onData("started\n");
    return commandProcess;
  };

  const result = await executeShellCommand(
    { command: "slow-command", login: false, timeout_ms: 5 },
    runtimeContext(),
    undefined,
    undefined,
    spawnProcess,
  );
  assert.equal(result.details.exitCode, 124);
  assert.match(result.content[0]?.text ?? "", /Exit code: 124/);
  assert.match(result.content[0]?.text ?? "", /started/);
  assert.match(result.content[0]?.text ?? "", /command timed out after 5 milliseconds/);
});

test("counts invalid UTF-8 output tokens from raw bytes like Codex", async () => {
  const output = new CommandOutputAccumulator("pi-codex-invalid-utf8-test");
  output.append(Buffer.from([0xff, 0xff, 0xff, 0xff]));
  output.finish();
  const snapshot = output.snapshot();
  await output.close();

  assert.equal(snapshot.originalTokenCount, 1);
  assert.equal(snapshot.details.originalTokenCount, 1);
  assert.equal(snapshot.text, "\uFFFD\uFFFD\uFFFD\uFFFD");
});

test("accepts zero as an immediate shell_command timeout through the legacy alias", async () => {
  let commandProcess: FakeCommandProcess | undefined;
  const result = await executeShellCommand(
    { command: "slow-command", login: false, timeout: 0 },
    runtimeContext(),
    undefined,
    undefined,
    (options) => {
      commandProcess = new FakeCommandProcess(false);
      options.onData("started\n");
      return commandProcess;
    },
  );

  assert.equal(result.details.exitCode, 124);
  assert.equal(commandProcess?.terminateCalls, 1);
  assert.match(result.content[0]?.text ?? "", /command timed out after 0 milliseconds/u);
});

test("prefixes numeric command argument failures like Codex", async () => {
  const spawnProcess: CommandProcessSpawner = () => {
    throw new Error("invalid timing values must fail before spawning");
  };
  await assert.rejects(
    executeShellCommand(
      { command: "pwd", timeout_ms: -1 },
      runtimeContext(),
      undefined,
      undefined,
      spawnProcess,
    ),
    /^Error: failed to parse function arguments: timeout_ms must not be negative\.$/u,
  );
  const manager = new UnifiedExecManager(spawnProcess);
  await assert.rejects(
    manager.execCommand({ cmd: "pwd", yield_time_ms: 1.5 }, runtimeContext(), undefined, undefined),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "failed to parse function arguments: yield_time_ms must be an integer.",
      );
      return true;
    },
  );
});

test("wraps unified exec spawn errors in the Codex template", async () => {
  const manager = new UnifiedExecManager(() => {
    throw new Error("node spawn failed");
  });
  await assert.rejects(
    manager.execCommand(
      { cmd: "broken-command", login: false },
      runtimeContext(),
      undefined,
      undefined,
    ),
    /^Error: exec_command failed for `broken-command`: node spawn failed$/u,
  );
});

test("gracefully terminates shell_command after cancellation", async () => {
  let commandProcess: FakeCommandProcess | undefined;
  let notifySpawned: (() => void) | undefined;
  const spawned = new Promise<void>((resolveSpawned) => {
    notifySpawned = resolveSpawned;
  });
  const abortController = new AbortController();
  const execution = executeShellCommand(
    { command: "long-command", login: false },
    runtimeContext(),
    abortController.signal,
    undefined,
    () => {
      commandProcess = new FakeCommandProcess(false);
      notifySpawned?.();
      return commandProcess;
    },
  );
  await spawned;
  abortController.abort();

  await assert.rejects(execution, /Command aborted/u);
  assert.deepEqual(commandProcess?.gracefulTerminationGraceMs, [50]);
  assert.equal(commandProcess?.terminateCalls, 0);
});

test("returns nonzero shell_command exits as successful results", async () => {
  const spawnProcess: CommandProcessSpawner = (options) => {
    const commandProcess = new FakeCommandProcess(false);
    queueMicrotask(() => {
      options.onData("failed\n");
      commandProcess.complete(7);
    });
    return commandProcess;
  };

  const result = await executeShellCommand(
    { command: "failing-command", login: false },
    runtimeContext(),
    undefined,
    undefined,
    spawnProcess,
  );
  assert.equal(result.details.exitCode, 7);
  assert.match(result.content[0]?.text ?? "", /Exit code: 7/);
  assert.match(result.content[0]?.text ?? "", /failed/);
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
      yield_time_ms: 0,
    },
    runtimeContext(),
    undefined,
    undefined,
  );
  const sessionId = started.details.sessionId;
  assert.ok(sessionId);
  assert.equal(processOptions?.tty, true);
  assert.equal(processOptions?.env["TERM"], "dumb");
  assert.equal(processOptions?.env["NO_COLOR"], "1");
  assert.equal(processOptions?.env["PAGER"], "cat");
  assert.equal(processOptions?.env["CODEX_CI"], process.env["CODEX_CI"]);
  assert.deepEqual(manager.listProcesses(), [
    {
      sessionId,
      pid: 42,
      command: "interactive",
      cwd: process.cwd(),
      tty: true,
      running: true,
      recentOutput: "ready\n",
    },
  ]);
  assert.equal(
    formatBackgroundProcesses(manager.listProcesses()),
    `Background terminals\n• session ${sessionId} · pid 42 · PTY · interactive\n  cwd: ${process.cwd()}`,
  );
  assert.match(started.content[0]?.text ?? "", /Process running with session ID/);
  assert.match(started.content[0]?.text ?? "", /ready/);

  const writeStartedAt = performance.now();
  const completed = await manager.writeStdin(
    {
      session_id: sessionId,
      chars: "hello\n",
      yield_time_ms: 0,
    },
    undefined,
    undefined,
  );
  assert.equal(completed.details.exitCode, 0);
  assert.equal(completed.details.sessionId, undefined);
  assert.match(completed.content[0]?.text ?? "", /received:hello/);
  assert.equal(manager.activeSessionCount(), 0);
  assert.ok(performance.now() - writeStartedAt >= 90);
});

test("uses Codex-prefixed write_stdin session errors", async (t) => {
  const manager = new UnifiedExecManager(() => new FakeCommandProcess(false));
  t.after(async () => manager.terminateAll());

  await assert.rejects(
    manager.writeStdin({ session_id: 12_345 }, undefined, undefined),
    /write_stdin failed: Unknown exec_command session ID 12345\./u,
  );

  const started = await manager.execCommand(
    { cmd: "non-tty", login: false, yield_time_ms: 0 },
    runtimeContext(),
    undefined,
    undefined,
  );
  assert.ok(started.details.sessionId);
  await assert.rejects(
    manager.writeStdin(
      { session_id: started.details.sessionId, chars: "input", yield_time_ms: 0 },
      undefined,
      undefined,
    ),
    /write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open/u,
  );
});

test("formats empty and bounded background terminal listings", () => {
  assert.equal(formatBackgroundProcesses([]), "No background terminals running.");
  const processes = Array.from({ length: 18 }, (_, index) => ({
    sessionId: 1_000 + index,
    pid: 2_000 + index,
    command: `printf ${index}\nwith more`,
    cwd: `/tmp/process-${index}`,
    tty: index % 2 === 0,
    running: true,
    recentOutput: `output ${index}`,
  }));
  const listing = formatBackgroundProcesses(processes);
  assert.match(listing, /session 1000 · pid 2000 · PTY · printf 0 with more/u);
  assert.match(listing, /session 1001 · pid 2001 · pipes/u);
  assert.doesNotMatch(listing, /session 1016/u);
  assert.match(listing, /\.\.\. and 2 more running$/u);
});

test("matches Codex's protected, exited-first, and interaction-safe pruning policy", () => {
  const candidates = Array.from({ length: 12 }, (_, index) => ({
    id: index + 1,
    lastUsed: index + 1,
    exited: false,
    interactionActive: false,
  }));
  const updateCandidate = (index: number, update: Partial<(typeof candidates)[number]>): void => {
    const candidate = candidates[index];
    assert.ok(candidate);
    candidates[index] = { ...candidate, ...update };
  };

  assert.equal(unifiedExecProcessIdToPrune(candidates), 1);
  updateCandidate(2, { exited: true });
  updateCandidate(11, { exited: true });
  assert.equal(unifiedExecProcessIdToPrune(candidates), 3);

  updateCandidate(2, { interactionActive: true });
  assert.equal(unifiedExecProcessIdToPrune(candidates), undefined);

  updateCandidate(2, { exited: false });
  updateCandidate(0, { interactionActive: true });
  assert.equal(unifiedExecProcessIdToPrune(candidates), 2);
});

test("inspects and safely stops background terminals from the ps browser", () => {
  const actions: unknown[] = [];
  const processInfo = {
    sessionId: 1_234,
    pid: 4_321,
    command: "sleep 30",
    cwd: "/tmp/project",
    tty: true,
    running: true,
    recentOutput: "ready\n",
  };
  const browser = createBackgroundProcessBrowser(
    [processInfo],
    {
      bold: (text) => text,
      fg: (_color, text) => text,
    },
    (action) => actions.push(action),
    () => {},
  );

  browser.handleInput?.("\r");
  assert.deepEqual(actions, [{ type: "inspect", sessionId: 1_234 }]);
  actions.length = 0;

  browser.handleInput?.("\u0018");
  assert.deepEqual(actions, [{ type: "stop", sessionId: 1_234 }]);
  actions.length = 0;

  browser.handleInput?.("\u0013");
  assert.deepEqual(actions, [{ type: "stop-all" }]);
  actions.length = 0;

  browser.handleInput?.("s");
  assert.deepEqual(actions, []);
});

test("shows live recent output in a scrollable terminal details popup", (t) => {
  const actions: string[] = [];
  let recentOutput = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
  const details = createBackgroundProcessDetails(
    () => ({
      sessionId: 1_234,
      pid: 4_321,
      command: "long-running-command",
      cwd: "/tmp/project",
      tty: true,
      running: true,
      recentOutput,
    }),
    {
      bold: (text) => text,
      fg: (_color, text) => text,
    },
    (action) => actions.push(action),
    () => {},
  );
  t.after(() => details.dispose());

  const initial = details.render(80).join("\n");
  assert.doesNotMatch(initial, /line 0$/mu);
  assert.match(initial, /line 19$/mu);

  details.handleInput?.("\u001b[H");
  const scrolled = details.render(80).join("\n");
  assert.match(scrolled, /line 0$/mu);
  assert.doesNotMatch(scrolled, /line 19$/mu);

  recentOutput += "\nline 20";
  details.handleInput?.("\u001b[F");
  assert.match(details.render(80).join("\n"), /line 20$/mu);

  details.handleInput?.("\u0018");
  assert.deepEqual(actions, ["stop"]);
});

test("preserves an initially cancelled unified exec process and exposes its session ID", async (t) => {
  let commandProcess: FakeCommandProcess | undefined;
  let notifySpawned: (() => void) | undefined;
  const spawned = new Promise<void>((resolveSpawned) => {
    notifySpawned = resolveSpawned;
  });
  const spawnProcess: CommandProcessSpawner = (options) => {
    commandProcess = new FakeCommandProcess(false);
    options.onData("started\n");
    notifySpawned?.();
    return commandProcess;
  };
  const manager = new UnifiedExecManager(spawnProcess);
  t.after(async () => manager.terminateAll());
  const abortController = new AbortController();
  const execution = manager.execCommand(
    { cmd: "background-command", login: false, yield_time_ms: 30_000 },
    runtimeContext(),
    abortController.signal,
    undefined,
  );
  await spawned;
  abortController.abort();

  let sessionId: number | undefined;
  await assert.rejects(execution, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Command aborted; process continues with session ID \d+\./);
    const match = /session ID (\d+)/u.exec(error.message);
    sessionId = match ? Number(match[1]) : undefined;
    return true;
  });
  assert.ok(sessionId);
  assert.equal(commandProcess?.terminateCalls, 0);
  assert.equal(manager.activeSessionCount(), 1);

  commandProcess?.complete(0);
  const completed = await manager.writeStdin(
    { session_id: sessionId, yield_time_ms: 5_000 },
    undefined,
    undefined,
  );
  assert.equal(completed.details.exitCode, 0);
  assert.equal(manager.activeSessionCount(), 0);
});

test("stops a process safely while its initial exec_command call is active", async () => {
  let notifySpawned: (() => void) | undefined;
  const spawned = new Promise<void>((resolveSpawned) => {
    notifySpawned = resolveSpawned;
  });
  const spawnProcess: CommandProcessSpawner = (options) => {
    const commandProcess = new FakeCommandProcess(false);
    options.onData("started\n");
    notifySpawned?.();
    return commandProcess;
  };
  const manager = new UnifiedExecManager(spawnProcess);
  const execution = manager.execCommand(
    { cmd: "long-command", login: false, yield_time_ms: 30_000 },
    runtimeContext(),
    undefined,
    undefined,
  );
  await spawned;

  const stopping = manager.terminateAll();
  const result = await execution;
  await stopping;

  assert.equal(result.details.exitCode, -1);
  assert.equal(result.details.sessionId, undefined);
  assert.match(result.content[0]?.text ?? "", /started/);
  assert.equal(manager.activeSessionCount(), 0);
});

test("terminates one selected background terminal without stopping the others", async (t) => {
  const commandProcesses: FakeCommandProcess[] = [];
  const manager = new UnifiedExecManager((options) => {
    const commandProcess = new FakeCommandProcess(false);
    commandProcesses.push(commandProcess);
    options.onData(`started ${commandProcesses.length}\n`);
    return commandProcess;
  });
  t.after(async () => manager.terminateAll());

  const first = await manager.execCommand(
    { cmd: "first", login: false, yield_time_ms: 250 },
    runtimeContext(),
    undefined,
    undefined,
  );
  const second = await manager.execCommand(
    { cmd: "second", login: false, yield_time_ms: 250 },
    runtimeContext(),
    undefined,
    undefined,
  );
  assert.ok(first.details.sessionId);
  assert.ok(second.details.sessionId);

  assert.equal(await manager.terminateProcess(first.details.sessionId), true);
  assert.equal(commandProcesses[0]?.terminateCalls, 1);
  assert.equal(commandProcesses[1]?.terminateCalls, 0);
  assert.deepEqual(
    manager.listProcesses().map((process) => process.sessionId),
    [second.details.sessionId],
  );
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
      cmd: 'printf \'term:%s no-color:%s pager:%s\\n\' "$TERM" "$NO_COLOR" "$PAGER"; printf \'ready\\n\'; read value; printf \'received:%s\\n\' "$value"',
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
  assert.match(started.content[0]?.text ?? "", /term:dumb no-color:1 pager:cat/);
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
