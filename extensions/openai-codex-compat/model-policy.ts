import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CodexCompatConfig } from "./config.ts";
import { hasNativeCheckpointEntry } from "./compaction-checkpoint.ts";
import { syncCodexTools } from "./tools.ts";

type ConfigResolver = (ctx: ExtensionContext) => CodexCompatConfig;

function activeBranchHasCheckpoint(ctx: ExtensionContext): boolean {
  return hasNativeCheckpointEntry(ctx.sessionManager.getBranch() as SessionEntry[]);
}

export default function registerCodexModelPolicy(
  pi: ExtensionAPI,
  resolveConfig: ConfigResolver,
): void {
  let restoringRejectedSwitch = false;

  pi.on("session_start", (_event, ctx) => {
    syncCodexTools(pi, ctx.model, resolveConfig(ctx));
  });

  pi.on("model_select", async (event, ctx) => {
    if (restoringRejectedSwitch) {
      syncCodexTools(pi, event.model, resolveConfig(ctx));
      return;
    }

    const previousModel = event.previousModel;
    if (
      event.source === "restore" ||
      previousModel === undefined ||
      !activeBranchHasCheckpoint(ctx)
    ) {
      syncCodexTools(pi, event.model, resolveConfig(ctx));
      return;
    }

    restoringRejectedSwitch = true;
    let restored = false;
    try {
      restored = await pi.setModel(previousModel);
    } catch (error) {
      ctx.ui.notify(
        `OpenAI Codex could not restore the previous model after rejecting the switch: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "error",
      );
    } finally {
      restoringRejectedSwitch = false;
    }

    if (!restored) {
      syncCodexTools(pi, event.model, resolveConfig(ctx));
      ctx.ui.notify(
        "The active branch contains a native OpenAI Codex compaction checkpoint, but the previous model could not be restored.",
        "error",
      );
      return;
    }

    ctx.ui.notify(
      "Model switch rejected because the active branch contains a native OpenAI Codex compaction checkpoint. Navigate to a branch before the checkpoint or start a new session first.",
      "warning",
    );
  });
}
