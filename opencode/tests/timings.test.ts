import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Pending } from "../src/store";
import { FossaClient } from "../src/client";

test("request timing lookup isolates wallet, session and flow and skips current request", () => {
  const directory = mkdtempSync(join(tmpdir(), "fossa-previous-")), store = new Store(directory);
  try {
    const row = { wallet: "owner", kind: "inference", session: "session", flow: "primary", stage: "settled", created: 1 } as Pending;
    for (const patch of [{ id: "first" }, { id: "latest" }, { id: "other-session", session: "other" }, { id: "other-flow", flow: "title" }, { id: "other-wallet", wallet: "other" }, { id: "withdrawal", kind: "withdrawal" }, { id: "current" }]) store.put({ ...row, ...patch });
    expect(store.previousInference("current", "owner", "session", "primary")?.id).toBe("latest");
    expect(store.previousInference("current", "owner", "missing", "primary")).toBeUndefined();
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("confirmed receipts validate bindings and cannot be overwritten by stream completion", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fossa-receipt-")), store = new Store(directory);
  const client = new FossaClient(store, { walletId: "test", wallet: "owner", lane: "lane", apiUrl: "http://127.0.0.1", name: "Test", access: "test", refresh: "test", expires: 0 }, () => {});
  client.refresh = async () => {};
  client.cfg = { programId: "program", market: "market", usdcMint: "mint", opencode: { maxRequestBytes: 1000, mainnetGenesisHash: "genesis" } } as typeof client.cfg;
  const row: Pending = { id: "request", wallet: "owner", model: "model", bodyHash: "hash", kind: "inference", flow: "primary", session: "session", booking: "booking", generation: "2", signature: "signature", transaction: "bytes", expiry: 100, reserve: "10", stage: "inference", created: Date.now(), processedSlot: 10, processedMs: 50, provider: "provider", dispatchStarted: true };
  row.scope = client["scope"]; store.put(row);
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

test("DONE ends held-open native response without false cancellation or accounting regression", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fossa-done-")), store = new Store(directory);
  const client = new FossaClient(store, { wallet: "wallet" } as never, () => {});
  client.refresh = async () => {}; let cancellations = 0, cancelledReader = false; client.cancel = async () => { cancellations++; };
  const row = { id: "done", wallet: "wallet", booking: "booking", generation: "1", kind: "inference", reserve: "10", stage: "inference", created: 1 } as Pending;
  store.put(row); const controller = new AbortController();
  try {
    const upstream = new ReadableStream<Uint8Array>({ start(value) { value.enqueue(new TextEncoder().encode('data: {"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\ndata: {' + "x".repeat(17 * 1024 * 1024))); }, cancel() { cancelledReader = true; return new Promise(() => {}); } });
    const response = client.response(new Request("http://localhost/infer", { headers: { "x-fossa-call-id": row.id }, signal: controller.signal }), new Response(upstream, { headers: { "content-type": "text/event-stream" } }));
    await response.arrayBuffer(); controller.abort();
    expect(cancelledReader).toBe(true); expect(cancellations).toBe(0);
    expect(store.request(row.id, row.wallet)?.responseCompleted).toBe(true); expect(store.request(row.id, row.wallet)?.usage).toEqual({ input: 3, output: 2, cached: 0 });
  } finally { client.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("unknown active journals gate all new signing and owner debits respect chain and mint", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fossa-overlay-")), store = new Store(directory);
  const client = new FossaClient(store, { wallet: "wallet", lane: "lane" } as never, () => {});
  client.cfg = { programId: "program", market: "market", usdcMint: "mint", opencode: { mainnetGenesisHash: "chain" } } as never;
  client.wallet = { wallet: "wallet", lane: "lane", source: "source", slot: 10, usdcAtomic: "100", freeAtomic: "30", lamports: "1000", generation: "0", bookings: [] } as never;
  const scope = client["scope"]!, row = { wallet: "wallet", kind: "inference", booking: "booking", generation: "1", stage: "uncertain", created: 1, feeLamports: "10", rentLamports: "5", deposit: "20", reserve: "25" } as Pending;
  try {
    store.put({ ...row, id: "other-lane", scope: { ...scope, lane: "other" }, source: "source" });
    store.put({ ...row, id: "other-mint", scope: { ...scope, mint: "other" }, source: "other" });
    store.put({ ...row, id: "other-chain", scope: { ...scope, genesis: "other" }, source: "source" });
    expect(client["availableWallet"]()).toMatchObject({ usdcAtomic: "80", freeAtomic: "30", lamports: "970", generation: "0" });
    store.put({ ...row, id: "unknown" }); expect(() => client["assertJournalScope"]()).toThrow("unknown network");
    store.put({ ...row, id: "unknown", stage: "settled", charge: "4" }); expect(() => client["assertJournalScope"]()).not.toThrow();
    expect(store.request("unknown", "wallet")?.charge).toBe("4");
  } finally { client.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("legacy network adoption requires confirmed history and same-lane alternate APIs preserve recovery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fossa-adoption-")), store = new Store(directory);
  const client = new FossaClient(store, { wallet: "wallet", lane: "lane", apiUrl: "http://localhost/one" } as never, () => {});
  client.cfg = { programId: "program", market: "market", usdcMint: "mint", opencode: { mainnetGenesisHash: "chain" } } as never;
  const row = { id: "old", wallet: "wallet", booking: "booking", generation: "1", stage: "uncertain", created: 1, scope: { program: "program", market: "market", lane: "lane" } } as Pending;
  let confirmationStatus = "processed";
  client["rpc"] = { getSignatureStatuses: async () => ({ value: [{ err: null, slot: 20, confirmationStatus }] }) } as never;
  try {
    store.put(row); await client["adoptLegacy"](); expect(() => client["assertJournalScope"]()).toThrow();
    confirmationStatus = "confirmed"; await client["adoptLegacy"](); expect(() => client["assertJournalScope"]()).not.toThrow();
    expect(store.request(row.id, row.wallet)?.scope).toEqual(client["scope"]);
    client.account.apiUrl = "http://localhost/alternate"; expect(client["localRequest"](row.id)?.processedSlot).toBe(20);
    client.account.lane = "different"; expect(client["localRequest"](row.id)).toBeUndefined();
  } finally { client.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("expiry rechecks signature history after finalized height before releasing journal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fossa-expiry-")), store = new Store(directory);
  const client = new FossaClient(store, { wallet: "wallet" } as never, () => {});
  client.cfg = { opencode: { requestTimeoutMs: 1000, pollIntervalMs: 10 } } as never;
  const row = { id: "expiry", wallet: "wallet", booking: "booking", generation: "1", stage: "sent", created: Date.now(), expiry: 100 } as Pending;
  const calls: string[] = []; let found = true;
  client["rpc"] = { getSignatureStatuses: async () => { calls.push("status"); return { value: [calls.length > 2 && found ? { err: null, slot: 20, confirmationStatus: "confirmed" } : null] }; }, getBlockHeight: async (commitment: string) => { calls.push(commitment); return 200; } } as never;
  try {
    store.put(row); expect(await client["processed"](row, undefined, undefined, true)).toBe(20); expect(calls).toEqual(["status", "finalized", "status"]); expect(store.request(row.id, row.wallet)?.stage).toBe("sent");
    calls.length = 0; found = false; await expect(client["processed"](row, undefined, undefined, true)).rejects.toThrow("expired"); expect(store.request(row.id, row.wallet)?.stage).toBe("expired");
  } finally { client.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("malformed signature history cannot expire or adopt an uncertain journal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fossa-invalid-status-")), store = new Store(directory);
  const client = new FossaClient(store, { wallet: "wallet", lane: "lane" } as never, () => {});
  client.cfg = { programId: "program", market: "market", usdcMint: "mint", opencode: { mainnetGenesisHash: "chain", requestTimeoutMs: 25, pollIntervalMs: 4 } } as never;
  const invalid = [{}, { value: [] }, { value: [null, null] }, { value: [{}] }, { value: [{ slot: 20, confirmationStatus: "confirmed" }] }, { value: [{ err: "", slot: 20, confirmationStatus: "confirmed" }] }, { value: [{ err: {}, slot: 20, confirmationStatus: "confirmed" }] }, { value: [{ err: null, slot: 20, confirmationStatus: null }] }, { value: [{ err: null, slot: -1, confirmationStatus: "confirmed" }] }, { value: [{ err: false, slot: 20, confirmationStatus: "confirmed" }] }];
  try {
    for (const [index, result] of invalid.entries()) {
      const row = { id: `invalid-${index}`, wallet: "wallet", booking: "booking", generation: "1", stage: "sent", created: Date.now(), expiry: 100, signature: "signature", scope: { program: "program", market: "market", lane: "lane" } } as Pending;
      let calls = 0;
      client["rpc"] = { getSignatureStatuses: async () => ++calls === 1 ? { value: [null] } : result, getBlockHeight: async () => 200 } as never;
      store.put(row); await expect(client["processed"](row, undefined, undefined, true)).rejects.toThrow("unresolved");
      expect(store.request(row.id, row.wallet)?.stage).toBe("uncertain"); expect(store.request(row.id, row.wallet)?.signature).toBe("signature");
      await expect(client["adoptLegacy"]()).rejects.toThrow("Invalid signature status"); expect(store.request(row.id, row.wallet)?.scope?.genesis).toBeUndefined();
    }
  } finally { client.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
