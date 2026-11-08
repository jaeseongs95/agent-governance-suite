import type {JevProviderDefinition} from "./jev-provider.js";

const DAY_MS = 24 * 60 * 60_000;
const RETRY_MS = 60 * 60_000;
const RESPONSE_LIMIT = 64 * 1024;
const FETCH_TIMEOUT_MS = 5000;

export interface JevModelCatalogSnapshot {
  providerId: string;
  /** bundled: not fetched yet; current: the last refresh succeeded; unavailable: it failed (the previous list stays); no-key: no key registered. */
  status: "bundled" | "current" | "unavailable" | "no-key";
  updatedAt: string | null;
  refreshHours: 24;
  models: string[];
}

/**
 * The models a provider offers, for the admin page's choice. Refreshed at most once a day (an hour after a failure);
 * concurrent reads share one request. Only metadata: refreshing never changes the model the user signed.
 * The request mirrors the ssh_mcp portal (D:/gemini/ssh_mcp src/adapters/safety/jev.mjs listModels): fixed endpoint,
 * no redirects, a JSON body of at most 64 KiB, 5 seconds.
 */
export function createJevModelCatalog(options: {definition: JevProviderDefinition; getCredential: () => Promise<string | null>;
  fetcher?: typeof fetch; now?: () => number}) {
  const {definition} = options;
  const fetcher = options.fetcher ?? fetch, now = options.now ?? Date.now;
  let models = [...definition.bundledModels], status: JevModelCatalogSnapshot["status"] = "bundled", updatedAt: string | null = null;
  let next = 0, pending: Promise<JevModelCatalogSnapshot> | null = null;
  const snapshot = (current = status): JevModelCatalogSnapshot =>
    ({providerId: definition.providerId, status: current, updatedAt, refreshHours: 24, models: [...models]});
  async function list(key: string): Promise<string[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetcher(definition.modelsEndpoint, {redirect: "error", signal: controller.signal, headers: {authorization: `Bearer ${key}`}});
      if (!response.ok || !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "") || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("JEV_MODELS_UNAVAILABLE");
      }
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const {value, done} = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > RESPONSE_LIMIT) throw new Error("JEV_MODELS_TOO_LARGE");
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      return definition.parseModels(JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(Buffer.concat(chunks))));
    } finally { clearTimeout(timer); controller.abort(); }
  }
  return {
    async get(): Promise<JevModelCatalogSnapshot> {
      let key: string | null;
      try { key = await options.getCredential(); } catch { key = null; }
      if (!key) return snapshot("no-key");
      if (now() < next) return snapshot();
      pending ??= (async () => {
        try {
          const incoming = await list(key);
          models = [...new Set([...definition.bundledModels, ...incoming])]
            .sort((a, b) => b.localeCompare(a, undefined, {numeric: true})).slice(0, 64);
          status = "current"; updatedAt = new Date(now()).toISOString(); next = now() + DAY_MS;
        } catch { status = "unavailable"; next = now() + RETRY_MS; }
        return snapshot();
      })().finally(() => { pending = null; });
      return pending;
    },
  };
}
