import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type CodexCompatConfig } from "./config.ts";

export type ConfigContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted">;

export type ConfigResolver = (ctx: ConfigContext) => CodexCompatConfig;

export function resolveFileConfig(ctx: ConfigContext): CodexCompatConfig {
  return loadConfig(ctx.cwd, ctx.isProjectTrusted());
}
