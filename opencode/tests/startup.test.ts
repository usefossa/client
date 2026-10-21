import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store";

// a status read can arrive before the first config response during native startup.
test("early status failure cannot poison activation after the backend becomes ready", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fossa-startup-")), store = new Store(directory);
  const symbol = Symbol.for("fossa.opencode.local-wallet-store"), cache = globalThis as Record<symbol, unknown>, previous = cache[symbol]; cache[symbol] = store;
  let ready!: () => void; const gate = new Promise<void>(resolve => { ready = resolve; });
  const config = { programId: "11111111111111111111111111111111", market: "11111111111111111111111111111111", usdcMint: "11111111111111111111111111111111", opencode: { siteUrl: "http://127.0.0.1:3000", maxInputTokens: 65536, maxRequestBytes: 2200000, pollIntervalMs: 20 } };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname.endsWith("/config")) { await gate; return Response.json(config); }
    return Response.json({ ready: true, slot: 1, programId: config.programId, market: config.market, models: [] });
  } });
  let handlers: Record<string, (input: unknown) => Promise<any>> = {}, reloads = 0, stop: (() => Promise<void>) | undefined;
  const methods: { id: string; form?: { key: string }[] }[] = [];
  const hooks: { name: string; callback: (event: any) => Promise<void>; options?: { providerID?: string } }[] = [];
  try {
    const plugin = (await import("../src/index")).default;
    stop = await plugin.setup({ app: { version: "2.0.26" }, options: { apiUrl: server.url.origin },
      storage: { get: async () => undefined },
      provider: { transform: async () => {}, reload: async () => { reloads++; } },
      integration: { transform: async (edit: (editor: unknown) => void) => edit({ update: () => {}, method: { remove: () => {}, update: ({ method }: { method: typeof methods[number] }) => methods.push(method) } }), connection: { active: async () => undefined } },
      session: { hook: async (name: string, callback: (event: any) => Promise<void>, options?: { providerID?: string }) => { hooks.push({ name, callback, options }); } },
      rpc: { register: async (_: unknown, value: typeof handlers) => { handlers = value; return { events: { emit: async () => {} } }; } },
    } as never) as () => Promise<void>;
    const early = await handlers.status({});
    expect(early.message.toLowerCase()).toContain("connecting");
    expect(early).toEqual(JSON.parse(JSON.stringify(early)));
    ready();
    const deadline = Date.now() + 2500;
    while (!reloads && Date.now() < deadline) await Bun.sleep(20);
    expect(reloads).toBeGreaterThan(0);
    expect((await handlers.status({})).message).toBe("Connect a Fossa wallet with /connect.");
    expect(methods.find(method => method.id === "quick")?.form).toBeUndefined();
    expect(methods.find(method => method.id === "import")?.form?.map(field => field.key)).toEqual(["key"]);
    expect(hooks.some(hook => hook.name === "http.response")).toBe(false);
  } finally { ready(); await stop?.(); server.stop(true); cache[symbol] = previous; store.close(); rmSync(directory, { recursive: true, force: true }); }
});
