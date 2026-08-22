export const CODEX_PROVIDER = "openai-codex";
export const CODEX_API = "openai-codex-responses";

export const CODEX_TOOL_CALL_PROVIDERS: ReadonlySet<string> = new Set([
  "openai",
  CODEX_PROVIDER,
  "opencode",
]);
