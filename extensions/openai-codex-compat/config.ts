import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export type WebSearchMode = "disabled" | "cached" | "indexed" | "live";
export type TextVerbosity = "low" | "medium" | "high";
export type ReasoningSummary = "auto" | "concise" | "detailed" | "off";
export type ReasoningMode = "standard" | "pro";
export type ImageDetail = "auto" | "low" | "high" | "original";
export type CodexToolBackground = "subtle" | "status" | "none";

export const ENV_PREFIX = "PI_OPENAI_CODEX_COMPAT_";

export interface CodexCompatConfig {
  /** Send OpenAI Codex requests through the priority service tier. */
  fastMode: boolean;
  /** Use Codex's Responses Lite envelope on supported GPT-5.6 models. */
  responsesLite: boolean;
  /** Replace Pi's active edit and write tools with the extension's apply_patch tool. */
  applyPatch: boolean;
  /** Select the shared background surface for extension-owned Codex tools. */
  toolBackground: CodexToolBackground;
  /** Expose the standalone Codex image-generation namespace tool. */
  imageGeneration: boolean;
  /** Set input_image.detail when image tool results are returned to the model. */
  imageDetail: ImageDetail;
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

export const CONFIG_ENVIRONMENT_VARIABLES = {
  fastMode: `${ENV_PREFIX}FAST_MODE`,
  responsesLite: `${ENV_PREFIX}RESPONSES_LITE`,
  applyPatch: `${ENV_PREFIX}APPLY_PATCH`,
  toolBackground: `${ENV_PREFIX}TOOL_BACKGROUND`,
  imageGeneration: `${ENV_PREFIX}IMAGE_GENERATION`,
  imageDetail: `${ENV_PREFIX}IMAGE_DETAIL`,
  webRun: `${ENV_PREFIX}WEB_RUN`,
  autoCompactAtPercent: `${ENV_PREFIX}AUTO_COMPACT_AT_PERCENT`,
  webSearch: `${ENV_PREFIX}WEB_SEARCH_MODE`,
  textVerbosity: `${ENV_PREFIX}TEXT_VERBOSITY`,
  reasoningSummary: `${ENV_PREFIX}REASONING_SUMMARY`,
  reasoningMode: `${ENV_PREFIX}REASONING_MODE`,
} as const satisfies Record<keyof CodexCompatConfig, string>;

export type ConfigLayer = {
  fastMode?: boolean;
  responsesLite?: boolean;
  applyPatch?: boolean;
  toolBackground?: CodexToolBackground;
  imageGeneration?: boolean;
  imageDetail?: ImageDetail;
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
  responsesLite: false,
  applyPatch: true,
  toolBackground: "subtle",
  imageGeneration: true,
  imageDetail: "auto",
  webRun: false,
  webSearch: "disabled",
  textVerbosity: "low",
  reasoningSummary: "auto",
  reasoningMode: "standard",
};

const WEB_SEARCH_MODES = new Set<WebSearchMode>(["disabled", "cached", "indexed", "live"]);
const TEXT_VERBOSITIES = new Set<TextVerbosity>(["low", "medium", "high"]);
const REASONING_SUMMARIES = new Set<ReasoningSummary>(["auto", "concise", "detailed", "off"]);
const REASONING_MODES = new Set<ReasoningMode>(["standard", "pro"]);
const IMAGE_DETAILS = new Set<ImageDetail>(["auto", "low", "high", "original"]);
const CODEX_TOOL_BACKGROUNDS = new Set<CodexToolBackground>(["subtle", "status", "none"]);

type Environment = Readonly<Record<string, string | undefined>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidEnvironmentValue(name: string, value: string, expected: string): never {
  throw new Error(`Invalid ${name}=${JSON.stringify(value)}; expected ${expected}`);
}

function environmentBoolean(environment: Environment, name: string): boolean | undefined {
  const raw = environment[name];
  if (raw === undefined) return undefined;

  switch (raw.trim().toLowerCase()) {
    case "1":
    case "enabled":
    case "on":
    case "true":
      return true;
    case "0":
    case "disabled":
    case "off":
    case "false":
      return false;
    default:
      return invalidEnvironmentValue(name, raw, "true, false, 1, 0, on, off, enabled, or disabled");
  }
}

function environmentEnum<T extends string>(
  environment: Environment,
  name: string,
  values: ReadonlySet<T>,
): T | undefined {
  const raw = environment[name];
  if (raw === undefined) return undefined;

  const value = raw.trim();
  if (values.has(value as T)) return value as T;
  return invalidEnvironmentValue(name, raw, [...values].join(", "));
}

/**
 * Parse explicit process-level overrides. Unlike invalid JSON settings, invalid
 * environment values fail fast so a CLI test cannot silently exercise a
 * different configuration than requested.
 */
export function parseEnvironmentConfig(environment: Environment = process.env): ConfigLayer {
  const layer: ConfigLayer = {};

  const fastMode = environmentBoolean(environment, CONFIG_ENVIRONMENT_VARIABLES.fastMode);
  if (fastMode !== undefined) layer.fastMode = fastMode;

  const responsesLite = environmentBoolean(environment, CONFIG_ENVIRONMENT_VARIABLES.responsesLite);
  if (responsesLite !== undefined) layer.responsesLite = responsesLite;

  const applyPatch = environmentBoolean(environment, CONFIG_ENVIRONMENT_VARIABLES.applyPatch);
  if (applyPatch !== undefined) layer.applyPatch = applyPatch;

  const toolBackground = environmentEnum(
    environment,
    CONFIG_ENVIRONMENT_VARIABLES.toolBackground,
    CODEX_TOOL_BACKGROUNDS,
  );
  if (toolBackground !== undefined) layer.toolBackground = toolBackground;

  const imageGeneration = environmentBoolean(
    environment,
    CONFIG_ENVIRONMENT_VARIABLES.imageGeneration,
  );
  if (imageGeneration !== undefined) layer.imageGeneration = imageGeneration;

  const imageDetail = environmentEnum(
    environment,
    CONFIG_ENVIRONMENT_VARIABLES.imageDetail,
    IMAGE_DETAILS,
  );
  if (imageDetail !== undefined) layer.imageDetail = imageDetail;

  const webRun = environmentBoolean(environment, CONFIG_ENVIRONMENT_VARIABLES.webRun);
  if (webRun !== undefined) layer.webRun = webRun;

  const thresholdName = CONFIG_ENVIRONMENT_VARIABLES.autoCompactAtPercent;
  const rawThreshold = environment[thresholdName];
  if (rawThreshold !== undefined) {
    const value = rawThreshold.trim();
    if (value.toLowerCase() === "off" || value.toLowerCase() === "default") {
      layer.autoCompactAtPercent = null;
    } else {
      const threshold = Number(value);
      if (value.length === 0 || !Number.isFinite(threshold) || threshold <= 0 || threshold > 100) {
        invalidEnvironmentValue(
          thresholdName,
          rawThreshold,
          "a number greater than 0 and at most 100, off, or default",
        );
      }
      layer.autoCompactAtPercent = threshold;
    }
  }

  const webSearch = environmentEnum(
    environment,
    CONFIG_ENVIRONMENT_VARIABLES.webSearch,
    WEB_SEARCH_MODES,
  );
  if (webSearch !== undefined) layer.webSearch = webSearch;

  const textVerbosity = environmentEnum(
    environment,
    CONFIG_ENVIRONMENT_VARIABLES.textVerbosity,
    TEXT_VERBOSITIES,
  );
  if (textVerbosity !== undefined) layer.textVerbosity = textVerbosity;

  const reasoningSummary = environmentEnum(
    environment,
    CONFIG_ENVIRONMENT_VARIABLES.reasoningSummary,
    REASONING_SUMMARIES,
  );
  if (reasoningSummary !== undefined) layer.reasoningSummary = reasoningSummary;

  const reasoningMode = environmentEnum(
    environment,
    CONFIG_ENVIRONMENT_VARIABLES.reasoningMode,
    REASONING_MODES,
  );
  if (reasoningMode !== undefined) layer.reasoningMode = reasoningMode;

  return layer;
}

export function parseConfig(value: unknown): ConfigLayer {
  if (!isRecord(value)) return {};

  const layer: ConfigLayer = {};

  const fastMode = value["fastMode"];
  if (typeof fastMode === "boolean") layer.fastMode = fastMode;

  const responsesLite = value["responsesLite"];
  if (typeof responsesLite === "boolean") layer.responsesLite = responsesLite;

  const applyPatch = value["applyPatch"];
  if (typeof applyPatch === "boolean") layer.applyPatch = applyPatch;

  const toolBackground = value["toolBackground"];
  if (
    typeof toolBackground === "string" &&
    CODEX_TOOL_BACKGROUNDS.has(toolBackground as CodexToolBackground)
  ) {
    layer.toolBackground = toolBackground as CodexToolBackground;
  }

  const imageGeneration = value["imageGeneration"];
  if (typeof imageGeneration === "boolean") layer.imageGeneration = imageGeneration;

  const imageDetail = value["imageDetail"];
  if (typeof imageDetail === "string" && IMAGE_DETAILS.has(imageDetail as ImageDetail)) {
    layer.imageDetail = imageDetail as ImageDetail;
  }

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
  environmentConfig: ConfigLayer = {},
): CodexCompatConfig {
  const merged = { ...globalConfig, ...projectConfig, ...environmentConfig };
  return {
    ...DEFAULT_CONFIG,
    ...(typeof merged.fastMode === "boolean" ? { fastMode: merged.fastMode } : {}),
    ...(typeof merged.responsesLite === "boolean" ? { responsesLite: merged.responsesLite } : {}),
    ...(typeof merged.applyPatch === "boolean" ? { applyPatch: merged.applyPatch } : {}),
    ...(merged.toolBackground ? { toolBackground: merged.toolBackground } : {}),
    ...(typeof merged.imageGeneration === "boolean"
      ? { imageGeneration: merged.imageGeneration }
      : {}),
    ...(merged.imageDetail ? { imageDetail: merged.imageDetail } : {}),
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

export function loadConfig(
  cwd: string,
  projectTrusted: boolean,
  environment: Environment = process.env,
): CodexCompatConfig {
  const globalConfig = readConfig(globalConfigPath());
  const projectConfig = projectTrusted ? readConfig(projectConfigPath(cwd)) : {};
  return resolveConfig(globalConfig, projectConfig, parseEnvironmentConfig(environment));
}

export function configLayer(config: CodexCompatConfig): ConfigLayer {
  return {
    fastMode: config.fastMode,
    responsesLite: config.responsesLite,
    applyPatch: config.applyPatch,
    toolBackground: config.toolBackground,
    imageGeneration: config.imageGeneration,
    imageDetail: config.imageDetail,
    webRun: config.webRun,
    autoCompactAtPercent: config.autoCompactAtPercent ?? null,
    webSearch: config.webSearch,
    textVerbosity: config.textVerbosity,
    reasoningSummary: config.reasoningSummary,
    reasoningMode: config.reasoningMode,
  };
}

/** Keep process-level overrides transient when an effective config is saved. */
export function withoutEnvironmentOverrides(
  layer: ConfigLayer,
  environmentConfig: ConfigLayer,
): ConfigLayer {
  const result = { ...layer };
  for (const key of Object.keys(environmentConfig) as (keyof ConfigLayer)[]) {
    delete result[key];
  }
  return result;
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
