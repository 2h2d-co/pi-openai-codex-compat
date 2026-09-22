/**
 * Every Pi 0.86 transcript API this extension imports as a value from
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
 * Every Pi 0.87 session API this extension imports as a value from
 * `@earendil-works/pi-coding-agent`. Keep this list equal to the value imports
 * in `compaction-checkpoint.ts`.
 */
export const SESSION_APIS = ["buildSessionProjection"] as const;

export const REQUIRED_PI = "Pi 0.87.x";

/** Check the loaded host, not package metadata that PI_PACKAGE_DIR can override. */
export function requirePiTranscriptRuntime(
  transcriptApi: Record<string, unknown>,
  sessionApi: Record<string, unknown>,
): void {
  const missing = [
    ...TRANSCRIPT_APIS.filter((name) => typeof transcriptApi[name] !== "function"),
    ...SESSION_APIS.filter((name) => typeof sessionApi[name] !== "function"),
  ];
  if (missing.length > 0) {
    throw new Error(
      `pi-openai-codex-compat requires a running ${REQUIRED_PI} runtime. ` +
        `Missing host APIs: ${missing.join(", ")}. ` +
        `Exit Pi and start ${REQUIRED_PI} after updating. /reload cannot upgrade the running ` +
        "runtime, and PI_PACKAGE_DIR can make an older executable report a newer version.",
    );
  }
}
