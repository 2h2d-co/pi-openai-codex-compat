import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import {
  FooterComponent,
  type ExtensionContext,
  type ReadonlyFooterDataProvider,
  type SessionEntry,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { CodexCompatConfig } from "./config.ts";
import type { ConfigContext, ConfigResolver } from "./config-context.ts";
import { selectedRegistryModel } from "./model-context.ts";
import { isCodexModel } from "./request-options.ts";
import { effectiveServiceTier } from "./service-tier.ts";

/** The service tiers the account's model catalog lists for a model, or `undefined` if unknown. */
export type ServiceTierLookup = (modelId: string) => ReadonlySet<string> | undefined;

/** The catalog the footer reads, and re-renders after, when a catalog loads. */
export type FooterCatalog = {
  currentServiceTiers: ServiceTierLookup;
  subscribe: (listener: () => void) => () => void;
};

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
      "getCwd" | "getEntries" | "getLeafId" | "getSessionId" | "getSessionName"
    >;
    ui: Pick<ExtensionContext["ui"], "setFooter">;
  };

export function footerSettingLabels(
  config: CodexCompatConfig,
  modelId: string,
  catalogTiers: ReadonlySet<string> | undefined,
): string[] {
  // The footer shows the tier requests use, so a tier the plan lacks for the model is left out.
  const serviceTier = effectiveServiceTier(config, modelId, catalogTiers);
  return [
    serviceTier === "priority" ? "fast" : serviceTier,
    config.textVerbosity !== "low" ? `verbosity ${config.textVerbosity}` : undefined,
    config.reasoningSummary !== "auto" ? `summary ${config.reasoningSummary}` : undefined,
  ].filter((label): label is string => label !== undefined);
}

export function footerModel(
  model: Model<Api> | undefined,
  thinkingLevel: string,
  config: CodexCompatConfig,
  serviceTiers: ServiceTierLookup,
): Model<Api> | undefined {
  if (!model || !isCodexModel(model)) return model;

  const settings = footerSettingLabels(config, model.id, serviceTiers(model.id));
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

/**
 * The part of Pi's `AgentSession` that `FooterComponent` reads. Pi constructs the
 * footer with its own session, so the compiler cannot check this adapter against
 * the footer's actual reads; the packaged TUI test renders it through Pi.
 */
interface FooterSessionAdapter {
  readonly state: {
    model: Model<Api> | undefined;
    thinkingLevel: string;
  };
  /** Pi keys its cached session statistics on this identity. */
  readonly model: Model<Api> | undefined;
  /** Extensions cannot observe virtual-model routing, so the footer omits it. */
  readonly routedModel: undefined;
  sessionManager: Pick<
    SessionManager,
    "getEntries" | "getEntryCount" | "getCwd" | "getLeafId" | "getSessionId" | "getSessionName"
  >;
  getContextUsage: () => ReturnType<ExtensionContext["getContextUsage"]>;
  modelRuntime: {
    isUsingOAuth: (provider: string) => boolean;
    isUsingSubscription: (provider: string) => boolean;
  };
}

type FooterSessionSnapshot = {
  revision: string;
  entries: SessionEntry[];
  contextUsage: ReturnType<ExtensionContext["getContextUsage"]>;
  displayName: string;
};

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function addUsage(total: Usage, usage: Usage): void {
  total.input += usage.input;
  total.output += usage.output;
  total.cacheRead += usage.cacheRead;
  total.cacheWrite += usage.cacheWrite;
  total.totalTokens += usage.totalTokens;
  total.cost.input += usage.cost.input;
  total.cost.output += usage.cost.output;
  total.cost.cacheRead += usage.cost.cacheRead;
  total.cost.cacheWrite += usage.cost.cacheWrite;
  total.cost.total += usage.cost.total;
  if (usage.cacheWrite1h !== undefined) {
    total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
  }
  if (usage.reasoning !== undefined) {
    total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
  }
}

function hasFooterUsage(usage: Usage): boolean {
  return (
    usage.input !== 0 ||
    usage.output !== 0 ||
    usage.cacheRead !== 0 ||
    usage.cacheWrite !== 0 ||
    usage.cost.total !== 0
  );
}

/**
 * Collapse full-history accounting to at most two entries. The footer only needs
 * cumulative usage and the latest assistant usage for its cache-hit percentage.
 */
function aggregateFooterEntries(entries: readonly SessionEntry[]): SessionEntry[] {
  const precedingUsage = emptyUsage();
  let latestAssistantEntry: SessionEntry | undefined;
  let latestAssistantUsage: Usage | undefined;

  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      if (latestAssistantUsage) addUsage(precedingUsage, latestAssistantUsage);
      latestAssistantEntry = entry;
      latestAssistantUsage = entry.message.usage;
    } else if (
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      entry.message.usage
    ) {
      addUsage(precedingUsage, entry.message.usage);
    } else if (
      (entry.type === "usage" || entry.type === "branch_summary" || entry.type === "compaction") &&
      entry.usage
    ) {
      addUsage(precedingUsage, entry.usage);
    }
  }

  const aggregated: SessionEntry[] = [];
  if (hasFooterUsage(precedingUsage)) {
    aggregated.push({
      type: "compaction",
      id: "codex-footer-usage",
      parentId: null,
      timestamp: "",
      summary: "",
      firstKeptEntryId: "",
      tokensBefore: 0,
      usage: precedingUsage,
    });
  }
  if (latestAssistantEntry) aggregated.push(latestAssistantEntry);
  return aggregated;
}

class CachedFooterSession implements FooterSessionAdapter {
  private readonly ctx: FooterContext;
  private readonly resolveConfig: ConfigResolver;
  private readonly serviceTiers: ServiceTierLookup;
  private snapshot: FooterSessionSnapshot | undefined;

  readonly sessionManager: FooterSessionAdapter["sessionManager"];
  readonly modelRuntime: FooterSessionAdapter["modelRuntime"];
  readonly routedModel = undefined;

  constructor(ctx: FooterContext, resolveConfig: ConfigResolver, serviceTiers: ServiceTierLookup) {
    this.ctx = ctx;
    this.resolveConfig = resolveConfig;
    this.serviceTiers = serviceTiers;
    // Pi's footer caches its statistics by session id, leaf id, entry count, and
    // model. The aggregated snapshot is keyed by the same session and leaf, so
    // both caches refresh together.
    this.sessionManager = {
      getEntries: () => this.getSnapshot().entries,
      getEntryCount: () => this.getSnapshot().entries.length,
      getCwd: () => ctx.sessionManager.getCwd(),
      getLeafId: () => ctx.sessionManager.getLeafId(),
      getSessionId: () => ctx.sessionManager.getSessionId(),
      getSessionName: () => this.getSnapshot().displayName,
    };
    this.modelRuntime = {
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
    };
  }

  get model(): Model<Api> | undefined {
    return selectedRegistryModel(this.ctx);
  }

  get state(): FooterSessionAdapter["state"] {
    const model = selectedRegistryModel(this.ctx);
    return {
      model: footerModel(
        model,
        this.ctx.thinkingLevel ?? "off",
        this.resolveConfig(this.ctx),
        this.serviceTiers,
      ),
      thinkingLevel: this.ctx.thinkingLevel ?? "off",
    };
  }

  get revision(): string {
    const selected = this.ctx.model;
    const registryModel = selectedRegistryModel(this.ctx);
    return JSON.stringify([
      this.ctx.sessionManager.getSessionId(),
      this.ctx.sessionManager.getLeafId(),
      selected?.provider,
      selected?.id,
      registryModel?.contextWindow,
    ]);
  }

  getContextUsage(): ReturnType<ExtensionContext["getContextUsage"]> {
    return this.getSnapshot().contextUsage;
  }

  private getSnapshot(): FooterSessionSnapshot {
    const revision = this.revision;
    if (this.snapshot?.revision === revision) return this.snapshot;

    const sessionManager = this.ctx.sessionManager;
    const sessionIdLabel = `session ${sessionManager.getSessionId()}`;
    const sessionName = sessionManager.getSessionName();
    this.snapshot = {
      revision,
      entries: aggregateFooterEntries(sessionManager.getEntries()),
      contextUsage: this.ctx.getContextUsage(),
      displayName: sessionName ? `${sessionName} • ${sessionIdLabel}` : sessionIdLabel,
    };
    return this.snapshot;
  }
}

function footerRenderKey(
  width: number,
  footerData: ReadonlyFooterDataProvider,
  ctx: FooterContext,
  session: CachedFooterSession,
  resolveConfig: ConfigResolver,
  serviceTiers: ServiceTierLookup,
): string {
  const model = selectedRegistryModel(ctx);
  const displayModel = footerModel(
    model,
    ctx.thinkingLevel ?? "off",
    resolveConfig(ctx),
    serviceTiers,
  );
  const usingSubscription = Boolean(
    model &&
    ctx.modelRegistry.isUsingOAuth(model) &&
    ctx.modelRegistry.getProvider(model.provider)?.auth?.oauth?.isSubscription === true,
  );
  const statuses = Array.from(footerData.getExtensionStatuses().entries()).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return JSON.stringify([
    width,
    session.revision,
    ctx.sessionManager.getCwd(),
    displayModel?.provider,
    displayModel?.id,
    displayModel?.reasoning,
    displayModel?.contextWindow,
    ctx.thinkingLevel,
    usingSubscription,
    footerData.getGitBranch(),
    footerData.getAvailableProviderCount(),
    statuses,
  ]);
}

class CodexFooter implements Component {
  private readonly footer: FooterComponent;
  private readonly footerData: ReadonlyFooterDataProvider;
  private readonly ctx: FooterContext;
  private readonly resolveConfig: ConfigResolver;
  private readonly serviceTiers: ServiceTierLookup;
  private readonly session: CachedFooterSession;
  private cache: { key: string; lines: string[] } | undefined;

  constructor(
    footerData: ReadonlyFooterDataProvider,
    ctx: FooterContext,
    resolveConfig: ConfigResolver,
    serviceTiers: ServiceTierLookup,
  ) {
    const session = new CachedFooterSession(ctx, resolveConfig, serviceTiers);
    const footer: unknown = Reflect.construct(FooterComponent, [session, footerData]);
    if (!(footer instanceof FooterComponent)) {
      throw new Error("Pi footer construction returned an invalid component.");
    }
    this.footer = footer;
    this.footerData = footerData;
    this.ctx = ctx;
    this.resolveConfig = resolveConfig;
    this.serviceTiers = serviceTiers;
    this.session = session;
    // Pi does not expose its live auto-compaction state to extension footers.
    this.footer.setAutoCompactEnabled(false);
  }

  render(width: number): string[] {
    const key = footerRenderKey(
      width,
      this.footerData,
      this.ctx,
      this.session,
      this.resolveConfig,
      this.serviceTiers,
    );
    if (this.cache?.key === key) return this.cache.lines;

    const lines = this.footer.render(width);
    this.cache = { key, lines };
    return lines;
  }

  invalidate(): void {
    this.cache = undefined;
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
  serviceTiers: ServiceTierLookup,
): Component & { dispose: () => void } {
  return new CodexFooter(footerData, ctx, resolveConfig, serviceTiers);
}

export function installCodexFooter(
  ctx: FooterContext,
  resolveConfig: ConfigResolver,
  catalog: FooterCatalog,
): void {
  if (ctx.mode !== "tui") return;
  ctx.ui.setFooter((tui, _theme, footerData) => {
    const footer = createCodexFooter(footerData, ctx, resolveConfig, (modelId) =>
      catalog.currentServiceTiers(modelId),
    );
    // A loaded catalog can change the tier the footer shows.
    const unsubscribe = catalog.subscribe(() => tui.requestRender());
    return {
      render: (width) => footer.render(width),
      invalidate: () => footer.invalidate(),
      dispose: () => {
        unsubscribe();
        footer.dispose();
      },
    };
  });
}
