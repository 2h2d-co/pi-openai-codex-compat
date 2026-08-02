import assert from "node:assert/strict";
import test from "node:test";
import {
  initTheme,
  type ExtensionContext,
  type ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../extensions/openai-codex-compat/config.ts";
import { installCodexFooter } from "../extensions/openai-codex-compat/footer.ts";

void test("appends non-default Codex settings to the default second footer line", () => {
  initTheme("dark", false);
  let footerFactory:
    | ((
        tui: TUI,
        theme: unknown,
        footerData: ReadonlyFooterDataProvider,
      ) => Component & { dispose?(): void })
    | undefined;
  const model = {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://example.test",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 10_000,
  } as const;
  const context = {
    mode: "tui",
    model,
    thinkingLevel: "xhigh",
    sessionManager: {
      getEntries: () => [],
      getCwd: () => "/workspace",
      getSessionName: () => undefined,
    },
    getContextUsage: () => ({ tokens: 0, contextWindow: 100_000, percent: 0 }),
    modelRegistry: {
      isUsingOAuth: () => true,
    },
    ui: {
      setFooter(factory: typeof footerFactory) {
        footerFactory = factory;
      },
    },
  } as unknown as ExtensionContext;

  installCodexFooter(context, () => ({
    ...DEFAULT_CONFIG,
    fastMode: true,
    reasoningMode: "pro",
    textVerbosity: "high",
    reasoningSummary: "detailed",
  }));
  assert.ok(footerFactory);

  const footerData = {
    getGitBranch: () => null,
    getExtensionStatuses: () => new Map<string, string>(),
    getAvailableProviderCount: () => 1,
    onBranchChange: () => () => {},
  } satisfies ReadonlyFooterDataProvider;
  const footer = footerFactory({ requestRender() {} } as unknown as TUI, {}, footerData);
  const lines = footer.render(160);

  assert.equal(lines.length, 2);
  assert.match(lines[1]!, /gpt-5\.6-sol • xhigh • fast • pro • verbosity high • summary detailed/);
  footer.dispose?.();
});
