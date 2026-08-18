import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, ProviderHeaders } from "@earendil-works/pi-ai";
import { providerHistory } from "./compaction-checkpoint.ts";
import type { ImageDetail } from "./config.ts";
import type { ResponsesItem } from "./codex-protocol.ts";

export interface CodexToolAuthentication {
  apiKey: string;
  headers?: ProviderHeaders;
}

export async function codexToolAuthentication(
  ctx: ExtensionContext,
  model: Model<any>,
): Promise<CodexToolAuthentication> {
  const authentication = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!authentication.ok) throw new Error(authentication.error);
  if (!authentication.apiKey) throw new Error("OpenAI Codex authentication is unavailable.");
  const result: CodexToolAuthentication = {
    apiKey: authentication.apiKey,
  };
  if (authentication.headers) result.headers = authentication.headers;
  return result;
}

export function codexToolHistory(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  model: Model<any>,
  imageDetail: ImageDetail = "auto",
): ResponsesItem[] {
  return providerHistory({
    branch: ctx.sessionManager.getBranch(),
    wireModel: model,
    allTools: pi.getAllTools(),
    imageDetail,
  });
}
