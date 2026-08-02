import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerApplyPatch from "./apply-patch.ts";
import { loadConfig } from "./config.ts";

const APPLY_PATCH_TOOL = "apply_patch";

export function setApplyPatchEnabled(pi: ExtensionAPI, enabled: boolean): void {
  const active = new Set(pi.getActiveTools());
  if (enabled) {
    active.add(APPLY_PATCH_TOOL);
  } else {
    active.delete(APPLY_PATCH_TOOL);
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
