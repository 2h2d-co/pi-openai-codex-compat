const TRANSCRIPT_APIS = [
  "normalizeContext",
  "getCurrentSystemPrompt",
  "getCurrentTools",
  "getDeclaredTools",
  "getInitialSystemMessage",
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
