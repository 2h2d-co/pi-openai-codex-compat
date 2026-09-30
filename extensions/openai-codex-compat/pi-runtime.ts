/**
 * Every transcript API this extension imports as a value from
 * `@earendil-works/pi-ai`. Pi's extension loader turns a missing named import
 * into `undefined` rather than a load error, so an older host fails at first use
 * unless the surface is checked up front. Keep this list equal to the value
 * imports in `codex-provider/codex-provider-runtime.ts`, `compaction-checkpoint.ts`,
 * and `vendor/pi-ai/openai-responses-serialization.ts`.
 */
export const TRANSCRIPT_APIS = [
  "getCurrentTools",
  "getDeclaredTools",
  "getInitialSystemMessage",
  "getSystemMessageText",
  "normalizeContext",
  "renderSystemMessageUpdate",
  "resolveTranscript",
  "resolveTranscriptTools",
] as const;

/**
 * Every session API this extension imports as a value from
 * `@earendil-works/pi-coding-agent`. Keep this list equal to the value imports
 * in `compaction-checkpoint.ts`.
 */
export const SESSION_APIS = ["buildSessionProjection"] as const;

/**
 * Pi 0.99.1 differs from 0.99.0 only in its model catalog: it adds GPT-6.1 Sol
 * to the built-in OpenAI Codex models. The host's own catalog is the runtime
 * signal for the minimum version.
 */
export const MINIMUM_PI_CODEX_MODEL = "gpt-6.1-sol";

export const REQUIRED_PI = "Pi 0.99.1 or later";

export type BuiltinModels = (provider: "openai-codex") => readonly { id: string }[];

/** Check the loaded host, not package metadata that PI_PACKAGE_DIR can override. */
export function requirePiRuntime(
  transcriptApi: Record<string, unknown>,
  sessionApi: Record<string, unknown>,
  builtinModels: BuiltinModels | undefined,
): void {
  const missing = [
    ...TRANSCRIPT_APIS.filter((name) => typeof transcriptApi[name] !== "function"),
    ...SESSION_APIS.filter((name) => typeof sessionApi[name] !== "function"),
  ];
  const problems = [
    ...(missing.length > 0 ? [`Missing host APIs: ${missing.join(", ")}.`] : []),
    ...(typeof builtinModels === "function" &&
    builtinModels("openai-codex").some((model) => model.id === MINIMUM_PI_CODEX_MODEL)
      ? []
      : [`The host's built-in OpenAI Codex catalog lacks ${MINIMUM_PI_CODEX_MODEL}.`]),
  ];
  if (problems.length > 0) {
    throw new Error(
      `pi-openai-codex-compat requires a running ${REQUIRED_PI} runtime. ` +
        `${problems.join(" ")} ` +
        `Exit Pi and start ${REQUIRED_PI} after updating. /reload cannot upgrade the running ` +
        "runtime, and PI_PACKAGE_DIR can make an older executable report a newer version.",
    );
  }
}
