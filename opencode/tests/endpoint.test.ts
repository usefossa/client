import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store";

test("API setting persists, rejects unsafe endpoints, and isolates old credentials", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fossa-endpoint-")), store = new Store(directory);
  const symbol = Symbol.for("fossa.opencode.local-wallet-store"), cache = globalThis as Record<symbol, unknown>, previous = cache[symbol]; cache[symbol] = store;
  const methods = new Map<string, unknown>(); let transform: ((editor: unknown) => void) | undefined;
  const editor = { update: () => {}, method: { remove: (_: unknown, method: { id?: string }) => { if (method.id) methods.delete(method.id); }, update: (value: { method: { id: string } }) => methods.set(value.method.id, value) } };
  const preferences = new Map<string, unknown>(), requests: { path: string; authorization: string | null }[] = [];
  const config = { programId: "11111111111111111111111111111111", market: "11111111111111111111111111111111", usdcMint: "11111111111111111111111111111111", opencode: { siteUrl: "https://example.invalid", maxInputTokens: 1024, maxRequestBytes: 2200000, pollIntervalMs: 10, catalogMaxAgeMs: 5000 } };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname; requests.push({ path, authorization: request.headers.get("authorization") });
    if (path.startsWith("/bad/")) return Response.json({});
    return Response.json(path.endsWith("/config") ? { ...config, opencode: { ...config.opencode, ...(path.startsWith("/alternate/") ? { deviceConnect: false, manualImport: true } : path.startsWith("/disabled/") ? { deviceConnect: true, manualImport: false } : {}) } } : { ready: true, programId: config.programId, market: config.market, models: [] });
  } });
  let credential: unknown, handlers: Record<string, (input: unknown, context?: unknown) => Promise<any>> = {}, stop: (() => Promise<void>) | undefined;
  const errors = { error: (_: string, message: string) => { throw Error(message); } };
  const call = (name: string, input: unknown = {}) => handlers[name](input, errors);
  const setup = async () => {
    const plugin = (await import("../src/index")).default;
    stop = await plugin.setup({ app: { version: "2.0.26" }, options: { apiUrl: server.url.origin },
      storage: { get: async (key: string) => preferences.get(key), set: async (key: string, value: unknown) => { preferences.set(key, value); } },
      provider: { transform: async () => {}, reload: async () => {} },
      integration: { reload: async () => { transform?.(editor); }, transform: async (edit: typeof transform) => { transform = edit; edit?.(editor); }, connection: { active: async () => credential ? "old" : undefined, resolve: async () => credential } },
      session: { hook: async () => {} },
      rpc: { register: async (_: unknown, value: typeof handlers) => { handlers = value; return { events: { emit: async () => {} } }; } },
    } as never) as () => Promise<void>;
  };
  try {
    await setup();
    await Bun.sleep(80);
    expect(requests.filter(row => row.path.endsWith("/catalog"))).toHaveLength(1);
    expect((await call("endpoint")).apiUrl).toBe(server.url.origin); expect([...methods.keys()]).toEqual(["quick", "import"]);
    for (const apiUrl of ["http://remote.invalid", "https://user:password@example.invalid", `${server.url.origin}?token=fixture`, `${server.url.origin}#fragment`, `${server.url.origin}/bad`]) await expect(call("endpoint", { apiUrl })).rejects.toThrow();
    expect(preferences.has("apiUrl")).toBe(false);
    const apiUrl = `${server.url.origin}/alternate`;
    await call("endpoint", { apiUrl }); expect(preferences.get("apiUrl")).toBe(apiUrl); expect([...methods.keys()]).toEqual(["import"]); expect((await call("status")).siteUrl).toBeUndefined();
    credential = { type: "oauth", access: "old-api-access", refresh: "old-api-refresh", expires: Date.now() + 60000, metadata: { walletId: "old-wallet", wallet: config.market, lane: config.market, apiUrl: server.url.origin, name: "Fixture" } };
    await Bun.sleep(30);
    const status = await call("status"); expect(status.apiUrl).toBe(apiUrl); expect(status.wallet).toBeUndefined(); expect(status.message).toContain("Connect a Fossa wallet");
    expect(requests.filter(row => row.path.startsWith("/alternate/")).every(row => row.authorization === null)).toBe(true);
    await stop?.(); await setup(); expect((await call("endpoint")).apiUrl).toBe(apiUrl);
    expect(store.wallets()).toEqual([]);
    await call("endpoint", { apiUrl: `${server.url.origin}/disabled` }); expect([...methods.keys()]).toEqual(["quick"]);
    await call("endpoint", { apiUrl: server.url.origin }); expect([...methods.keys()].sort()).toEqual(["import", "quick"]);
  } finally { await stop?.(); server.stop(true); cache[symbol] = previous; store.close(); rmSync(directory, { recursive: true, force: true }); }
});
