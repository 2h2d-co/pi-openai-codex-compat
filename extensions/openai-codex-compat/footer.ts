import type { Api, Model } from "@earendil-works/pi-ai";
import {
  FooterComponent,
  type ExtensionContext,
  type ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { CodexCompatConfig } from "./config.ts";
import type { ConfigContext, ConfigResolver } from "./config-context.ts";
import { selectedRegistryModel } from "./model-context.ts";
import { isCodexModel } from "./request-options.ts";

export type FooterContext = ConfigContext &
  Pick<ExtensionContext, "getContextUsage" | "mode" | "thinkingLevel"> & {
    model:
      | {
          id: string;
          provider: string;
        }
      | undefined;
    modelRegistry: {
      find: (provider: string, modelId: string) => Model<Api> | undefined;
      getProvider: (provider: string) =>
        | {
            auth?: {
              oauth?: {
                isSubscription?: boolean;
              };
            };
          }
        | undefined;
      isUsingOAuth: (model: Model<Api>) => boolean;
    };
    sessionManager: Pick<
      ExtensionContext["sessionManager"],
      "getCwd" | "getEntries" | "getSessionId" | "getSessionName"
    >;
    ui: Pick<ExtensionContext["ui"], "setFooter">;
  };

export function footerSettingLabels(config: CodexCompatConfig): string[] {
  return [
    config.fastMode ? "fast" : undefined,
    config.reasoningMode === "pro" ? "pro" : undefined,
    config.textVerbosity !== "low" ? `verbosity ${config.textVerbosity}` : undefined,
    config.reasoningSummary !== "auto" ? `summary ${config.reasoningSummary}` : undefined,
  ].filter((label): label is string => label !== undefined);
}

export function footerModel(
  model: Model<Api> | undefined,
  thinkingLevel: string,
  config: CodexCompatConfig,
): Model<Api> | undefined {
  if (!model || !isCodexModel(model)) return model;

  const settings = footerSettingLabels(config);
  if (settings.length === 0) return model;

  const reasoning = model.reasoning
    ? thinkingLevel === "off"
      ? "thinking off"
      : thinkingLevel
    : undefined;
  const id = [model.id, reasoning, ...settings]
    .filter((part): part is string => part !== undefined)
    .join(" • ");
  return { ...model, id, reasoning: false };
}

interface FooterSessionAdapter {
  readonly state: {
    model: Model<Api> | undefined;
    thinkingLevel: string;
  };
  sessionManager: Pick<
    ExtensionContext["sessionManager"],
    "getEntries" | "getCwd" | "getSessionName"
  >;
  getContextUsage: () => ReturnType<ExtensionContext["getContextUsage"]>;
  modelRuntime: {
    isUsingOAuth: (provider: string) => boolean;
    isUsingSubscription: (provider: string) => boolean;
  };
}

function footerSession(ctx: FooterContext, resolveConfig: ConfigResolver): FooterSessionAdapter {
  const sessionManager = ctx.sessionManager;
  return {
    get state() {
      const model = selectedRegistryModel(ctx);
      return {
        model: footerModel(model, ctx.thinkingLevel ?? "off", resolveConfig(ctx)),
        thinkingLevel: ctx.thinkingLevel ?? "off",
      };
    },
    sessionManager: {
      getEntries: () => sessionManager.getEntries(),
      getCwd: () => sessionManager.getCwd(),
      getSessionName: () => {
        const sessionIdLabel = `session ${sessionManager.getSessionId()}`;
        const sessionName = sessionManager.getSessionName();
        return sessionName ? `${sessionName} • ${sessionIdLabel}` : sessionIdLabel;
      },
    },
    getContextUsage: () => ctx.getContextUsage(),
    modelRuntime: {
      isUsingOAuth(provider: string) {
        const model = selectedRegistryModel(ctx);
        return (
          model !== undefined &&
          model.provider === provider &&
          ctx.modelRegistry.isUsingOAuth(model)
        );
      },
      isUsingSubscription(provider: string) {
        const model = selectedRegistryModel(ctx);
        return Boolean(
          model &&
          model.provider === provider &&
          ctx.modelRegistry.isUsingOAuth(model) &&
          ctx.modelRegistry.getProvider(provider)?.auth?.oauth?.isSubscription === true,
        );
      },
    },
  };
}

class CodexFooter implements Component {
  private readonly footer: FooterComponent;

  constructor(
    footerData: ReadonlyFooterDataProvider,
    ctx: FooterContext,
    resolveConfig: ConfigResolver,
  ) {
    const footer: unknown = Reflect.construct(FooterComponent, [
      footerSession(ctx, resolveConfig),
      footerData,
    ]);
    if (!(footer instanceof FooterComponent)) {
      throw new Error("Pi footer construction returned an invalid component.");
    }
    this.footer = footer;
    // Pi does not expose its live auto-compaction state to extension footers.
    this.footer.setAutoCompactEnabled(false);
  }

  render(width: number): string[] {
    return this.footer.render(width);
  }

  invalidate(): void {
    this.footer.invalidate();
  }

  dispose(): void {
    this.footer.dispose();
  }
}

export function createCodexFooter(
  footerData: ReadonlyFooterDataProvider,
  ctx: FooterContext,
  resolveConfig: ConfigResolver,
): Component & { dispose: () => void } {
  return new CodexFooter(footerData, ctx, resolveConfig);
}

export function installCodexFooter(ctx: FooterContext, resolveConfig: ConfigResolver): void {
  if (ctx.mode !== "tui") return;
  ctx.ui.setFooter((_tui, _theme, footerData) => createCodexFooter(footerData, ctx, resolveConfig));
}
