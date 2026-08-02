import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import registerApplyPatch, { APPLY_PATCH_TOOL_NAME } from "./apply-patch.ts";
import type { CodexCompatConfig } from "./config.ts";
import { isCodexModel } from "./request-options.ts";

const PI_EDIT_TOOLS = ["edit", "write"] as const;
const CODEX_EXTENSION_TOOLS = [APPLY_PATCH_TOOL_NAME] as const;
const suppressedEditTools = new WeakMap<ExtensionAPI, Set<string>>();

export function setApplyPatchEnabled(pi: ExtensionAPI, enabled: boolean): void {
  const active = new Set(pi.getActiveTools());
  for (const tool of CODEX_EXTENSION_TOOLS) active.delete(tool);
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
  setApplyPatchEnabled(pi, isCodexModel(model) && config.applyPatch);
}

export default function registerCodexTools(pi: ExtensionAPI): void {
  registerApplyPatch(pi);
}
