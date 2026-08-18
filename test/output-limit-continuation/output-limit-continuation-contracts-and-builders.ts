import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, Credential, Model } from "@earendil-works/pi-ai";
import type { JsonRecord } from "../../extensions/openai-codex-compat/codex-protocol.ts";

export const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const extensionPath = resolve(rootDir, "extensions/index.ts");

export const CODEX_PROVIDER = "openai-codex";

export const CODEX_API = "openai-codex-responses";

export const MODEL_ID = "gpt-5.6-sol";

export const ACCOUNT_ID_CLAIM = "https://api.openai.com/auth";

export type { JsonRecord };

export function base64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function fakeCodexToken(): string {
  return [
    base64Json({ alg: "none", typ: "JWT" }),
    base64Json({ [ACCOUNT_ID_CLAIM]: { chatgpt_account_id: "acct_test" } }),
    "signature",
  ].join(".");
}

export function codexCredential(): Credential {
  return {
    type: "oauth",
    access: fakeCodexToken(),
    refresh: "refresh_test",
    expires: Date.now() + 60 * 60 * 1000,
    accountId: "acct_test",
  };
}

export function codexModel(): Model<any> {
  return {
    id: MODEL_ID,
    name: "GPT Test",
    api: CODEX_API,
    provider: CODEX_PROVIDER,
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 10_000,
  };
}

export function assistant(
  stopReason: AssistantMessage["stopReason"],
  rawStopReason = stopReason === "length" ? "incomplete.max_output_tokens" : "completed",
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: CODEX_API,
    provider: CODEX_PROVIDER,
    model: MODEL_ID,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    rawStopReason,
    timestamp: Date.now(),
    responseId: "response-output-limit",
  };
}

export {
  continuationHarness,
  outputLimitResponseIdHash,
} from "./output-limit-continuation-hook-harness.ts";
export {
  compactionEvents,
  contextOverflowEvents,
  createTestSession,
  exhaustedOutputLimitEvents,
  followUpEvents,
  incompleteEvents,
  sse,
  startCodexServer,
  textEvents,
} from "./output-limit-continuation-session-harness.ts";
