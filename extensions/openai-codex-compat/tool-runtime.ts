import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Model, ProviderHeaders } from "@earendil-works/pi-ai";
import { providerHistory } from "./compaction-checkpoint.ts";
import type { ImageDetail } from "./config.ts";
import type { ResponsesItem } from "./codex-protocol.ts";

export async function codexToolAuthentication(
  ctx: ExtensionContext,
  model: Model<any>,
): Promise<{ apiKey: string; headers?: ProviderHeaders }> {
  const authentication = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!authentication.ok) throw new Error(authentication.error);
  if (!authentication.apiKey) throw new Error("OpenAI Codex authentication is unavailable.");
  return {
    apiKey: authentication.apiKey,
    ...(authentication.headers ? { headers: authentication.headers } : {}),
  };
}

export function codexToolHistory(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  model: Model<any>,
  imageDetail: ImageDetail = "auto",
): ResponsesItem[] {
  return providerHistory({
    branch: ctx.sessionManager.getBranch() as SessionEntry[],
    wireModel: model,
    allTools: pi.getAllTools(),
    imageDetail,
  });
}
