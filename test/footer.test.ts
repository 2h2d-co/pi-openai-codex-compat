import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { DEFAULT_CONFIG } from "../extensions/openai-codex-compat/config.ts";
import { createCodexFooter, type FooterContext } from "../extensions/openai-codex-compat/footer.ts";

void test("appends non-default Codex settings to the default second footer line", () => {
  initTheme("dark", false);
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
  } satisfies Model<Api>;
  const context = {
    cwd: "/workspace",
    isProjectTrusted: () => true,
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
      find: () => model,
      isUsingOAuth: () => true,
      getProvider: () => ({
        auth: {
          oauth: {
            isSubscription: true,
          },
        },
      }),
    },
    ui: {
      setFooter() {},
    },
  } satisfies FooterContext;

  let branchSubscriptions = 0;
  const footerData = {
    getGitBranch: () => null,
    getExtensionStatuses: () => new Map<string, string>(),
    getAvailableProviderCount: () => 1,
    onBranchChange: () => {
      branchSubscriptions++;
      return () => {};
    },
  } satisfies ReadonlyFooterDataProvider;
  const footer = createCodexFooter(footerData, context, () => ({
    ...DEFAULT_CONFIG,
    fastMode: true,
    reasoningMode: "pro",
    textVerbosity: "high",
    reasoningSummary: "detailed",
  }));
  const lines = footer.render(160);

  assert.equal(branchSubscriptions, 0);
  assert.equal(lines.length, 2);
  const settingsLine = lines[1];
  assert.ok(settingsLine);
  assert.match(
    settingsLine,
    /gpt-5\.6-sol • xhigh • fast • pro • verbosity high • summary detailed/,
  );
  assert.match(settingsLine, /\$0\.000 \(sub\)/);
  assert.doesNotMatch(settingsLine, /\(auto\)/);
  footer.dispose?.();
});
