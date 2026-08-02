import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export type WebSearchMode = "disabled" | "cached" | "indexed" | "live";
export type TextVerbosity = "low" | "medium" | "high";
export type ReasoningSummary = "auto" | "concise" | "detailed" | "off";
export type ReasoningMode = "standard" | "pro";

export interface CodexCompatConfig {
  /** Send OpenAI Codex requests through the priority service tier. */
  fastMode: boolean;
  /** Replace Pi's active edit and write tools with the extension's apply_patch tool. */
  applyPatch: boolean;
  /** Expose the standalone Codex image-generation namespace tool. */
  imageGeneration: boolean;
  /** Expose the standalone Codex web-search namespace tool. */
  webRun: boolean;
  /**
   * Compact at a provider request boundary when context usage reaches this
   * percentage. Omit it to rely only on Pi's compaction lifecycle (`/compact`,
   * threshold compaction, and overflow recovery).
   */
  autoCompactAtPercent?: number;
  webSearch: WebSearchMode;
  textVerbosity: TextVerbosity;
  reasoningSummary: ReasoningSummary;
  reasoningMode: ReasoningMode;
}

export type ConfigLayer = {
  fastMode?: boolean;
  applyPatch?: boolean;
  imageGeneration?: boolean;
  webRun?: boolean;
  autoCompactAtPercent?: number | null;
  webSearch?: WebSearchMode;
  textVerbosity?: TextVerbosity;
  reasoningSummary?: ReasoningSummary;
  reasoningMode?: ReasoningMode;
};

export const CONFIG_FILE = "openai-codex-compat.json";
export const DEFAULT_CONFIG: CodexCompatConfig = {
  fastMode: false,
  applyPatch: true,
  imageGeneration: true,
  webRun: true,
  webSearch: "cached",
  textVerbosity: "low",
  reasoningSummary: "auto",
  reasoningMode: "standard",
};

const WEB_SEARCH_MODES = new Set<WebSearchMode>(["disabled", "cached", "indexed", "live"]);
const TEXT_VERBOSITIES = new Set<TextVerbosity>(["low", "medium", "high"]);
const REASONING_SUMMARIES = new Set<ReasoningSummary>(["auto", "concise", "detailed", "off"]);
const REASONING_MODES = new Set<ReasoningMode>(["standard", "pro"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseConfig(value: unknown): ConfigLayer {
  if (!isRecord(value)) return {};

  const layer: ConfigLayer = {};

  const fastMode = value["fastMode"];
  if (typeof fastMode === "boolean") layer.fastMode = fastMode;

  const applyPatch = value["applyPatch"];
  if (typeof applyPatch === "boolean") layer.applyPatch = applyPatch;

  const imageGeneration = value["imageGeneration"];
  if (typeof imageGeneration === "boolean") layer.imageGeneration = imageGeneration;

  const webRun = value["webRun"];
  if (typeof webRun === "boolean") layer.webRun = webRun;

  const threshold = value["autoCompactAtPercent"];
  if (threshold === null) {
    layer.autoCompactAtPercent = null;
  } else if (
    typeof threshold === "number" &&
    Number.isFinite(threshold) &&
    threshold > 0 &&
    threshold <= 100
  ) {
    layer.autoCompactAtPercent = threshold;
  }

  const webSearch = value["webSearch"];
  if (typeof webSearch === "string" && WEB_SEARCH_MODES.has(webSearch as WebSearchMode)) {
    layer.webSearch = webSearch as WebSearchMode;
  }

  const textVerbosity = value["textVerbosity"];
  if (typeof textVerbosity === "string" && TEXT_VERBOSITIES.has(textVerbosity as TextVerbosity)) {
    layer.textVerbosity = textVerbosity as TextVerbosity;
  }

  const reasoningSummary = value["reasoningSummary"];
  if (
    typeof reasoningSummary === "string" &&
    REASONING_SUMMARIES.has(reasoningSummary as ReasoningSummary)
  ) {
    layer.reasoningSummary = reasoningSummary as ReasoningSummary;
  }

  const reasoningMode = value["reasoningMode"];
  if (typeof reasoningMode === "string" && REASONING_MODES.has(reasoningMode as ReasoningMode)) {
    layer.reasoningMode = reasoningMode as ReasoningMode;
  }

  return layer;
}

function readConfig(filePath: string): ConfigLayer {
  if (!existsSync(filePath)) return {};

  try {
    return parseConfig(JSON.parse(readFileSync(filePath, "utf8")));
  } catch {
    // Invalid configuration must not prevent Pi from starting.
    return {};
  }
}

export function resolveConfig(
  globalConfig: ConfigLayer,
  projectConfig: ConfigLayer,
): CodexCompatConfig {
  const merged = { ...globalConfig, ...projectConfig };
  return {
    ...DEFAULT_CONFIG,
    ...(typeof merged.fastMode === "boolean" ? { fastMode: merged.fastMode } : {}),
    ...(typeof merged.applyPatch === "boolean" ? { applyPatch: merged.applyPatch } : {}),
    ...(typeof merged.imageGeneration === "boolean"
      ? { imageGeneration: merged.imageGeneration }
      : {}),
    ...(typeof merged.webRun === "boolean" ? { webRun: merged.webRun } : {}),
    ...(typeof merged.autoCompactAtPercent === "number"
      ? { autoCompactAtPercent: merged.autoCompactAtPercent }
      : {}),
    ...(merged.webSearch ? { webSearch: merged.webSearch } : {}),
    ...(merged.textVerbosity ? { textVerbosity: merged.textVerbosity } : {}),
    ...(merged.reasoningSummary ? { reasoningSummary: merged.reasoningSummary } : {}),
    ...(merged.reasoningMode ? { reasoningMode: merged.reasoningMode } : {}),
  };
}

export function globalConfigPath(): string {
  return join(getAgentDir(), CONFIG_FILE);
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, CONFIG_FILE);
}

/** Use an existing trusted project override; otherwise persist global settings. */
export function writableConfigPath(cwd: string, projectTrusted: boolean): string {
  const projectPath = projectConfigPath(cwd);
  return projectTrusted && existsSync(projectPath) ? projectPath : globalConfigPath();
}

export function loadConfig(cwd: string, projectTrusted: boolean): CodexCompatConfig {
  const globalConfig = readConfig(globalConfigPath());
  const projectConfig = projectTrusted ? readConfig(projectConfigPath(cwd)) : {};
  return resolveConfig(globalConfig, projectConfig);
}

export function configLayer(config: CodexCompatConfig): ConfigLayer {
  return {
    fastMode: config.fastMode,
    applyPatch: config.applyPatch,
    imageGeneration: config.imageGeneration,
    webRun: config.webRun,
    autoCompactAtPercent: config.autoCompactAtPercent ?? null,
    webSearch: config.webSearch,
    textVerbosity: config.textVerbosity,
    reasoningSummary: config.reasoningSummary,
    reasoningMode: config.reasoningMode,
  };
}

async function readWritableConfig(filePath: string): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (!isRecord(value)) throw new Error("the root value must be a JSON object");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot update ${filePath}: ${detail}`);
  }
}

/**
 * Merge known setting changes into the dedicated extension file. Unknown keys
 * are retained, and an invalid existing file is never overwritten.
 */
export async function saveConfig(
  cwd: string,
  projectTrusted: boolean,
  patch: ConfigLayer,
): Promise<string> {
  const filePath = writableConfigPath(cwd, projectTrusted);
  const current = await readWritableConfig(filePath);
  const next = { ...current, ...patch };
  const directory = dirname(filePath);
  const temporaryPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );

  await mkdir(directory, { recursive: true });
  const existingMode = await stat(filePath)
    .then((metadata) => metadata.mode & 0o777)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return 0o600;
      throw error;
    });

  try {
    await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: existingMode,
    });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }

  return filePath;
}
