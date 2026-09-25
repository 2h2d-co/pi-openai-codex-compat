import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";

// Keep this provider-independent contract aligned with pi-anthropic-compat.
export type SettingValue = string | number | boolean | null;
export type SettingValues = Record<string, SettingValue>;
export type SettingChanges = Record<string, SettingValue | undefined>;
type Document = Record<string, unknown>;
type FileState = { text: string | undefined; data: Document };
function isDocument(value: unknown): value is Document {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export type SettingsSnapshot = {
  file: string;
  values: SettingValues;
  inherited: SettingValues;
  sources: Record<string, string>;
  global: FileState;
  project: FileState;
};

async function read(file: string): Promise<FileState> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { text: undefined, data: {} };
    }
    throw new Error(`Cannot read ${file}. Check file permissions.`, { cause: error });
  }
  try {
    const data: unknown = JSON.parse(text);
    if (!isDocument(data)) throw new Error("Expected an object.");
    return { text, data };
  } catch (error) {
    throw new Error(`Invalid settings in ${file}. Fix the JSON object and reopen the menu.`, {
      cause: error,
    });
  }
}

export class SettingsStore {
  readonly globalFile: string;
  readonly projectFile: string | undefined;
  readonly resolve: (global: Document, project: Document) => SettingValues;
  readonly locked: Record<string, string>;
  readonly normalize: (data: Document) => Document;
  constructor(
    globalFile: string,
    projectFile: string | undefined,
    resolve: (global: Document, project: Document) => SettingValues,
    locked: Record<string, string> = {},
    normalize: (data: Document) => Document = (data) => data,
  ) {
    this.globalFile = globalFile;
    this.projectFile = projectFile;
    this.resolve = resolve;
    this.locked = locked;
    this.normalize = normalize;
  }

  async load(): Promise<SettingsSnapshot> {
    const global = await read(this.globalFile);
    const project = this.projectFile ? await read(this.projectFile) : { text: undefined, data: {} };
    const isProject = this.projectFile !== undefined && project.text !== undefined;
    const globalData = this.normalize(global.data);
    const projectData = this.normalize(project.data);
    const values = this.resolve(global.data, project.data);
    const inherited = this.resolve(isProject ? global.data : {}, {});
    const sources: Record<string, string> = {};
    for (const id of Object.keys(values)) {
      sources[id] = this.locked[id]
        ? `locked by ${this.locked[id]}`
        : Object.hasOwn(projectData, id)
          ? "project"
          : Object.hasOwn(globalData, id)
            ? "global"
            : "default";
    }
    return {
      file: isProject && this.projectFile ? this.projectFile : this.globalFile,
      values,
      inherited,
      sources,
      global,
      project,
    };
  }

  async save(
    baseline: SettingsSnapshot,
    changes: SettingChanges,
    signal: AbortSignal,
    guard: (values: SettingValues) => void,
  ): Promise<SettingsSnapshot> {
    const keys = Object.keys(changes);
    if (keys.length === 0) return baseline;
    if (keys.some((id) => this.locked[id])) throw new Error("Environment settings are locked.");
    await mkdir(dirname(baseline.file), { recursive: true });
    const lockPath = `${baseline.file}.settings-lock`;
    let lock;
    for (let attempt = 0; attempt < 40; attempt++) {
      signal.throwIfAborted();
      try {
        lock = await open(lockPath, "wx", 0o600);
        break;
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
        await setTimeout(50, undefined, { signal });
      }
    }
    if (!lock) {
      throw new Error(
        `Settings are locked at ${lockPath}. Wait for the other writer or review the stale lock.`,
      );
    }
    const temporary = `${baseline.file}.${randomUUID()}.tmp`;
    let temporaryCreated = false;
    try {
      const current = await this.load();
      if (current.file !== baseline.file) {
        throw new Error("The settings scope changed. Reopen the menu to review the save target.");
      }
      for (const id of keys) {
        if (
          JSON.stringify(current.global.data[id]) !== JSON.stringify(baseline.global.data[id]) ||
          JSON.stringify(current.project.data[id]) !== JSON.stringify(baseline.project.data[id])
        ) {
          throw new Error(`Setting ${id} changed on disk. Reopen the menu to review it.`);
        }
      }
      const isProject = current.file !== this.globalFile;
      const target = isProject ? current.project : current.global;
      const data = { ...target.data };
      for (const id of keys) {
        if (changes[id] === undefined) delete data[id];
        else data[id] = changes[id];
      }
      const values = this.resolve(
        isProject ? current.global.data : data,
        isProject ? data : current.project.data,
      );
      guard(values);
      signal.throwIfAborted();
      const mode = await stat(current.file).then(
        (metadata) => metadata.mode & 0o777,
        (error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0o600;
          throw error;
        },
      );
      await open(temporary, "wx", mode).then(async (handle) => {
        temporaryCreated = true;
        try {
          await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }
      });
      const verified = await this.load();
      if (
        verified.file !== current.file ||
        verified.global.text !== current.global.text ||
        verified.project.text !== current.project.text
      ) {
        throw new Error("Settings changed while saving. Reopen the menu to review them.");
      }
      signal.throwIfAborted();
      guard(values);
      await rename(temporary, current.file);
      temporaryCreated = false;
      const saved = { text: `${JSON.stringify(data, null, 2)}\n`, data };
      return {
        ...current,
        values,
        sources: {
          ...current.sources,
          ...Object.fromEntries(
            keys.map((id) => [
              id,
              changes[id] === undefined
                ? isProject && Object.hasOwn(this.normalize(current.global.data), id)
                  ? "global"
                  : "default"
                : isProject
                  ? "project"
                  : "global",
            ]),
          ),
        },
        global: isProject ? current.global : saved,
        project: isProject ? saved : current.project,
      };
    } finally {
      if (temporaryCreated) await unlink(temporary);
      await lock.close();
      await unlink(lockPath);
    }
  }
}
