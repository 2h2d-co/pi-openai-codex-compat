import type {
  CodexCatalogAccount,
  CodexServiceTierCatalog,
} from "../../extensions/openai-codex-compat/codex-model-catalog.ts";

function requestUrl(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : input);
}

/** A catalog that lists Fast and Ultrafast for every model, for tests about other behavior. */
export function allTiersCatalog(): CodexServiceTierCatalog & { loads: CodexCatalogAccount[] } {
  const loads: CodexCatalogAccount[] = [];
  return {
    loads,
    async load(account) {
      loads.push(account);
    },
    serviceTiers: () => new Set(["priority", "ultrafast"]),
    failure: () => undefined,
    noteModelsEtag() {},
  };
}

export type CatalogRequest = { url: URL; headers: Headers };

export type CatalogServer = {
  fetch: typeof fetch;
  requests: CatalogRequest[];
  /** The service tiers of each model that the next catalog response lists. */
  models: Record<string, readonly string[]>;
  etag: string | undefined;
  /** Answer with this HTTP status, or throw a network error for `"network"`. */
  failure: number | "network" | undefined;
};

/**
 * A `fetch` that answers model catalog requests with each model's service tiers, as the Codex
 * backend does, and records the requests.
 */
export function catalogServer(
  models: Record<string, readonly string[]>,
  etag: string | undefined = '"catalog-1"',
): CatalogServer {
  const server: CatalogServer = {
    requests: [],
    models,
    etag,
    failure: undefined,
    fetch: async (input, init) => {
      server.requests.push({ url: requestUrl(input), headers: new Headers(init?.headers) });
      if (server.failure === "network") throw new TypeError("fetch failed");
      if (server.failure !== undefined) {
        return new Response("unavailable", { status: server.failure });
      }
      const body = {
        models: Object.entries(server.models).map(([slug, tiers]) => ({
          slug,
          service_tiers: tiers.map((id) => ({ id, name: id, description: id })),
        })),
      };
      return new Response(JSON.stringify(body), {
        headers: {
          "content-type": "application/json",
          ...(server.etag === undefined ? {} : { etag: server.etag }),
        },
      });
    },
  };
  return server;
}

/** A token whose claims carry the ChatGPT account id, as Codex access tokens do. */
export function codexToken(accountId: string): string {
  const claims = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url");
  return `header.${claims}.signature`;
}

/**
 * The answer to a model catalog request, for tests that replace `globalThis.fetch` with a fake
 * Codex backend. Returns `undefined` for other requests.
 */
export function catalogResponse(
  input: string | URL | Request,
  models: Record<string, readonly string[]> = {},
): Response | undefined {
  const url = requestUrl(input);
  if (!url.pathname.endsWith("/codex/models")) return undefined;
  return Response.json({
    models: Object.entries(models).map(([slug, tiers]) => ({
      slug,
      service_tiers: tiers.map((id) => ({ id })),
    })),
  });
}
