import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Pending } from "../src/store";
import { FossaClient } from "../src/client";

test("confirmed receipts validate bindings and cannot be overwritten by stream completion", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fossa-receipt-")), store = new Store(directory);
  const client = new FossaClient(store, { walletId: "test", wallet: "owner", lane: "lane", apiUrl: "http://127.0.0.1", name: "Test", access: "test", refresh: "test", expires: 0 }, () => {});
  client.refresh = async () => {};
  client.cfg = { opencode: { maxRequestBytes: 1000 } } as typeof client.cfg;
  const row: Pending = { id: "request", wallet: "owner", model: "model", bodyHash: "hash", kind: "inference", flow: "primary", session: "session", booking: "booking", generation: "2", signature: "signature", transaction: "bytes", expiry: 100, reserve: "10", stage: "inference", created: Date.now(), processedSlot: 10, processedMs: 50, provider: "provider", dispatchStarted: true };
  store.put(row);
  client.status.requestId = row.id;
  const receipt = { owner: "owner", provider: "provider", booking: "booking", generation: "2", charge: "3", slot: 11 };
  try {
    for (const patch of [{ owner: "other" }, { provider: "other" }, { generation: "1" }, { booking: "other" }, { charge: "11" }, { charge: "-1" }, { slot: 9 }, { slot: 1.5 }]) client["receipt"]({ ...receipt, ...patch });
    expect(store.request(row.id, row.wallet)?.stage).toBe("inference");
    const response = client.response(new Request("http://127.0.0.1/inference", { headers: { "x-fossa-call-id": row.id } }), new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }));
    client["receipt"](receipt);
    await response.text();
    const saved = store.request(row.id, row.wallet)!;
    expect(saved.stage).toBe("settled"); expect(saved.charge).toBe("3"); expect(saved.settlementSlot).toBe(11);
    expect(saved.responseCompleted).toBe(true); expect(saved.responseFinishedAt).toBeGreaterThanOrEqual(saved.responseDoneAt!);
    expect(saved.processedMs).toBe(50);
    expect(client.status.stage).toBe("idle");
  } finally { client.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("wallet event waits wake immediately and clean up on cancellation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fossa-wake-")), store = new Store(directory);
  const client = new FossaClient(store, {} as never, () => {}), controller = new AbortController();
  try {
    const wait = client["waitForUpdate"](client["walletWaiters"], controller.signal, Date.now() + 60000, 60000);
    client["wakeWallet"](); expect(await wait).toBe(true); expect(client["walletWaiters"].size).toBe(0);
    const cancelled = client["waitForUpdate"](client["walletWaiters"], controller.signal, Date.now() + 60000, 60000);
    controller.abort(new Error("cancelled")); await expect(cancelled).rejects.toThrow("cancelled"); expect(client["walletWaiters"].size).toBe(0);
  } finally { client.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
