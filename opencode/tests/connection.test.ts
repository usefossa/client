import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FossaClient } from "../src/client";
import { Store } from "../src/store";

test("native live connection authenticates, restores watches, reconnects, and stops", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fossa-live-")), store = new Store(directory);
  let connections = 0, messages = 0;
  const authorization: (string | null)[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request, server) {
    authorization.push(request.headers.get("authorization"));
    if (server.upgrade(request)) return;
    return new Response("Invalid upgrade", { status: 400 });
  }, websocket: {
    open(socket) { connections++; socket.send(JSON.stringify({ type: "chain", data: { blockhash: "fixture", maxAgeMs: 60000 } })); },
    message(socket, data) { if (JSON.parse(String(data)).watch === "fixture-booking") { messages++; if (connections === 1) socket.close(); } },
  } });
  const client = new FossaClient(store, { walletId: "fixture", wallet: "fixture", lane: "fixture", apiUrl: server.url.origin, name: "Fixture", access: "fixture-access", refresh: "fixture-refresh", expires: 0 }, () => {});
  client.cfg = { programId: "fixture", market: "fixture", usdcMint: "fixture", solanaRpc: "", opencode: { siteUrl: "https://example.invalid", deviceTtlSecs: 60, maxInputTokens: 1024, maxRequestBytes: 2200000, catalogMaxAgeMs: 5000, requestTimeoutMs: 1000, pollIntervalMs: 5, mainnetGenesisHash: "fixture", localBookingPoolSize: 1 } };
  try {
    client["watchers"].set("fixture-booking", () => {}); client["connect"]();
    const deadline = Date.now() + 2000; while (messages < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(messages).toBe(2); expect(client.chain?.blockhash).toBe("fixture"); expect(client.status.connected).toBe(true);
    expect(authorization).toEqual(["Bearer fixture-access", "Bearer fixture-access"]);
    await client.drain(); const stopped = connections; await Bun.sleep(20); expect(connections).toBe(stopped);
  } finally { client.stop(); server.stop(true); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
