import { expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FossaClient } from "../src/client";
import { Store } from "../src/store";

for (const action of ["reload", "endpoint"]) for (const phase of ["booking", "stream"]) test(`${action} drains ${phase} before stopping client or relocking protected wallet`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "fossa-drain-")), store = new Store(directory), owner = await Keypair.generate();
  const symbol = Symbol.for("fossa.opencode.local-wallet-store"), cache = globalThis as Record<symbol, unknown>, previous = cache[symbol]; cache[symbol] = store;
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const cfg = { programId: owner.publicKey.toString(), market: owner.publicKey.toString(), usdcMint: owner.publicKey.toString(), opencode: { siteUrl: "http://127.0.0.1:3000", maxInputTokens: 1024, maxRequestBytes: 2200000, pollIntervalMs: 100 } };
  const catalog = { ready: true, programId: cfg.programId, market: cfg.market, models: [{ id: "fixture/coder", outputTokens: 32 }] };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/config")) return Response.json(cfg);
    if (path.endsWith("/catalog")) return Response.json(catalog);
    return new Response(new ReadableStream<Uint8Array>({ async start(controller) {
      controller.enqueue(new TextEncoder().encode("data: first\n\n"));
      if (phase === "stream") { enter(); await gate; }
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); controller.close();
    } }), { headers: { "content-type": "text/event-stream" } });
  } });
  const account = { walletId: "fixture", wallet: owner.publicKey.toString(), lane: owner.publicKey.toString(), name: "Fixture", apiUrl: server.url.origin, access: "fixture", refresh: "fixture", expires: Date.now() + 60000 };
  await store.save(account, { owner: [...owner.secretKey], bookings: {} }, "fixture passphrase");
  const start = FossaClient.prototype.start, request = FossaClient.prototype.request, stop = FossaClient.prototype.stop;
  let stopped = 0, setups = 0, laterSetup: Promise<unknown> | undefined;
  const cleanups: (() => unknown)[] = [], hooks: Record<string, (event: any) => Promise<void>>[] = [];
  const handlers: Record<string, (input: unknown, context?: unknown) => Promise<any>>[] = [], preferences = new Map<string, unknown>();
  FossaClient.prototype.start = async function () {};
  FossaClient.prototype.request = async function () {
    if (phase === "booking") { enter(); await gate; }
    expect(store.secrets(account.walletId).owner).toEqual([...owner.secretKey]);
    return { url: `${server.url.origin}/inference`, headers: new Headers(), body: "{}", deadline: Date.now() + 5000 };
  };
  FossaClient.prototype.stop = function () { stopped++; stop.call(this); };
  try {
    const plugin = (await import("../src/index")).default;
    const setup = async () => {
      const callbacks: typeof hooks[number] = {}; hooks.push(callbacks);
      const cleanup = await plugin.setup({ app: { version: "2.0.32" }, options: { apiUrl: server.url.origin },
        storage: { get: async (key: string) => preferences.get(key), set: async (key: string, value: unknown) => { preferences.set(key, value); } },
        provider: { transform: async () => {}, reload: async () => {} },
        integration: { reload: async () => {}, transform: async () => {}, connection: { active: async () => "fixture", resolve: async () => ({ type: "oauth", ...account, metadata: account }) } },
        session: { hook: async (name: string, callback: typeof callbacks[string]) => { callbacks[name] = callback; } },
        rpc: { register: async (_: unknown, methods: typeof handlers[number]) => { handlers.push(methods); return { events: { emit: async () => {} } }; } },
      } as never) as () => unknown;
      cleanups.push(cleanup); setups++; return cleanup;
    };
    const cleanup = await setup();
    await store.unlock(account.walletId, "fixture passphrase");
    const event = { headers: {} as Record<string, string>, sessionID: "fixture", kind: "primary", baseURL: "" };
    for (let attempt = 0; ; attempt++) {
      try { await hooks[0]["model.request"](event); break; }
      catch (error) { if (attempt === 100) throw error; await Bun.sleep(5); }
    }
    const response = fetch(`${event.baseURL}/chat/completions`, { method: "POST", headers: event.headers, body: JSON.stringify({ model: "fixture/coder", messages: [] }) }).then(response => response.text());
    await entered;
    const nextApi = `${server.url.origin}/other`;
    const draining = action === "reload" ? cleanup() : handlers[0].endpoint({ apiUrl: nextApi }, { error: (_: string, message: string) => { throw Error(message); } });
    if (action === "reload") laterSetup = setup();
    await Bun.sleep(30);
    expect(setups).toBe(1); expect(stopped).toBe(0); expect(store.unlocked(account.walletId)).toBe(true);
    release();
    expect(await response).toContain("[DONE]");
    await draining; await laterSetup;
    expect(setups).toBe(action === "reload" ? 2 : 1); expect(stopped).toBeGreaterThan(0); expect(store.unlocked(account.walletId)).toBe(false);
    if (action === "endpoint") { expect(preferences.get("apiUrl")).toBe(nextApi); expect((await handlers[0].status({})).apiUrl).toBe(nextApi); }
  } finally {
    release(); await laterSetup?.catch(() => {});
    await Promise.allSettled(cleanups.map(cleanup => Promise.resolve(cleanup())));
    FossaClient.prototype.start = start; FossaClient.prototype.request = request; FossaClient.prototype.stop = stop;
    await server.stop(true); cache[symbol] = previous; store.close(); owner.secretKey.fill(0); rmSync(directory, { recursive: true, force: true });
  }
});
