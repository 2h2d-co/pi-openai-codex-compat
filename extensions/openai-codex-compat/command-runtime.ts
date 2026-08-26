import { randomBytes } from "node:crypto";
import type { AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  commandEnvironment,
  resolveCommandWorkingDirectory,
  spawnCommandProcess,
  unifiedExecEnvironment,
  type CommandEnvironmentContext,
  type CommandProcess,
  type CommandProcessSpawner,
} from "./command-process.ts";
import {
  CommandOutputAccumulator,
  RecentCommandOutputBuffer,
  type CommandOutputDetails,
  type CommandOutputSnapshot,
} from "./command-output.ts";
import { errorFromThrown } from "./error-from-thrown.ts";

const DEFAULT_EXEC_YIELD_TIME_MS = 10_000;
const DEFAULT_WRITE_YIELD_TIME_MS = 250;
const DEFAULT_SHELL_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const MIN_YIELD_TIME_MS = 250;
const MIN_EMPTY_POLL_MS = 5_000;
const MAX_YIELD_TIME_MS = 30_000;
const MAX_EMPTY_POLL_MS = 300_000;
const WINDOWS_INITIAL_YIELD_FLOOR_MS = 10_000;
const MAX_PROCESSES = 64;
const UPDATE_THROTTLE_MS = 100;
const POST_PTY_WRITE_DELAY_MS = 100;
const CANCELLATION_TERMINATION_GRACE_MS = 50;
const INTERRUPT = "\u0003";
const MAX_TIMEOUT_MS = 2_147_483_647;

export type CommandRuntimeContext = Pick<ExtensionContext, "cwd"> & CommandEnvironmentContext;

export type ExecCommandRequest = {
  cmd: string;
  workdir?: string;
  tty?: boolean;
  yield_time_ms?: number;
  max_output_tokens?: number;
  shell?: string;
  login?: boolean;
};

export type WriteStdinRequest = {
  session_id: number;
  chars?: string;
  yield_time_ms?: number;
  max_output_tokens?: number;
};

export type ShellCommandRequest = {
  command: string;
  workdir?: string;
  timeout_ms?: number;
  timeout?: number;
  login?: boolean;
};

export type CommandToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: CommandOutputDetails;
};

export type UnifiedExecProcessInfo = {
  sessionId: number;
  pid: number;
  command: string;
  cwd: string;
  tty: boolean;
  running: boolean;
  exitCode?: number;
  recentOutput: string;
};

type UnifiedExecRecord = {
  id: number;
  command: string;
  cwd: string;
  process: CommandProcess;
  output: CommandOutputAccumulator;
  recentOutput: RecentCommandOutputBuffer;
  lastUsed: number;
  interaction: Promise<void>;
  initialInteractionDone: Promise<void>;
  finishInitialInteraction: () => void;
};

class CommandAbortedError extends Error {
  constructor() {
    super("Command aborted");
  }
}

function requiredInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be an integer.`);
  }
  return value;
}

function nonnegativeInteger(name: string, value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const integer = requiredInteger(name, value);
  if (integer < 0) throw new Error(`${name} must not be negative.`);
  return integer;
}

// Codex's timing fields accept zero before the effective wait is clamped.
function positiveInteger(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const integer = requiredInteger(name, value);
  if (integer < 0) throw new Error(`${name} must not be negative.`);
  return integer;
}

function timeout(value: number | undefined): number {
  const timeoutMs = positiveInteger("timeout_ms", value, DEFAULT_SHELL_TIMEOUT_MS);
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`timeout_ms must not exceed ${MAX_TIMEOUT_MS}.`);
  }
  return timeoutMs;
}

function initialYieldTime(value: number | undefined): number {
  const requested = positiveInteger("yield_time_ms", value, DEFAULT_EXEC_YIELD_TIME_MS);
  const floor = process.platform === "win32" ? WINDOWS_INITIAL_YIELD_FLOOR_MS : MIN_YIELD_TIME_MS;
  return Math.min(MAX_YIELD_TIME_MS, Math.max(floor, requested));
}

function writeYieldTime(value: number | undefined, empty: boolean): number {
  const requested = positiveInteger("yield_time_ms", value, DEFAULT_WRITE_YIELD_TIME_MS);
  return empty
    ? Math.min(MAX_EMPTY_POLL_MS, Math.max(MIN_EMPTY_POLL_MS, requested))
    : Math.min(MAX_YIELD_TIME_MS, Math.max(MIN_YIELD_TIME_MS, requested));
}

function chunkId(): string {
  return randomBytes(3).toString("hex");
}

function appendStatus(output: string, status: string): string {
  return `${output ? `${output}\n\n` : ""}${status}`;
}

function formatShellResult(
  snapshot: CommandOutputSnapshot,
  exitCode: number,
  wallTimeSeconds: number,
  timeoutMs?: number,
): string {
  const output =
    timeoutMs === undefined
      ? snapshot.text
      : `command timed out after ${timeoutMs} milliseconds\n${snapshot.text}`;
  return [
    `Exit code: ${exitCode}`,
    `Wall time: ${wallTimeSeconds.toFixed(1)} seconds`,
    "Output:",
    output,
  ].join("\n");
}

function formatUnifiedExecResult(
  snapshot: CommandOutputSnapshot,
  metadata: {
    chunkId: string;
    exitCode?: number;
    sessionId?: number;
    wallTimeSeconds: number;
  },
): string {
  const sections = [
    `Chunk ID: ${metadata.chunkId}`,
    `Wall time: ${metadata.wallTimeSeconds.toFixed(4)} seconds`,
  ];
  if (metadata.exitCode !== undefined) {
    sections.push(`Process exited with code ${metadata.exitCode}`);
  }
  if (metadata.sessionId !== undefined) {
    sections.push(`Process running with session ID ${metadata.sessionId}`);
  }
  sections.push(`Original token count: ${snapshot.originalTokenCount}`, "Output:", snapshot.text);
  return sections.join("\n");
}

function waitForProcess(
  commandProcess: CommandProcess,
  waitMs: number,
  signal: AbortSignal | undefined,
): Promise<"exited" | "yielded"> {
  if (signal?.aborted) return Promise.reject(new CommandAbortedError());
  return new Promise((resolveWait, reject) => {
    const timer = setTimeout(() => finish("yielded"), waitMs);
    const onAbort = (): void => {
      cleanup();
      reject(new CommandAbortedError());
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (result: "exited" | "yielded"): void => {
      cleanup();
      resolveWait(result);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    void commandProcess.exited.then(
      () => finish("exited"),
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function streamUpdates(
  output: CommandOutputAccumulator,
  onUpdate: AgentToolUpdateCallback<CommandOutputDetails> | undefined,
  maxOutputTokens: number | undefined,
): () => void {
  if (!onUpdate) return () => {};
  onUpdate({ content: [], details: {} });
  let timer: NodeJS.Timeout | undefined;
  let dirty = false;
  let lastUpdateAt = 0;
  const emit = (): void => {
    if (!dirty) return;
    dirty = false;
    lastUpdateAt = Date.now();
    const snapshot = output.snapshot({
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      persistIfTruncated: true,
    });
    onUpdate({
      content: [{ type: "text", text: snapshot.text }],
      details: snapshot.details,
    });
  };
  const schedule = (): void => {
    dirty = true;
    const delay = UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
    if (delay <= 0) {
      if (timer) clearTimeout(timer);
      timer = undefined;
      emit();
      return;
    }
    timer ??= setTimeout(() => {
      timer = undefined;
      emit();
    }, delay);
  };
  const unsubscribe = output.subscribe(schedule);
  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
    emit();
  };
}

async function closeOutput(
  output: CommandOutputAccumulator,
  maxOutputTokens: number | undefined,
): Promise<CommandOutputSnapshot> {
  output.finish();
  const snapshot = output.snapshot({
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    persistIfTruncated: true,
  });
  await output.close();
  return snapshot;
}

async function settleTerminatedProcess(commandProcess: CommandProcess): Promise<void> {
  await Promise.race([
    commandProcess.exited.then(
      () => undefined,
      (error: unknown) => {
        void error;
      },
    ),
    new Promise<void>((resolveWait) => setTimeout(resolveWait, 1_000)),
  ]);
}

export async function executeShellCommand(
  request: ShellCommandRequest,
  ctx: CommandRuntimeContext,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<CommandOutputDetails> | undefined,
  spawnProcess: CommandProcessSpawner = spawnCommandProcess,
): Promise<CommandToolResult> {
  if (request.timeout_ms !== undefined && request.timeout !== undefined) {
    throw new Error("duplicate field `timeout_ms`");
  }
  const timeoutMs = timeout(request.timeout_ms ?? request.timeout);
  if (signal?.aborted) throw new Error("Command aborted", { cause: new CommandAbortedError() });
  const cwd = await resolveCommandWorkingDirectory(ctx.cwd, request.workdir);
  const output = new CommandOutputAccumulator("pi-codex-shell-command");
  const commandProcess = spawnProcess({
    command: request.command,
    cwd,
    env: commandEnvironment(ctx),
    login: request.login ?? true,
    onData: (data) => output.append(data),
    tty: false,
  });
  const startedAt = performance.now();
  const finishUpdates = streamUpdates(output, onUpdate, undefined);
  let timedOut = false;
  let aborted = false;
  let executionError: unknown;
  let processExit: Awaited<CommandProcess["exited"]> | undefined;
  try {
    const wait = await waitForProcess(commandProcess, timeoutMs, signal);
    if (wait === "yielded") {
      timedOut = true;
      commandProcess.terminate();
      await settleTerminatedProcess(commandProcess);
    } else {
      processExit = await commandProcess.exited;
    }
  } catch (error) {
    aborted = error instanceof CommandAbortedError;
    executionError = error;
    if (aborted) {
      await commandProcess.terminateGracefully(CANCELLATION_TERMINATION_GRACE_MS);
    } else {
      commandProcess.terminate();
    }
    await settleTerminatedProcess(commandProcess);
  } finally {
    finishUpdates();
  }

  const snapshot = await closeOutput(output, undefined);
  const wallTimeSeconds = (performance.now() - startedAt) / 1_000;
  const exitCode = timedOut ? 124 : (processExit?.exitCode ?? commandProcess.exitCode() ?? -1);
  const text = formatShellResult(
    snapshot,
    exitCode,
    wallTimeSeconds,
    timedOut ? timeoutMs : undefined,
  );
  if (executionError !== undefined) {
    if (aborted) {
      throw new Error(appendStatus(text, "Command aborted"), { cause: executionError });
    }
    const error = errorFromThrown(executionError, "Shell command failed with a non-Error value.");
    throw new Error(appendStatus(text, `execution error: ${error.message}`), {
      cause: executionError,
    });
  }
  return {
    content: [{ type: "text", text }],
    details: {
      ...snapshot.details,
      exitCode,
      wallTimeSeconds,
    },
  };
}

export class UnifiedExecManager {
  private readonly processes = new Map<number, UnifiedExecRecord>();
  private readonly spawnProcess: CommandProcessSpawner;
  private shuttingDown: Promise<void> | undefined;

  constructor(spawnProcess: CommandProcessSpawner = spawnCommandProcess) {
    this.spawnProcess = spawnProcess;
  }

  async execCommand(
    request: ExecCommandRequest,
    ctx: CommandRuntimeContext,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<CommandOutputDetails> | undefined,
  ): Promise<CommandToolResult> {
    const maxOutputTokens =
      nonnegativeInteger("max_output_tokens", request.max_output_tokens) ??
      DEFAULT_MAX_OUTPUT_TOKENS;
    const yieldTimeMs = initialYieldTime(request.yield_time_ms);
    if (signal?.aborted) throw new Error("Command aborted", { cause: new CommandAbortedError() });
    const cwd = await resolveCommandWorkingDirectory(ctx.cwd, request.workdir);
    if (signal?.aborted) throw new Error("Command aborted", { cause: new CommandAbortedError() });
    this.pruneProcesses();
    const id = this.allocateProcessId();
    const initialOutput = new CommandOutputAccumulator("pi-codex-exec-command");
    const recentOutput = new RecentCommandOutputBuffer();
    let record: UnifiedExecRecord | undefined;
    const commandProcess = this.spawnProcess({
      command: request.cmd,
      cwd,
      env: unifiedExecEnvironment(ctx),
      login: request.login ?? true,
      onData: (data) => {
        (record?.output ?? initialOutput).append(data);
        recentOutput.append(data);
      },
      ...(request.shell === undefined ? {} : { shell: request.shell }),
      tty: request.tty ?? false,
    });
    void commandProcess.exited.then(
      () => recentOutput.finish(),
      (error: unknown) => {
        void error;
        recentOutput.finish();
      },
    );
    let finishInitialInteraction = (): void => {};
    const initialInteractionDone = new Promise<void>((resolveInteraction) => {
      finishInitialInteraction = resolveInteraction;
    });
    record = {
      id,
      command: request.cmd,
      cwd,
      finishInitialInteraction,
      initialInteractionDone,
      interaction: Promise.resolve(),
      lastUsed: Date.now(),
      output: initialOutput,
      process: commandProcess,
      recentOutput,
    };
    this.processes.set(id, record);

    const startedAt = performance.now();
    const finishUpdates = streamUpdates(record.output, onUpdate, maxOutputTokens);
    try {
      try {
        await waitForProcess(commandProcess, yieldTimeMs, signal);
      } catch (error) {
        if (error instanceof CommandAbortedError) {
          const result = await this.completeInteraction(record, startedAt, maxOutputTokens);
          const sessionId = result.details.sessionId;
          throw new Error(
            appendStatus(
              result.content[0]?.text ?? "",
              sessionId === undefined
                ? "Command aborted after the process exited."
                : `Command aborted; process continues with session ID ${sessionId}.`,
            ),
            { cause: error },
          );
        }
        this.processes.delete(id);
        commandProcess.terminate();
        await settleTerminatedProcess(commandProcess);
        const snapshot = await this.drainOutput(record, maxOutputTokens);
        const executionError = errorFromThrown(
          error,
          "Unified exec failed with a non-Error value.",
        );
        throw new Error(
          appendStatus(
            formatUnifiedExecResult(snapshot, {
              chunkId: chunkId(),
              exitCode: commandProcess.exitCode() ?? -1,
              wallTimeSeconds: (performance.now() - startedAt) / 1_000,
            }),
            `execution error: ${executionError.message}`,
          ),
          { cause: error },
        );
      }
      const result = await this.completeInteraction(record, startedAt, maxOutputTokens);
      return result;
    } finally {
      finishUpdates();
      record.finishInitialInteraction();
    }
  }

  async writeStdin(
    request: WriteStdinRequest,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<CommandOutputDetails> | undefined,
  ): Promise<CommandToolResult> {
    const sessionId = requiredInteger("session_id", request.session_id);
    const record = this.processes.get(sessionId);
    if (!record) throw new Error(`Unknown exec_command session ID ${sessionId}.`);
    const execute = async (): Promise<CommandToolResult> => {
      record.lastUsed = Date.now();
      if (signal?.aborted) {
        throw new Error("write_stdin aborted; the exec_command session is still running.", {
          cause: new CommandAbortedError(),
        });
      }
      const chars = request.chars ?? "";
      const maxOutputTokens =
        nonnegativeInteger("max_output_tokens", request.max_output_tokens) ??
        DEFAULT_MAX_OUTPUT_TOKENS;
      const yieldTimeMs = writeYieldTime(request.yield_time_ms, chars.length === 0);
      if (chars && !record.process.hasExited()) {
        try {
          if (record.process.tty) {
            record.process.write(chars);
            await new Promise<void>((resolveDelay) =>
              setTimeout(resolveDelay, POST_PTY_WRITE_DELAY_MS),
            );
          } else if (chars === INTERRUPT) {
            record.process.interrupt();
          } else {
            throw new Error("stdin is closed for a non-TTY exec_command session.");
          }
        } catch (error) {
          if (!record.process.hasExited()) throw error;
        }
      }

      const startedAt = performance.now();
      const finishUpdates = streamUpdates(record.output, onUpdate, maxOutputTokens);
      try {
        await waitForProcess(record.process, yieldTimeMs, signal);
      } catch (error) {
        if (error instanceof CommandAbortedError) {
          throw new Error("write_stdin aborted; the exec_command session is still running.", {
            cause: error,
          });
        }
        this.processes.delete(record.id);
        record.process.terminate();
        await settleTerminatedProcess(record.process);
        const snapshot = await this.drainOutput(record, maxOutputTokens);
        const executionError = errorFromThrown(error, "write_stdin failed with a non-Error value.");
        throw new Error(
          appendStatus(
            formatUnifiedExecResult(snapshot, {
              chunkId: chunkId(),
              exitCode: record.process.exitCode() ?? -1,
              wallTimeSeconds: (performance.now() - startedAt) / 1_000,
            }),
            `execution error: ${executionError.message}`,
          ),
          { cause: error },
        );
      } finally {
        finishUpdates();
      }
      return this.completeInteraction(record, startedAt, maxOutputTokens);
    };

    const interaction = record.interaction.then(execute, (error: unknown) => {
      void error;
      return execute();
    });
    record.interaction = interaction.then(
      () => undefined,
      (error: unknown) => {
        void error;
      },
    );
    return interaction;
  }

  terminateAll(): Promise<void> {
    if (this.shuttingDown) return this.shuttingDown;
    const records = [...this.processes.values()];
    this.processes.clear();
    for (const record of records) record.process.terminate();
    this.shuttingDown = Promise.all(
      records.map(async (record) => {
        await settleTerminatedProcess(record.process);
        await record.initialInteractionDone;
        await record.interaction;
        record.output.finish();
        await record.output.close();
      }),
    )
      .then(() => undefined)
      .finally(() => {
        this.shuttingDown = undefined;
      });
    return this.shuttingDown;
  }

  async terminateProcess(sessionId: number): Promise<boolean> {
    const record = this.processes.get(sessionId);
    if (!record) return false;
    this.processes.delete(sessionId);
    record.process.terminate();
    await settleTerminatedProcess(record.process);
    await record.initialInteractionDone;
    await record.interaction;
    record.recentOutput.finish();
    record.output.finish();
    await record.output.close();
    return true;
  }

  activeSessionCount(): number {
    return this.processes.size;
  }

  observeProcess(sessionId: number): (() => UnifiedExecProcessInfo) | undefined {
    const record = this.processes.get(sessionId);
    return record ? () => this.processInfo(record) : undefined;
  }

  listProcesses(): UnifiedExecProcessInfo[] {
    return [...this.processes.values()]
      .filter((record) => !record.process.hasExited())
      .sort((left, right) => left.id - right.id)
      .map((record) => this.processInfo(record));
  }

  private async completeInteraction(
    record: UnifiedExecRecord,
    startedAt: number,
    maxOutputTokens: number,
  ): Promise<CommandToolResult> {
    const output = record.output;
    record.output = new CommandOutputAccumulator("pi-codex-exec-command");
    const done = record.process.hasExited();
    const exitCode = done ? (record.process.exitCode() ?? -1) : undefined;
    if (done) {
      this.processes.delete(record.id);
      record.recentOutput.finish();
    }
    const snapshot = await closeOutput(output, maxOutputTokens);
    const wallTimeSeconds = (performance.now() - startedAt) / 1_000;
    const metadata: CommandOutputDetails & {
      chunkId: string;
      wallTimeSeconds: number;
    } = {
      chunkId: chunkId(),
      wallTimeSeconds,
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(done ? {} : { sessionId: record.id }),
    };
    return {
      content: [{ type: "text", text: formatUnifiedExecResult(snapshot, metadata) }],
      details: {
        ...snapshot.details,
        ...metadata,
      },
    };
  }

  private async drainOutput(
    record: UnifiedExecRecord,
    maxOutputTokens: number,
  ): Promise<CommandOutputSnapshot> {
    const output = record.output;
    record.output = new CommandOutputAccumulator("pi-codex-exec-command");
    return closeOutput(output, maxOutputTokens);
  }

  private allocateProcessId(): number {
    for (;;) {
      const id = 1_000 + Math.floor(Math.random() * 99_000);
      if (!this.processes.has(id)) return id;
    }
  }

  private processInfo(record: UnifiedExecRecord): UnifiedExecProcessInfo {
    const running = !record.process.hasExited();
    const exitCode = record.process.exitCode();
    return {
      sessionId: record.id,
      pid: record.process.pid,
      command: record.command,
      cwd: record.cwd,
      tty: record.process.tty,
      running,
      ...(exitCode === undefined || exitCode === null ? {} : { exitCode }),
      recentOutput: record.recentOutput.snapshot(),
    };
  }

  private pruneProcesses(): void {
    if (this.processes.size < MAX_PROCESSES) return;
    const records = [...this.processes.values()].sort(
      (left, right) => left.lastUsed - right.lastUsed,
    );
    const record = records.find((candidate) => candidate.process.hasExited()) ?? records[0];
    if (!record) return;
    this.processes.delete(record.id);
    record.process.terminate();
    record.output.finish();
    record.output.close().catch((error: unknown) => {
      console.error("Could not close pruned exec_command output.", error);
    });
  }
}
