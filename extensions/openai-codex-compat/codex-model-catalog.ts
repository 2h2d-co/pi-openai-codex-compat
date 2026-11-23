import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isObject } from "./codex-protocol.ts";
import {
  extractAccountId,
  resolveCodexApiUrl,
} from "./codex-transport/codex-transport-request-headers.ts";
import { selectedRegistryModel } from "./model-context.ts";
import { isCodexModel } from "./request-options.ts";
import { isNumber, isString } from "./value-contracts.ts";

/**
 * The Codex CLI version that model catalog requests name. The catalog leaves out every model
 * whose `minimal_client_version` is newer, so this must be at least the newest supported model's.
 */
export const CODEX_MODEL_CATALOG_CLIENT_VERSION = "0.171.0";

/** The agent-directory file that keeps each account's last catalog across Pi processes. */
export const CODEX_MODEL_CATALOG_FILE = "openai-codex-compat-model-catalog.json";

/** Like the Codex CLI, refresh a catalog older than five minutes. */
export const CODEX_MODEL_CATALOG_TTL_MS = 5 * 60_000;
const CATALOG_TIMEOUT_MS = 5_000;
/** Wait this long before retrying a failed load for an account without a catalog. */
const FAILED_LOAD_RETRY_MS = 30_000;

/** The signed-in account whose catalog a request needs. */
export type CodexCatalogAccount = {
  accountId: string;
  apiKey: string;
  /** The Codex base URL of the requested model, such as `https://chatgpt.com/backend-api`. */
  baseUrl: string | undefined;
};

/** The service tiers that each model of an account's catalog lists. */
export type CatalogModels = ReadonlyMap<string, ReadonlySet<string>>;

/** The catalog operations that gate a request's service tier. */
export interface CodexServiceTierCatalog {
  /** Load the account's catalog unless a current one is available. Never rejects. */
  load: (account: CodexCatalogAccount, signal?: AbortSignal) => Promise<void>;
  /** The tiers the account's catalog lists for a model, or `undefined` when unknown. */
  serviceTiers: (accountId: string, modelId: string) => ReadonlySet<string> | undefined;
  /** Why the account has no catalog, when its last load failed. */
  failure: (accountId: string) => string | undefined;
  /** Record the catalog ETag a Codex response reported for the account. */
  noteModelsEtag: (accountId: string, etag: string) => void;
}

type CatalogSnapshot = {
  fetchedAt: number;
  etag: string | undefined;
  models: CatalogModels;
};

type CatalogOptions = {
  fetch?: typeof fetch;
  now?: () => number;
  /** The file that persists catalogs, or `undefined` to keep them in memory only. */
  file?: () => string | undefined;
};

type PersistedSnapshot = {
  fetchedAt: number;
  etag?: string;
  clientVersion: string;
  models: Record<string, string[]>;
};

class CatalogLoadError extends Error {}

/** Parse the `models` list of a catalog response into each model's service tier ids. */
export function parseCatalogModels(value: unknown): CatalogModels {
  if (!isObject(value) || !Array.isArray(value["models"])) {
    throw new CatalogLoadError("invalid catalog response");
  }
  const models = new Map<string, ReadonlySet<string>>();
  for (const model of value["models"]) {
    if (!isObject(model) || !isString(model["slug"]) || model["slug"].length === 0) continue;
    const tiers = Array.isArray(model["service_tiers"]) ? model["service_tiers"] : [];
    models.set(
      model["slug"],
      new Set(
        tiers.flatMap((tier) => (isObject(tier) && isString(tier["id"]) ? [tier["id"]] : [])),
      ),
    );
  }
  return models;
}

function accountKey(accountId: string): string {
  return createHash("sha256").update(accountId).digest("hex");
}

function persistedSnapshot(value: unknown): CatalogSnapshot | undefined {
  if (!isObject(value) || !isNumber(value["fetchedAt"]) || !isObject(value["models"]))
    return undefined;
  const models = new Map<string, ReadonlySet<string>>();
  for (const [modelId, tiers] of Object.entries(value["models"])) {
    if (!Array.isArray(tiers) || !tiers.every(isString)) return undefined;
    models.set(modelId, new Set(tiers));
  }
  return {
    // A catalog requested for another client version can lack newer models, so refresh it.
    fetchedAt:
      value["clientVersion"] === CODEX_MODEL_CATALOG_CLIENT_VERSION ? value["fetchedAt"] : 0,
    etag: isString(value["etag"]) ? value["etag"] : undefined,
    models,
  };
}

function failureReason(error: unknown): string {
  if (error instanceof CatalogLoadError) return error.message;
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "timed out";
  }
  return "network error";
}

function untilAborted(promise: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      signal.removeEventListener("abort", done);
      resolve();
    };
    signal.addEventListener("abort", done, { once: true });
    promise.then(done, (error: unknown) => {
      // `refresh` records its own failures and never rejects.
      void error;
      done();
    });
  });
}

/**
 * Each account's Codex model catalog, which lists the service tiers the account's plan includes
 * for every model. Like the Codex CLI, a request sends Fast or Ultrafast only when the catalog
 * lists it for the model.
 */
export class CodexModelCatalog implements CodexServiceTierCatalog {
  private readonly snapshots = new Map<string, CatalogSnapshot>();
  private readonly loads = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, { at: number; reason: string }>();
  private readonly changedEtags = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly file: () => string | undefined;
  private currentAccountId: string | undefined;

  constructor(options: CatalogOptions = {}) {
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = options.now ?? (() => Date.now());
    // The agent directory is fixed when the extension loads, as it is for the rest of the process.
    const file = join(getAgentDir(), CODEX_MODEL_CATALOG_FILE);
    this.file = options.file ?? (() => file);
  }

  async load(account: CodexCatalogAccount, signal?: AbortSignal): Promise<void> {
    this.currentAccountId = account.accountId;
    const snapshot = this.snapshot(account.accountId);
    if (snapshot) {
      // A catalog older than the TTL still answers while a newer one loads, but a reported ETag
      // change means the catalog changed, so the request waits for it.
      if (this.changedEtags.has(account.accountId)) {
        await untilAborted(this.refresh(account), signal);
      } else if (this.now() - snapshot.fetchedAt >= CODEX_MODEL_CATALOG_TTL_MS) {
        this.refreshInBackground(account);
      }
      return;
    }
    const failure = this.failures.get(account.accountId);
    if (failure && this.now() - failure.at < FAILED_LOAD_RETRY_MS) return;
    await untilAborted(this.refresh(account), signal);
  }

  serviceTiers(accountId: string, modelId: string): ReadonlySet<string> | undefined {
    return this.snapshot(accountId)?.models.get(modelId);
  }

  /** The tiers of a model in the catalog of the account that last loaded one. */
  currentServiceTiers(modelId: string): ReadonlySet<string> | undefined {
    return this.currentAccountId === undefined
      ? undefined
      : this.serviceTiers(this.currentAccountId, modelId);
  }

  failure(accountId: string): string | undefined {
    return this.snapshot(accountId) ? undefined : this.failures.get(accountId)?.reason;
  }

  noteModelsEtag(accountId: string, etag: string): void {
    const snapshot = this.snapshots.get(accountId);
    if (!snapshot) return;
    if (snapshot.etag === etag) {
      // Like the Codex CLI, a matching ETag keeps the catalog fresh.
      snapshot.fetchedAt = this.now();
      this.changedEtags.delete(accountId);
    } else {
      this.changedEtags.add(accountId);
    }
  }

  /** Call `listener` after each catalog load. Returns a function that removes it. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private snapshot(accountId: string): CatalogSnapshot | undefined {
    let snapshot = this.snapshots.get(accountId);
    if (!snapshot) {
      snapshot = this.readPersisted(accountId);
      if (snapshot) this.snapshots.set(accountId, snapshot);
    }
    return snapshot;
  }

  private refreshInBackground(account: CodexCatalogAccount): void {
    this.refresh(account).catch((error: unknown) => {
      // `refresh` records its own failures and never rejects.
      void error;
    });
  }

  private refresh(account: CodexCatalogAccount): Promise<void> {
    const pending = this.loads.get(account.accountId);
    if (pending) return pending;
    const load = (async () => {
      try {
        const snapshot = await this.request(account);
        this.snapshots.set(account.accountId, snapshot);
        this.failures.delete(account.accountId);
        this.changedEtags.delete(account.accountId);
        this.persist(account.accountId, snapshot);
        for (const listener of this.listeners) listener();
      } catch (error) {
        this.failures.set(account.accountId, { at: this.now(), reason: failureReason(error) });
      } finally {
        this.loads.delete(account.accountId);
      }
    })();
    this.loads.set(account.accountId, load);
    return load;
  }

  private async request(account: CodexCatalogAccount): Promise<CatalogSnapshot> {
    const url = new URL(resolveCodexApiUrl(account.baseUrl, "models"));
    url.searchParams.set("client_version", CODEX_MODEL_CATALOG_CLIENT_VERSION);
    const response = await this.fetch(url, {
      headers: {
        Authorization: `Bearer ${account.apiKey}`,
        "chatgpt-account-id": account.accountId,
        originator: "pi",
      },
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new CatalogLoadError(`HTTP ${String(response.status)}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new CatalogLoadError("invalid catalog response", { cause: error });
    }
    return {
      fetchedAt: this.now(),
      etag: response.headers.get("etag") ?? undefined,
      models: parseCatalogModels(body),
    };
  }

  private readAccounts(file: string): Record<string, unknown> {
    try {
      const value: unknown = JSON.parse(readFileSync(file, "utf8"));
      return isObject(value) && isObject(value["accounts"]) ? { ...value["accounts"] } : {};
    } catch (error) {
      // A missing or unreadable file only means no catalog was kept.
      void error;
      return {};
    }
  }

  private readPersisted(accountId: string): CatalogSnapshot | undefined {
    const file = this.file();
    if (file === undefined) return undefined;
    return persistedSnapshot(this.readAccounts(file)[accountKey(accountId)]);
  }

  private persist(accountId: string, snapshot: CatalogSnapshot): void {
    const file = this.file();
    if (file === undefined) return;
    const entry: PersistedSnapshot = {
      fetchedAt: snapshot.fetchedAt,
      clientVersion: CODEX_MODEL_CATALOG_CLIENT_VERSION,
      models: Object.fromEntries(
        [...snapshot.models].map(([modelId, tiers]) => [modelId, [...tiers]]),
      ),
    };
    if (snapshot.etag !== undefined) entry.etag = snapshot.etag;
    const accounts = { ...this.readAccounts(file), [accountKey(accountId)]: entry };
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(temporary, `${JSON.stringify({ accounts }, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, file);
    } catch (error) {
      // The in-memory catalog still serves this process when the file cannot be written.
      void error;
      rmSync(temporary, { force: true });
    }
  }
}

/**
 * Load the catalog of the account behind the selected OpenAI Codex model. A missing login or a
 * failed load leaves the catalog unknown; the next request retries it.
 */
export async function loadSelectedModelCatalog(
  catalog: CodexServiceTierCatalog,
  ctx: Pick<ExtensionContext, "model"> & {
    modelRegistry: Pick<ExtensionContext["modelRegistry"], "find" | "getApiKeyAndHeaders">;
  },
): Promise<void> {
  const model: Model<Api> | undefined = selectedRegistryModel(ctx);
  if (!isCodexModel(model)) return;
  try {
    const authentication = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!authentication.ok || !authentication.apiKey) return;
    const accountId = extractAccountId(authentication.apiKey);
    await catalog.load({ accountId, apiKey: authentication.apiKey, baseUrl: model.baseUrl });
  } catch (error) {
    // Without a login or a readable token there is no account catalog to load yet.
    void error;
  }
}

/** Start `loadSelectedModelCatalog` without waiting for it. */
export function startSelectedModelCatalogLoad(
  catalog: CodexServiceTierCatalog,
  ctx: Parameters<typeof loadSelectedModelCatalog>[1],
): void {
  loadSelectedModelCatalog(catalog, ctx).catch((error: unknown) => {
    // `loadSelectedModelCatalog` never rejects.
    void error;
  });
}
