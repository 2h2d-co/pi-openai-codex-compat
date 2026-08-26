import { constants, accessSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { posix, win32 } from "node:path";

export type CommandShellType = "zsh" | "bash" | "powershell" | "sh" | "cmd";

export type ResolvedCommandShell = {
  type: CommandShellType;
  path: string;
};

export type CommandShellCatalog = {
  defaultShell: ResolvedCommandShell;
  availableShells: ResolvedCommandShell[];
};

export function commandShellDisplayName(shell: ResolvedCommandShell): string {
  return shell.type === "powershell" ? "PowerShell" : shell.type;
}

export type CommandShellResolutionHost = {
  platform: NodeJS.Platform;
  pathEnvironment?: string;
  pathExtensions?: string;
  homeDirectory?: string;
  userShell: () => string | undefined;
  fileExists: (path: string) => boolean;
  executableExists: (path: string) => boolean;
};

export function codexCommandInvocation(
  shell: ResolvedCommandShell,
  command: string,
  login: boolean,
): string[] {
  if (shell.type === "powershell") {
    return [shell.path, ...(login ? [] : ["-NoProfile"]), "-Command", command];
  }
  if (shell.type === "cmd") return [shell.path, "/c", command];
  return [shell.path, login ? "-lc" : "-c", command];
}

function environmentValue(name: string): string | undefined {
  const entry = Object.entries(process.env).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return entry?.[1];
}

function defaultHost(): CommandShellResolutionHost {
  const pathEnvironment =
    process.platform === "win32" ? environmentValue("PATH") : process.env["PATH"];
  const pathExtensions = process.platform === "win32" ? environmentValue("PATHEXT") : undefined;
  return {
    platform: process.platform,
    homeDirectory: homedir(),
    ...(pathEnvironment === undefined ? {} : { pathEnvironment }),
    ...(pathExtensions === undefined ? {} : { pathExtensions }),
    userShell: () => {
      if (process.platform === "win32") return undefined;
      try {
        return userInfo().shell || undefined;
      } catch (error) {
        void error;
        return undefined;
      }
    },
    fileExists: (path) => {
      try {
        return statSync(path).isFile();
      } catch (error) {
        void error;
        return false;
      }
    },
    executableExists: (path) => {
      try {
        if (!statSync(path).isFile()) return false;
        accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return true;
      } catch (error) {
        void error;
        return false;
      }
    },
  };
}

function pathImplementation(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

export function detectCommandShellType(
  shellPath: string,
  platform: NodeJS.Platform = process.platform,
): CommandShellType | undefined {
  const paths = pathImplementation(platform);
  let candidate = shellPath;
  for (;;) {
    if (
      candidate === "zsh" ||
      candidate === "bash" ||
      candidate === "powershell" ||
      candidate === "sh" ||
      candidate === "cmd"
    ) {
      return candidate;
    }
    if (candidate === "pwsh") return "powershell";

    const basename = paths.basename(candidate);
    const extension = paths.extname(basename);
    const stem =
      extension.length > 0 && basename.length > extension.length
        ? basename.slice(0, -extension.length)
        : basename;
    if (stem === candidate) return undefined;
    candidate = stem;
  }
}

function findExecutable(binaryName: string, host: CommandShellResolutionHost): string | undefined {
  if (host.pathEnvironment === undefined) return undefined;
  const paths = pathImplementation(host.platform);
  const separator = host.platform === "win32" ? ";" : ":";
  const pathEntries = host.pathEnvironment.split(separator);
  const configuredExtensions =
    host.platform === "win32" && !paths.extname(binaryName)
      ? (host.pathExtensions ?? "").split(";").filter((extension) => extension.startsWith("."))
      : [];
  const extensions = configuredExtensions.length === 0 ? [""] : configuredExtensions;

  for (const rawEntry of pathEntries) {
    const entry =
      host.platform === "win32" && rawEntry.startsWith('"') && rawEntry.endsWith('"')
        ? rawEntry.slice(1, -1)
        : rawEntry;
    const tildePrefix = `~${paths.sep}`;
    const hasTildePrefix =
      entry.startsWith(tildePrefix) || (host.platform === "win32" && entry.startsWith("~/"));
    const directory =
      host.homeDirectory !== undefined && (entry === "~" || hasTildePrefix)
        ? paths.join(host.homeDirectory, entry.slice(entry === "~" ? 1 : 2))
        : entry;
    for (const extension of extensions) {
      const candidate = paths.join(directory, `${binaryName}${extension}`);
      if (host.executableExists(candidate)) return candidate;
    }
  }
  return undefined;
}

function getShellPath(
  type: CommandShellType,
  binaryName: string,
  fallbackPaths: readonly string[],
  host: CommandShellResolutionHost,
): string | undefined {
  const userShell = host.userShell();
  if (
    userShell !== undefined &&
    detectCommandShellType(userShell, host.platform) === type &&
    host.fileExists(userShell)
  ) {
    return userShell;
  }

  const executable = findExecutable(binaryName, host);
  if (executable !== undefined) return executable;
  return fallbackPaths.find((path) => host.fileExists(path));
}

function getShell(
  type: CommandShellType,
  host: CommandShellResolutionHost,
): ResolvedCommandShell | undefined {
  let path: string | undefined;
  switch (type) {
    case "zsh":
      path = getShellPath(type, "zsh", ["/bin/zsh"], host);
      break;
    case "bash":
      path = getShellPath(type, "bash", ["/bin/bash", "/usr/bin/bash"], host);
      break;
    case "sh":
      path = getShellPath(type, "sh", ["/bin/sh"], host);
      break;
    case "powershell":
      path =
        getShellPath(
          type,
          "pwsh",
          host.platform === "win32"
            ? [String.raw`C:\Program Files\PowerShell\7\pwsh.exe`]
            : ["/usr/local/bin/pwsh"],
          host,
        ) ??
        getShellPath(
          type,
          "powershell",
          host.platform === "win32"
            ? [String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`]
            : [],
          host,
        );
      break;
    case "cmd":
      path = getShellPath(type, "cmd", [], host);
      break;
  }
  return path === undefined ? undefined : { type, path };
}

function ultimateFallbackShell(platform: NodeJS.Platform): ResolvedCommandShell {
  return platform === "win32" ? { type: "cmd", path: "cmd.exe" } : { type: "sh", path: "/bin/sh" };
}

export function resolveDefaultCommandShell(
  host: CommandShellResolutionHost = defaultHost(),
): ResolvedCommandShell {
  if (host.platform === "win32") {
    return getShell("powershell", host) ?? ultimateFallbackShell(host.platform);
  }

  const userShellType = host.userShell();
  const resolvedUserShell =
    userShellType === undefined
      ? undefined
      : (() => {
          const type = detectCommandShellType(userShellType, host.platform);
          return type === undefined ? undefined : getShell(type, host);
        })();
  const resolvedFallback =
    host.platform === "darwin"
      ? (resolvedUserShell ?? getShell("zsh", host) ?? getShell("bash", host))
      : (resolvedUserShell ?? getShell("bash", host) ?? getShell("zsh", host));
  return resolvedFallback ?? ultimateFallbackShell(host.platform);
}

export function resolveCommandShellCatalog(
  host: CommandShellResolutionHost = defaultHost(),
): CommandShellCatalog {
  const defaultShell = resolveDefaultCommandShell(host);
  const types: readonly CommandShellType[] =
    host.platform === "win32" ? ["powershell", "cmd"] : ["zsh", "bash", "sh"];
  const availableShells: ResolvedCommandShell[] = [];
  const seen = new Set<string>();
  for (const shell of [defaultShell, ...types.map((type) => getShell(type, host))]) {
    if (shell === undefined) continue;
    const key = `${shell.type}\0${shell.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    availableShells.push(shell);
  }
  return { defaultShell, availableShells };
}

export function resolveCommandShell(
  requestedShell: string | undefined,
  host: CommandShellResolutionHost = defaultHost(),
): ResolvedCommandShell {
  if (requestedShell === undefined) return resolveDefaultCommandShell(host);
  const type = detectCommandShellType(requestedShell, host.platform);
  return (
    (type === undefined ? undefined : getShell(type, host)) ?? ultimateFallbackShell(host.platform)
  );
}
