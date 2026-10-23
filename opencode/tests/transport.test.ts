import { expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FossaClient } from "../src/client";
import { Store, type Pending } from "../src/store";

test("transport bounds every provider error and preserves uncertain payment recovery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fossa-error-transport-")), store = new Store(directory), owner = await Keypair.generate();
  const symbol = Symbol.for("fossa.opencode.local-wallet-store"), cache = globalThis as Record<symbol, unknown>, previous = cache[symbol]; cache[symbol] = store;
  const cfg = { programId: owner.publicKey.toString(), market: owner.publicKey.toString(), usdcMint: owner.publicKey.toString(), opencode: { siteUrl: "https://example.invalid", maxInputTokens: 1024, maxRequestBytes: 2200000, pollIntervalMs: 100, catalogMaxAgeMs: 5000 } };
  let status = 500, oversized = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/config")) return Response.json(cfg);
    if (path.endsWith("/catalog")) return Response.json({ ready: true, programId: cfg.programId, market: cfg.market, models: [{ id: "fixture/coder", outputTokens: 32 }] });
    return new Response(oversized ? "x".repeat(65_537) : JSON.stringify({ error: { message: "Try later", code: "unavailable" } }), { status, headers: { "content-type": "application/json", "retry-after": "5" } });
  } });
  const account = { walletId: "fixture", wallet: owner.publicKey.toString(), lane: owner.publicKey.toString(), name: "Fixture", apiUrl: server.url.origin, access: "fixture", refresh: "fixture", expires: Date.now() + 60000 };
  await store.save(account, { owner: [...owner.secretKey], bookings: {} });
  const start = FossaClient.prototype.start, request = FossaClient.prototype.request;
  FossaClient.prototype.start = async function () { this.stop(); };
  FossaClient.prototype.request = async function (id) {
    store.put({ id, wallet: account.wallet, booking: "fixture", generation: "1", kind: "inference", stage: "inference", created: Date.now(), signature: "preserved", transaction: "preserved" } as Pending);
    return { url: `${server.url.origin}/inference`, headers: new Headers({ "x-fossa-call-id": id }), body: "{}", deadline: Date.now() + 5000 };
  };
  const hooks: Record<string, (event: any) => Promise<void>> = {}; let cleanup: (() => Promise<void>) | undefined;
  try {
    const plugin = (await import("../src/index")).default;
    cleanup = await plugin.setup({ app: { version: "2.0.26" }, options: { apiUrl: server.url.origin }, storage: { get: async () => undefined },
      provider: { transform: async () => {}, reload: async () => {} },
      integration: { reload: async () => {}, transform: async () => {}, connection: { active: async () => "fixture", resolve: async () => ({ type: "oauth", ...account, metadata: account }) } },
      session: { hook: async (name: string, callback: typeof hooks[string]) => { hooks[name] = callback; } },
      rpc: { register: async () => ({ events: { emit: async () => {} } }) },
    } as never) as () => Promise<void>;
    for (status of [401, 429, 500]) for (oversized of [false, true]) {
      const event = { headers: {} as Record<string, string>, sessionID: "fixture", kind: "primary", baseURL: "" };
      for (let attempt = 0; ; attempt++) { try { await hooks["model.request"](event); break; } catch (error) { if (attempt === 100) throw error; await Bun.sleep(5); } }
      const response = await fetch(`${event.baseURL}/chat/completions`, { method: "POST", headers: event.headers, body: JSON.stringify({ model: "fixture/coder", messages: [] }) });
      expect(response.status).toBe(oversized ? 409 : status);
      expect(await response.text()).toContain(oversized ? "byte limit" : "Try later");
      if (!oversized) expect(response.headers.get("retry-after")).toBe("5");
      expect(store.request(event.headers["x-fossa-call-id"], account.wallet)).toMatchObject({ stage: "uncertain", signature: "preserved", transaction: "preserved" });
    }
  } finally {
    await cleanup?.(); FossaClient.prototype.start = start; FossaClient.prototype.request = request;
    await server.stop(true); cache[symbol] = previous; store.close(); owner.secretKey.fill(0); rmSync(directory, { recursive: true, force: true });
  }
});
