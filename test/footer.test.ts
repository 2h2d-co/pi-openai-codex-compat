import assert from "node:assert/strict";
import test from "node:test";
import {
  initTheme,
  type ReadonlyFooterDataProvider,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { DEFAULT_CONFIG } from "../extensions/openai-codex-compat/config.ts";
import { createCodexFooter, type FooterContext } from "../extensions/openai-codex-compat/footer.ts";

test("shows the Pi session id and appends settings to the default footer", () => {
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
      getLeafId: () => "leaf-1",
      getSessionId: () => "11111111-1111-4111-8111-111111111111",
      getSessionName: () => "Refactor auth",
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
  assert.match(
    lines[0] ?? "",
    /\/workspace • Refactor auth • session 11111111-1111-4111-8111-111111111111/,
  );
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

test("caches footer history and refreshes session names when the leaf changes", () => {
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
  let leafId = "leaf-1";
  let sessionName = "Initial name";
  let entryReads = 0;
  let nameReads = 0;
  let contextUsageReads = 0;
  const usage = (
    input: number,
    output: number,
    cacheRead: number,
    cacheWrite: number,
    cost: number,
  ): Usage => ({
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: cost,
    },
  });
  const entries = [
    {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "",
      message: {
        role: "assistant",
        content: [],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: model.id,
        usage: usage(100, 10, 50, 0, 0.1),
        stopReason: "stop",
        timestamp: 0,
      },
    },
    {
      type: "compaction",
      id: "compaction-1",
      parentId: "assistant-1",
      timestamp: "",
      summary: "",
      firstKeptEntryId: "assistant-1",
      tokensBefore: 160,
      usage: usage(20, 5, 0, 0, 0.02),
    },
    {
      type: "message",
      id: "assistant-2",
      parentId: "compaction-1",
      timestamp: "",
      message: {
        role: "assistant",
        content: [],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: model.id,
        usage: usage(40, 5, 60, 0, 0.04),
        stopReason: "stop",
        timestamp: 0,
      },
    },
  ] satisfies SessionEntry[];
  const context = {
    cwd: "/workspace",
    isProjectTrusted: () => true,
    mode: "tui",
    model,
    thinkingLevel: "high",
    sessionManager: {
      getEntries: () => {
        entryReads++;
        return entries;
      },
      getCwd: () => "/workspace",
      getLeafId: () => leafId,
      getSessionId: () => "22222222-2222-4222-8222-222222222222",
      getSessionName: () => {
        nameReads++;
        return sessionName;
      },
    },
    getContextUsage: () => {
      contextUsageReads++;
      return { tokens: 1_000, contextWindow: 100_000, percent: 1 };
    },
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
  const statuses = new Map<string, string>();
  const footerData = {
    getGitBranch: () => "main",
    getExtensionStatuses: () => statuses,
    getAvailableProviderCount: () => 1,
    onBranchChange: () => () => {},
  } satisfies ReadonlyFooterDataProvider;
  const footer = createCodexFooter(footerData, context, () => DEFAULT_CONFIG);

  const first = footer.render(120);
  assert.match(first[0] ?? "", /Initial name/u);
  assert.match(first[1] ?? "", /↑160 ↓20 R110 CH60\.0% \$0\.160/u);
  assert.equal(entryReads, 1);
  assert.equal(nameReads, 1);
  assert.equal(contextUsageReads, 1);

  assert.strictEqual(footer.render(120), first);
  assert.equal(entryReads, 1);
  assert.equal(nameReads, 1);
  assert.equal(contextUsageReads, 1);

  assert.notStrictEqual(footer.render(100), first);
  assert.equal(entryReads, 1);
  assert.equal(nameReads, 1);
  assert.equal(contextUsageReads, 1);

  sessionName = "Renamed session";
  leafId = "leaf-2";
  const renamed = footer.render(100);
  assert.match(renamed[0] ?? "", /Renamed session/u);
  assert.equal(entryReads, 2);
  assert.equal(nameReads, 2);
  assert.equal(contextUsageReads, 2);

  statuses.set("test", "ready");
  const withStatus = footer.render(100);
  assert.match(withStatus.at(-1) ?? "", /ready/u);
  assert.equal(entryReads, 2);
  assert.equal(nameReads, 2);
  assert.equal(contextUsageReads, 2);

  footer.dispose?.();
});
