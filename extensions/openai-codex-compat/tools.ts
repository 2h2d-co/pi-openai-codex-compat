import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerApplyPatch from "./apply-patch.ts";
import { loadConfig } from "./config.ts";

const APPLY_PATCH_TOOL = "apply_patch";
const PI_EDIT_TOOLS = ["edit", "write"] as const;
const suppressedEditTools = new WeakMap<ExtensionAPI, Set<string>>();

export function setApplyPatchEnabled(pi: ExtensionAPI, enabled: boolean): void {
  const active = new Set(pi.getActiveTools());
  if (enabled) {
    let suppressed = suppressedEditTools.get(pi);
    if (!suppressed) {
      suppressed = new Set(PI_EDIT_TOOLS.filter((tool) => active.has(tool)));
      suppressedEditTools.set(pi, suppressed);
    }
    for (const tool of PI_EDIT_TOOLS) active.delete(tool);
    active.add(APPLY_PATCH_TOOL);
  } else {
    active.delete(APPLY_PATCH_TOOL);
    const suppressed = suppressedEditTools.get(pi);
    if (suppressed) {
      for (const tool of suppressed) active.add(tool);
      suppressedEditTools.delete(pi);
    }
  }
  pi.setActiveTools([...active]);
}

export default function registerCodexTools(pi: ExtensionAPI): void {
  registerApplyPatch(pi);
  pi.on("session_start", (_event, ctx) => {
    const config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    setApplyPatchEnabled(pi, config.applyPatch);
  });
}
