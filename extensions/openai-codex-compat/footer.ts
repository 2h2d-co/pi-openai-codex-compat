import type { Model } from "@earendil-works/pi-ai";
import {
  FooterComponent,
  type ExtensionContext,
  type ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { CodexCompatConfig } from "./config.ts";
import { isCodexModel } from "./request-options.ts";

export type ConfigResolver = (ctx: ExtensionContext) => CodexCompatConfig;

export function footerSettingLabels(config: CodexCompatConfig): string[] {
  return [
    config.fastMode ? "fast" : undefined,
    config.reasoningMode === "pro" ? "pro" : undefined,
    config.textVerbosity !== "low" ? `verbosity ${config.textVerbosity}` : undefined,
    config.reasoningSummary !== "auto" ? `summary ${config.reasoningSummary}` : undefined,
  ].filter((label): label is string => label !== undefined);
}

export function footerModel(
  model: Model<any> | undefined,
  thinkingLevel: string,
  config: CodexCompatConfig,
): Model<any> | undefined {
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

type FooterSession = ConstructorParameters<typeof FooterComponent>[0];

function footerSession(ctx: ExtensionContext, resolveConfig: ConfigResolver): FooterSession {
  return {
    get state() {
      return {
        model: footerModel(ctx.model, ctx.thinkingLevel ?? "off", resolveConfig(ctx)),
        thinkingLevel: ctx.thinkingLevel ?? "off",
      };
    },
    sessionManager: ctx.sessionManager,
    getContextUsage: () => ctx.getContextUsage(),
    modelRuntime: {
      isUsingOAuth(provider: string) {
        const model = ctx.model;
        return Boolean(
          model && model.provider === provider && ctx.modelRegistry.isUsingOAuth(model),
        );
      },
      isUsingSubscription(provider: string) {
        const model = ctx.model;
        return Boolean(
          model &&
          model.provider === provider &&
          ctx.modelRegistry.isUsingOAuth(model) &&
          ctx.modelRegistry.getProvider(provider)?.auth.oauth?.isSubscription === true,
        );
      },
    },
  } as unknown as FooterSession;
}

class CodexFooter implements Component {
  private readonly footer: FooterComponent;

  constructor(
    footerData: ReadonlyFooterDataProvider,
    ctx: ExtensionContext,
    resolveConfig: ConfigResolver,
  ) {
    this.footer = new FooterComponent(footerSession(ctx, resolveConfig), footerData);
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

export function installCodexFooter(ctx: ExtensionContext, resolveConfig: ConfigResolver): void {
  if (ctx.mode !== "tui") return;
  ctx.ui.setFooter((_tui, _theme, footerData) => new CodexFooter(footerData, ctx, resolveConfig));
}
