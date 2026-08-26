import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { constants as osConstants } from "node:os";
import { basename, resolve } from "node:path";
import { spawn as spawnChild, type ChildProcess, type SpawnOptions } from "node:child_process";
import { getShellConfig, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn as spawnPty, type IPty } from "node-pty";

const EXIT_STDIO_GRACE_MS = 100;

export type CommandProcessExit = {
  exitCode: number | null;
  signal?: number | string;
};

export interface CommandProcess {
  readonly pid: number;
  readonly tty: boolean;
  readonly exited: Promise<CommandProcessExit>;
  hasExited: () => boolean;
  exitCode: () => number | null | undefined;
  write: (chars: string) => void;
  interrupt: () => void;
  terminate: () => void;
  terminateGracefully: (graceMs: number) => Promise<void>;
}

export type CommandProcessOptions = {
  command: string;
  cwd: string;
  shell?: string;
  login: boolean;
  tty: boolean;
  env: NodeJS.ProcessEnv;
  onData: (data: Buffer | string) => void;
};

export type CommandProcessSpawner = (options: CommandProcessOptions) => CommandProcess;

export type CommandEnvironmentContext = Pick<ExtensionContext, "model" | "thinkingLevel"> & {
  sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionFile" | "getSessionId">;
};

const UNIFIED_EXEC_ENVIRONMENT: Readonly<Record<string, string>> = {
  NO_COLOR: "1",
  TERM: "dumb",
  LANG: "C.UTF-8",
  LC_CTYPE: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  COLORTERM: "",
  PAGER: "cat",
  GIT_PAGER: "cat",
  GH_PAGER: "cat",
};

function isLegacyWslBashPath(path: string): boolean {
  const normalized = path.replaceAll("/", "\\").toLowerCase();
  return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/u.test(normalized);
}

export function resolveDefaultCommandShell(): string {
  return getShellConfig().shell;
}

export function commandArguments(shell: string, command: string, login: boolean): string[] {
  if (isLegacyWslBashPath(shell)) return ["-s"];
  const name = basename(shell).toLowerCase();
  if (
    name === "powershell" ||
    name === "powershell.exe" ||
    name === "pwsh" ||
    name === "pwsh.exe"
  ) {
    return login
      ? ["-NoLogo", "-Command", command]
      : ["-NoLogo", "-NoProfile", "-Command", command];
  }
  if (name === "cmd" || name === "cmd.exe") return ["/c", command];
  return [login ? "-lc" : "-c", command];
}

function definedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function quotePosixShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, signal);
    } else {
      process.kill(pid, signal);
    }
  } catch (groupError) {
    try {
      process.kill(pid, signal);
    } catch (processError) {
      // The process already exited.
      void groupError;
      void processError;
    }
  }
}

function conventionalSignalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === null) return -1;
  const signalNumber = osConstants.signals[signal];
  return signalNumber === undefined ? -1 : 128 + signalNumber;
}

export function terminateProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawnChild("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      }).unref();
    } catch (error) {
      void error;
      signalProcess(pid, "SIGKILL");
    }
    return;
  }
  signalProcess(pid, "SIGKILL");
}

async function waitForExitOrGrace(
  exited: Promise<CommandProcessExit>,
  graceMs: number,
): Promise<void> {
  await Promise.race([
    exited.then(
      () => undefined,
      (error: unknown) => {
        void error;
      },
    ),
    new Promise<void>((resolveWait) => setTimeout(resolveWait, graceMs)),
  ]);
}

async function terminateGracefully(
  pid: number,
  exited: Promise<CommandProcessExit>,
  hardTerminate: () => void,
  graceMs: number,
): Promise<void> {
  if (pid <= 0) return;
  signalProcess(pid, "SIGTERM");
  await waitForExitOrGrace(exited, graceMs);
  // Match Codex's process-group cleanup: even when the direct shell exits
  // during the grace period, kill descendants left in its original group.
  hardTerminate();
}

class PlainCommandProcess implements CommandProcess {
  readonly tty = false;
  readonly pid: number;
  readonly exited: Promise<CommandProcessExit>;
  private readonly child: ChildProcess;
  private settled = false;
  private observedExitCode: number | null | undefined;

  constructor(options: CommandProcessOptions, shell: string, args: string[]) {
    const commandFromStdin = isLegacyWslBashPath(shell);
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: options.env,
      stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    };
    this.child = spawnChild(shell, args, spawnOptions);
    this.pid = this.child.pid ?? 0;
    if (commandFromStdin) this.child.stdin?.end(options.command);
    this.child.stdout?.on("data", options.onData);
    this.child.stderr?.on("data", options.onData);
    this.exited = this.waitForExit();
  }

  hasExited(): boolean {
    return this.settled;
  }

  exitCode(): number | null | undefined {
    if (this.observedExitCode !== undefined) return this.observedExitCode;
    return this.child.exitCode ?? undefined;
  }

  write(_chars: string): void {
    throw new Error("stdin is closed for a non-TTY exec_command session.");
  }

  interrupt(): void {
    if (this.pid > 0) signalProcess(this.pid, "SIGINT");
  }

  terminate(): void {
    if (this.pid > 0) terminateProcessTree(this.pid);
  }

  terminateGracefully(graceMs: number): Promise<void> {
    if (this.settled) return Promise.resolve();
    return terminateGracefully(this.pid, this.exited, () => this.terminate(), graceMs);
  }

  private waitForExit(): Promise<CommandProcessExit> {
    return new Promise((resolveExit, reject) => {
      let exited = false;
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let stdoutEnded = this.child.stdout === null;
      let stderrEnded = this.child.stderr === null;
      let postExitTimer: NodeJS.Timeout | undefined;

      const cleanup = (): void => {
        if (postExitTimer) clearTimeout(postExitTimer);
        this.child.removeListener("error", onError);
        this.child.removeListener("exit", onExit);
        this.child.removeListener("close", onClose);
        this.child.stdout?.removeListener("end", onStdoutEnd);
        this.child.stderr?.removeListener("end", onStderrEnd);
        this.child.stdout?.removeListener("data", armIdleTimer);
        this.child.stderr?.removeListener("data", armIdleTimer);
      };
      const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (this.settled) return;
        this.settled = true;
        this.observedExitCode = code ?? conventionalSignalExitCode(signal);
        cleanup();
        this.child.stdout?.destroy();
        this.child.stderr?.destroy();
        resolveExit({
          exitCode: this.observedExitCode,
          ...(signal === null ? {} : { signal }),
        });
      };
      const maybeFinish = (): void => {
        if (exited && stdoutEnded && stderrEnded) finish(exitCode, exitSignal);
      };
      const armIdleTimer = (): void => {
        if (!exited || this.settled) return;
        if (postExitTimer) clearTimeout(postExitTimer);
        postExitTimer = setTimeout(() => finish(exitCode, exitSignal), EXIT_STDIO_GRACE_MS);
      };
      const onStdoutEnd = (): void => {
        stdoutEnded = true;
        maybeFinish();
      };
      const onStderrEnd = (): void => {
        stderrEnded = true;
        maybeFinish();
      };
      const onError = (error: Error): void => {
        if (this.settled) return;
        this.settled = true;
        cleanup();
        reject(error);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        exited = true;
        exitCode = code;
        exitSignal = signal;
        maybeFinish();
        armIdleTimer();
      };
      const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        finish(code, signal);
      };

      this.child.stdout?.once("end", onStdoutEnd);
      this.child.stderr?.once("end", onStderrEnd);
      this.child.stdout?.on("data", armIdleTimer);
      this.child.stderr?.on("data", armIdleTimer);
      this.child.once("error", onError);
      this.child.once("exit", onExit);
      this.child.once("close", onClose);
    });
  }
}

class PtyCommandProcess implements CommandProcess {
  readonly tty = true;
  readonly pid: number;
  readonly exited: Promise<CommandProcessExit>;
  private readonly process: IPty;
  private settled = false;
  private observedExitCode: number | undefined;

  constructor(options: CommandProcessOptions, shell: string, args: string[]) {
    const useLauncher = process.platform !== "win32";
    const readyVariable = "PI_CODEX_PTY_LAUNCH_READY";
    const readyMarker = `pi-codex-pty-${randomBytes(16).toString("hex")}`;
    const environment = definedEnvironment({
      ...options.env,
      ...(useLauncher ? { [readyVariable]: readyMarker } : {}),
    });
    this.process = spawnPty(useLauncher ? "/bin/sh" : shell, useLauncher ? ["-s"] : args, {
      cols: 80,
      cwd: options.cwd,
      env: environment,
      name: environment["TERM"] || "xterm-256color",
      rows: 24,
    });
    this.pid = this.process.pid;
    let ready = !useLauncher;
    let pending = "";
    this.process.onData((data) => {
      if (ready) {
        options.onData(data);
        return;
      }
      const combined = pending + data;
      const markerIndex = combined.indexOf(readyMarker);
      if (markerIndex === -1) {
        pending = combined.slice(-Math.max(0, readyMarker.length - 1));
        return;
      }
      ready = true;
      pending = "";
      const output = combined.slice(markerIndex + readyMarker.length);
      if (output) options.onData(output);
    });
    this.exited = new Promise((resolveExit) => {
      this.process.onExit((event) => {
        this.settled = true;
        this.observedExitCode = event.exitCode;
        resolveExit({
          exitCode: event.exitCode,
          ...(event.signal === undefined ? {} : { signal: event.signal }),
        });
      });
    });
    if (useLauncher) {
      const command = [shell, ...args].map(quotePosixShellArgument).join(" ");
      this.process.write(
        `marker="$${readyVariable}"; unset ${readyVariable}; printf %s "$marker"; exec ${command}\n`,
      );
    }
  }

  hasExited(): boolean {
    return this.settled;
  }

  exitCode(): number | undefined {
    return this.observedExitCode;
  }

  write(chars: string): void {
    if (this.settled) throw new Error("Cannot write to an exited exec_command session.");
    this.process.write(chars);
  }

  interrupt(): void {
    if (!this.settled) this.process.write("\u0003");
  }

  terminate(): void {
    if (this.settled) return;
    terminateProcessTree(this.pid);
    this.process.kill();
  }

  terminateGracefully(graceMs: number): Promise<void> {
    if (this.settled) return Promise.resolve();
    return terminateGracefully(this.pid, this.exited, () => this.terminate(), graceMs);
  }
}

export const spawnCommandProcess: CommandProcessSpawner = (options) => {
  const shell = options.shell?.trim() || resolveDefaultCommandShell();
  const args = commandArguments(shell, options.command, options.login);
  return options.tty
    ? new PtyCommandProcess(options, shell, args)
    : new PlainCommandProcess(options, shell, args);
};

export async function resolveCommandWorkingDirectory(
  cwd: string,
  workdir: string | undefined,
): Promise<string> {
  const target = workdir?.trim() ? resolve(cwd, workdir) : cwd;
  try {
    await access(target, constants.F_OK);
  } catch (error) {
    throw new Error(`Working directory does not exist: ${target}`, { cause: error });
  }
  return target;
}

export function commandEnvironment(ctx: CommandEnvironmentContext): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment["PI_SESSION_ID"];
  delete environment["PI_SESSION_FILE"];
  delete environment["PI_PROVIDER"];
  delete environment["PI_MODEL"];
  delete environment["PI_REASONING_LEVEL"];

  environment["PI_SESSION_ID"] = ctx.sessionManager.getSessionId();
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (sessionFile) environment["PI_SESSION_FILE"] = sessionFile;
  if (ctx.model) {
    environment["PI_PROVIDER"] = ctx.model.provider;
    environment["PI_MODEL"] = ctx.model.id;
  }
  if (ctx.thinkingLevel) environment["PI_REASONING_LEVEL"] = ctx.thinkingLevel;
  return environment;
}

export function unifiedExecEnvironment(ctx: CommandEnvironmentContext): NodeJS.ProcessEnv {
  return {
    ...commandEnvironment(ctx),
    ...UNIFIED_EXEC_ENVIRONMENT,
  };
}
