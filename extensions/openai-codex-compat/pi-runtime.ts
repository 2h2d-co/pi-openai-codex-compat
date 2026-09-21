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

/** Check the loaded host, not package metadata that PI_PACKAGE_DIR can override. */
export function requirePiTranscriptRuntime(api: Record<string, unknown>): void {
  const missing = TRANSCRIPT_APIS.filter((name) => typeof api[name] !== "function");
  if (missing.length > 0) {
    throw new Error(
      "pi-openai-codex-compat requires a running Pi 0.86.x runtime. " +
        `Missing host APIs: ${missing.join(", ")}. ` +
        "Exit Pi and start Pi 0.86.x after updating. /reload cannot upgrade the running " +
        "runtime, and PI_PACKAGE_DIR can make an older executable report a newer version.",
    );
  }
}
