import type { Api, Model } from "@earendil-works/pi-ai";
import {
  FooterComponent,
  type ExtensionContext,
  type ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { CodexCompatConfig } from "./config.ts";
import type { ConfigContext, ConfigResolver } from "./config-context.ts";
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
      find(provider: string, modelId: string): Model<Api> | undefined;
      getProvider(provider: string):
        | {
            auth?: {
              oauth?: {
                isSubscription?: boolean;
              };
            };
          }
        | undefined;
      isUsingOAuth(model: Model<Api>): boolean;
    };
    sessionManager: Pick<
      ExtensionContext["sessionManager"],
      "getCwd" | "getEntries" | "getSessionName"
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
  getContextUsage(): ReturnType<ExtensionContext["getContextUsage"]>;
  modelRuntime: {
    isUsingOAuth(provider: string): boolean;
    isUsingSubscription(provider: string): boolean;
  };
}

function selectedRegistryModel(ctx: FooterContext, provider: string): Model<Api> | undefined {
  const selected = ctx.model;
  return selected?.provider === provider
    ? ctx.modelRegistry.find(selected.provider, selected.id)
    : undefined;
}

function footerSession(ctx: FooterContext, resolveConfig: ConfigResolver): FooterSessionAdapter {
  return {
    get state() {
      const model = ctx.model ? selectedRegistryModel(ctx, ctx.model.provider) : undefined;
      return {
        model: footerModel(model, ctx.thinkingLevel ?? "off", resolveConfig(ctx)),
        thinkingLevel: ctx.thinkingLevel ?? "off",
      };
    },
    sessionManager: ctx.sessionManager,
    getContextUsage: () => ctx.getContextUsage(),
    modelRuntime: {
      isUsingOAuth(provider: string) {
        const model = selectedRegistryModel(ctx, provider);
        return model !== undefined && ctx.modelRegistry.isUsingOAuth(model);
      },
      isUsingSubscription(provider: string) {
        const model = selectedRegistryModel(ctx, provider);
        return Boolean(
          model &&
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
): Component & { dispose(): void } {
  return new CodexFooter(footerData, ctx, resolveConfig);
}

export function installCodexFooter(ctx: FooterContext, resolveConfig: ConfigResolver): void {
  if (ctx.mode !== "tui") return;
  ctx.ui.setFooter((_tui, _theme, footerData) => createCodexFooter(footerData, ctx, resolveConfig));
}
