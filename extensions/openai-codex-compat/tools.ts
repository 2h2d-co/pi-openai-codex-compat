import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import registerApplyPatch, { APPLY_PATCH_TOOL_NAME } from "./apply-patch.ts";
import type { CodexToolBackgroundResolver } from "./codex-tool-surface.ts";
import type { CodexCompatConfig } from "./config.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import registerImageGeneration from "./image-generation.ts";
import { IMAGE_GENERATION_TOOL_NAME, WEB_RUN_TOOL_NAME } from "./namespaced-tools.ts";
import { isCodexModel } from "./request-options.ts";
import registerWebRun from "./web-run.ts";

const PI_EDIT_TOOLS = ["edit", "write"] as const;
const CODEX_EXTENSION_TOOLS = [
  APPLY_PATCH_TOOL_NAME,
  IMAGE_GENERATION_TOOL_NAME,
  WEB_RUN_TOOL_NAME,
] as const;
const suppressedEditTools = new WeakMap<ExtensionAPI, Set<string>>();
type ConfigResolver = (ctx: ExtensionContext) => CodexCompatConfig;

export function setApplyPatchEnabled(pi: ExtensionAPI, enabled: boolean): void {
  const active = new Set(pi.getActiveTools());
  active.delete(APPLY_PATCH_TOOL_NAME);
  if (enabled) {
    let suppressed = suppressedEditTools.get(pi);
    if (!suppressed) {
      suppressed = new Set(PI_EDIT_TOOLS.filter((tool) => active.has(tool)));
      suppressedEditTools.set(pi, suppressed);
    }
    for (const tool of PI_EDIT_TOOLS) active.delete(tool);
    active.add(APPLY_PATCH_TOOL_NAME);
  } else {
    active.delete(APPLY_PATCH_TOOL_NAME);
    const suppressed = suppressedEditTools.get(pi);
    if (suppressed) {
      for (const tool of suppressed) active.add(tool);
      suppressedEditTools.delete(pi);
    }
  }
  pi.setActiveTools([...active]);
}

export function syncCodexTools(
  pi: ExtensionAPI,
  model: Model<any> | undefined,
  config: CodexCompatConfig,
): void {
  const codexSelected = isCodexModel(model);
  setApplyPatchEnabled(pi, codexSelected && config.applyPatch);

  const active = new Set(pi.getActiveTools());
  for (const tool of CODEX_EXTENSION_TOOLS) {
    if (tool !== APPLY_PATCH_TOOL_NAME) active.delete(tool);
  }
  if (codexSelected) {
    if (config.imageGeneration) active.add(IMAGE_GENERATION_TOOL_NAME);
    if (config.webRun) active.add(WEB_RUN_TOOL_NAME);
  }
  pi.setActiveTools([...active]);
}

export default function registerCodexTools(
  pi: ExtensionAPI,
  resolveConfig: ConfigResolver,
  resolveToolBackground: CodexToolBackgroundResolver = () => DEFAULT_CONFIG.toolBackground,
  resolveApplyPatchDebug: () => boolean = () => DEFAULT_CONFIG.applyPatchDebug,
): void {
  registerApplyPatch(pi, resolveToolBackground, resolveApplyPatchDebug);
  registerImageGeneration(pi, resolveConfig, resolveToolBackground);
  registerWebRun(pi, resolveConfig, resolveToolBackground);
}
