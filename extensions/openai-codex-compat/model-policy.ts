import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ConfigResolver } from "./config-context.ts";
import { hasNativeCheckpointEntry } from "./compaction-checkpoint.ts";
import { errorFromThrown } from "./error-from-thrown.ts";
import { selectedRegistryModel } from "./model-context.ts";
import { syncCodexTools } from "./tools.ts";

export type CodexModelPolicyContext = Parameters<ConfigResolver>[0] & {
  model: Model<Api> | undefined;
  sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch">;
  ui: Pick<ExtensionContext["ui"], "notify">;
};

export type CodexModelPolicyEvent = {
  model: Model<Api>;
  previousModel?: Model<Api> | undefined;
  source: "cycle" | "restore" | "set";
};

export type CodexModelPolicySelectHandler = (
  event: CodexModelPolicyEvent,
  ctx: CodexModelPolicyContext,
) => Promise<void> | void;

export type CodexModelPolicySessionStartHandler = (
  ctx: CodexModelPolicyContext,
) => Promise<void> | void;

export type CodexModelPolicyApi = Pick<ExtensionAPI, "getActiveTools" | "setActiveTools"> & {
  onModelSelect(handler: CodexModelPolicySelectHandler): void;
  onSessionStart(handler: CodexModelPolicySessionStartHandler): void;
  setModel(model: Model<Api>): Promise<boolean>;
};

export function codexModelPolicyApi(pi: ExtensionAPI): CodexModelPolicyApi {
  const context = (ctx: ExtensionContext): CodexModelPolicyContext => {
    return {
      cwd: ctx.cwd,
      isProjectTrusted: () => ctx.isProjectTrusted(),
      model: selectedRegistryModel(ctx),
      sessionManager: ctx.sessionManager,
      ui: ctx.ui,
    };
  };

  return {
    getActiveTools: () => pi.getActiveTools(),
    onModelSelect: (handler) =>
      pi.on("model_select", (event, ctx) => {
        const model = ctx.modelRegistry.find(event.model.provider, event.model.id);
        if (!model) throw new Error("Pi's selected model is missing from the model registry.");
        const previousModel = event.previousModel
          ? ctx.modelRegistry.find(event.previousModel.provider, event.previousModel.id)
          : undefined;
        return handler(
          {
            model,
            previousModel,
            source: event.source,
          },
          context(ctx),
        );
      }),
    onSessionStart: (handler) => pi.on("session_start", (_event, ctx) => handler(context(ctx))),
    setActiveTools: (names) => pi.setActiveTools(names),
    setModel: (model) => pi.setModel(model),
  };
}

function activeBranchHasCheckpoint(ctx: CodexModelPolicyContext): boolean {
  return hasNativeCheckpointEntry(ctx.sessionManager.getBranch());
}

export default function registerCodexModelPolicy(
  pi: CodexModelPolicyApi,
  resolveConfig: ConfigResolver,
): void {
  let restoringRejectedSwitch = false;

  pi.onSessionStart((ctx) => {
    syncCodexTools(pi, ctx.model, resolveConfig(ctx));
  });

  pi.onModelSelect(async (event, ctx) => {
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
    } catch (cause) {
      const error = errorFromThrown(
        cause,
        "Restoring the previous model failed with a non-Error value.",
      );
      ctx.ui.notify(
        `OpenAI Codex could not restore the previous model after rejecting the switch: ${error.message}`,
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
