import { expect, test } from "bun:test";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "../src/token";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { verifyMessage } from "./signing";
import { Store } from "../src/store";
import { FossaClient } from "../src/client";
import type { Account, Catalog, PublicConfig } from "../src/types";
import { make } from "@opencode/ai/promise";
import { configure } from "@opencode/ai/providers/openai-compatible";
import { rustProvider } from "./provider";

const providerTest = test.skipIf(!process.env.FOSSA_PROVIDER_ROOT);

async function fixture(customError = 2) {
  const directory = mkdtempSync(join(tmpdir(), "fossa-client-test-")), store = new Store(directory);
  const owner = await Keypair.generate(), lane = await Keypair.generate(), booking = await Keypair.generate(), provider = await Keypair.generate(), program = (await Keypair.generate()).publicKey, market = (await Keypair.generate()).publicKey, model = (await PublicKey.findProgramAddress([Buffer.from("model"), market.toBytes(), createHash("sha256").update("fixture/coder").digest()], program))[0], mint = (await Keypair.generate()).publicKey;
  const source = await getAssociatedTokenAddress(mint, owner.publicKey), vault = await getAssociatedTokenAddress(mint, (await PublicKey.findProgramAddress([Buffer.from("vault"), lane.publicKey.toBytes()], program))[0], true);
  const userData = Buffer.alloc(120); userData.write("USER0V20"); Buffer.from(owner.publicKey.toBytes()).copy(userData, 8); Buffer.from(market.toBytes()).copy(userData, 40); Buffer.from(vault.toBytes()).copy(userData, 80);
  const bookData = Buffer.alloc(368); bookData.write("BOOK0V20"); Buffer.from(owner.publicKey.toBytes()).copy(bookData, 8); Buffer.from(market.toBytes()).copy(bookData, 72); Buffer.from(lane.publicKey.toBytes()).copy(bookData, 192); Buffer.from(owner.publicKey.toBytes()).copy(bookData, 256); bookData[148] = 5;
  const tokenData = Buffer.alloc(165); Buffer.from(mint.toBytes()).copy(tokenData); Buffer.from(owner.publicKey.toBytes()).copy(tokenData, 32); tokenData.writeBigUInt64LE(10_000_000n, 64);
  const modelData = Buffer.alloc(144); modelData.write("MODELV20"); Buffer.from(market.toBytes()).copy(modelData, 8);
  let signature = "", submitted = 0, lostFirst = false, hideStatus = false, catalogReads = 0;
  const confirmedSignatures = new Set<string>();
  const deleted = (await Keypair.generate()).publicKey.toString(), failures = new Set<string>();
  type SocketData = { subscribed: boolean; live?: boolean; watch?: string };
  const sockets = new Set<import("bun").ServerWebSocket<SocketData>>();
  const records = new Map([[source.toString(), { data: tokenData, owner: TOKEN_PROGRAM_ID }], [lane.publicKey.toString(), { data: userData, owner: program }], [booking.publicKey.toString(), { data: bookData, owner: program }]]);
  records.set(model.toString(), { data: modelData, owner: program });
  let cfg: PublicConfig, catalog: Catalog, providerServer: Awaited<ReturnType<typeof rustProvider>>;
  const server = Bun.serve<SocketData>({ hostname: "127.0.0.1", port: 0, websocket: {
    async open(socket) {
      sockets.add(socket);
      if (socket.data.live) {
        socket.send(JSON.stringify({ type: "catalog", data: catalog }));
        socket.send(JSON.stringify({ type: "chain", data: { blockhash: (await Keypair.generate()).publicKey.toString(), lastValidBlockHeight: 500, bookingRent: "1000", signatureFee: "5000", maxAgeMs: 30_000 } }));
      }
    },
    close(socket) { sockets.delete(socket); },
    message(socket, message) {
      const body = JSON.parse(String(message));
      if (socket.data.live) { socket.data.watch = body.watch; return; }
      socket.data.subscribed = body.method === "accountSubscribe";
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: body.method.endsWith("Unsubscribe") ? true : 1 }));
    },
  }, async fetch(request, server) {
    const url = new URL(request.url), json = (value: unknown) => Response.json(value);
    if (url.pathname === "/rpc" && request.method === "GET" && server.upgrade(request, { data: { subscribed: false } })) return;
    if (url.pathname === "/v1/opencode/live" && server.upgrade(request, { data: { subscribed: false, live: true } })) return;
    if (url.pathname === "/v1/config") return json(cfg);
    if (url.pathname === "/v1/market/catalog") { catalogReads++; return json(catalog); }
    if (url.pathname === "/v1/opencode/receipts") return json({ receipts: bookData[148] === 5 ? store.pending(owner.publicKey.toString()).filter(row => row.generation === bookData.readBigUInt64LE(152).toString()).map(row => ({ booking: row.booking, generation: row.generation, charge: "0" })) : [] });
    if (url.pathname === "/upstream/chat/completions") {
      const body = await request.json() as { model: string };
      const chunk = { id: "fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 0 }, total_tokens: 28 } };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname !== "/rpc") return new Response("Not found", { status: 404 });
    const body = await request.json() as { id: unknown; method: string; params: any[] }; let result: unknown;
    if (body.method === "getGenesisHash") result = "fixture-mainnet-genesis";
    else if (body.method === "getLatestBlockhash") result = { context: { slot: 100 }, value: { blockhash: (await Keypair.generate()).publicKey.toString(), lastValidBlockHeight: 500 } };
    else if (body.method === "getMinimumBalanceForRentExemption") result = 1000;
    else if (body.method === "getFeeForMessage") result = { context: { slot: 100 }, value: 5000 };
    else if (body.method === "getBlockHeight") result = 100;
    else if (body.method === "getSignatureStatuses") result = { context: { slot: 100 }, value: body.params[0].map((value: string) => !hideStatus && (confirmedSignatures.has(value) || failures.has(value)) ? { slot: 100, confirmations: 1, confirmationStatus: "confirmed", err: failures.has(value) ? { InstructionError: [1, { Custom: customError }] } : null } : null) };
    else if (body.method === "getMultipleAccounts") result = { context: { slot: 100 }, value: body.params[0].map((address: string) => {
      const value = records.get(address); if (!value) return address === owner.publicKey.toString() ? { data: ["", "base64"], owner: "11111111111111111111111111111111", lamports: 1_000_000, executable: false, rentEpoch: 0 } : null;
      return { data: [value.data.toString("base64"), "base64"], owner: value.owner.toString(), lamports: 1000, executable: false, rentEpoch: 0 };
    }) };
    else if (body.method === "getAccountInfo") { const value = records.get(body.params[0]); result = { context: { slot: 100 }, value: value ? { data: [value.data.toString("base64"), "base64"], owner: value.owner.toString(), lamports: 1000, executable: false, rentEpoch: 0 } : null }; }
    else if (body.method === "sendTransaction") {
      const tx = Transaction.from(Buffer.from(body.params[0], "base64")); expect(await tx.verifySignatures()).toBe(true);
      signature = (await import("bs58")).default.encode(tx.signatures[0].signature!);
      expect(store.pending(owner.publicKey.toString()).some(row => row.signature === signature && row.transaction === body.params[0])).toBe(true);
      if (confirmedSignatures.has(signature)) return json({ jsonrpc: "2.0", id: body.id, result: signature });
      confirmedSignatures.add(signature);
      submitted++;
      const instruction = tx.instructions.find(value => value.programId.equals(program) && value.data[0] === 6)!;
      if (instruction.keys[6].pubkey.toString() === deleted) { failures.add(signature); return json({ jsonrpc: "2.0", id: body.id, result: signature }); }
      expect(instruction.data.length).toBe(116);
      const payload = Buffer.from(instruction.data.subarray(1));
      const target = records.get(instruction.keys[6].pubkey.toString())!.data;
      const matched = catalog.models[0].offers.find(offer => offer.inputRate <= payload.readUInt32LE(32) && offer.cachedRate <= payload.readUInt32LE(36) && offer.outputRate <= payload.readUInt32LE(40) && offer.speed >= payload.readUInt16LE(44) && (!payload[54] || offer.private));
      if (!matched) throw Error("Fixture found no provider matching signed routing constraints");
      const depositInstruction = tx.instructions.find(value => value.programId.equals(program) && value.data[0] === 3), deposit = depositInstruction ? Buffer.from(depositInstruction.data).readBigUInt64LE(1) : 0n;
      tokenData.writeBigUInt64LE(tokenData.readBigUInt64LE(64) - deposit, 64);
      userData.writeBigUInt64LE(userData.readBigUInt64LE(72) + deposit - payload.readBigUInt64LE(55), 72);
      Buffer.from(model.toBytes()).copy(target, 224); Buffer.from(new PublicKey(matched.provider.wallet).toBytes()).copy(target, 40); payload.subarray(107, 115).copy(target, 152); payload.subarray(55, 63).copy(target, 104); payload.subarray(46, 50).copy(target, 124); payload.subarray(50, 54).copy(target, 128); target.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000) + 300 + Math.ceil(payload.readUInt32LE(50) / matched.speed)), 132); target[148] = 0; target.copy(userData, 113, 152, 159); target.writeUInt32LE(matched.slot, 352);
      for (const socket of sockets) if (socket.data.subscribed) socket.send(JSON.stringify({ jsonrpc: "2.0", method: "accountNotification", params: { subscription: 1, result: { context: { slot: 100 }, value: { data: [target.toString("base64"), "base64"], owner: program.toString(), lamports: 1000, executable: false, rentEpoch: 0 } } } }));
      for (const socket of sockets) if (socket.data.live && socket.data.watch === instruction.keys[6].pubkey.toString()) socket.send(JSON.stringify({ type: "booking", address: socket.data.watch, data: { owner: program.toString(), data: target.toString("base64"), slot: 100 } }));
      if (lostFirst) { lostFirst = false; return new Response("Submission response lost", { status: 503 }); }
      result = signature;
    } else throw Error(`Unexpected fixture RPC ${body.method}`);
    return json({ jsonrpc: "2.0", id: body.id, result });
  } });
  cfg = { programId: program.toString(), market: market.toString(), usdcMint: mint.toString(), solanaRpc: server.url.origin + "/rpc", opencode: { siteUrl: server.url.origin, deviceTtlSecs: 60, maxInputTokens: 65536, maxRequestBytes: 2_200_000, catalogMaxAgeMs: 30_000, requestTimeoutMs: 5000, pollIntervalMs: 100, mainnetGenesisHash: "fixture-mainnet-genesis", localBookingPoolSize: 2 } };
  catalog = { ready: true, slot: 100, programId: cfg.programId, market: cfg.market, models: [{ id: "fixture/coder", address: model.toString(), name: "Fixture coder", terms: (await Keypair.generate()).publicKey.toString(), capacity: (await Keypair.generate()).publicKey.toString(), contextTokens: 65536, outputTokens: 8192, capabilities: { tools: true, reasoning: true }, modalities: { input: ["text"], output: ["text"] }, offers: [{ slot: 0, provider: { wallet: provider.publicKey.toString(), name: "Fixture provider", endpoint: server.url.origin + "/v1/chat/completions", approved: true }, inputRate: 500000, cachedRate: 40000, outputRate: 2000000, speed: 100, available: true, approved: true, active: true, private: false, fundedBond: "100000000", exposure: "0", capacity: 10, activeBookings: 0 }] }] };
  providerServer = await rustProvider({ rpc: cfg.solanaRpc, program: cfg.programId, market: cfg.market, mint: cfg.usdcMint, seed: [...provider.secretKey.slice(0, 32)] });
  catalog.models[0].offers[0].provider.endpoint = providerServer.url + "/v1/chat/completions";
  const account: Account = { walletId: "fixture-wallet", wallet: owner.publicKey.toString(), lane: lane.publicKey.toString(), name: "Fixture", apiUrl: server.url.origin, rpcUrl: server.url.origin + "/rpc", rpcWsUrl: server.url.origin.replace("http:", "ws:") + "/rpc", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 100000 };
  await store.save(account, { owner: [...owner.secretKey], lane: [...lane.secretKey], bookings: { [booking.publicKey.toString()]: [...booking.secretKey] } }, "fixture wallet passphrase");
  const client = new FossaClient(store, account, () => {}); await client.start();
  for (let attempt = 0; attempt < 100 && !client["chain"]; attempt++) await Bun.sleep(5);
  expect(client["chain"]).toBeDefined();
  return { client, store, account, provider, owner, bookData, tokenData, cfg, catalog,
    catalogReads: () => catalogReads,
    publishCatalog: () => { for (const socket of sockets) if (socket.data.live) socket.send(JSON.stringify({ type: "catalog", data: catalog })); },
    addBooking: async () => { const address = (await Keypair.generate()).publicKey.toString(), data = Buffer.from(bookData); data[148] = 5; data.writeBigUInt64LE(0n, 152); records.set(address, { data, owner: program }); client.wallet!.bookings.push({ address, status: 5, generation: "0", rentPayer: owner.publicKey.toString() }); return address; },
    staleBooking: () => { client.wallet!.bookings.unshift({ address: deleted, status: 5, generation: "0", rentPayer: owner.publicKey.toString() }); },
    closeBooking: () => { for (const socket of sockets) if (socket.data.live) socket.send(JSON.stringify({ type: "booking", address: booking.publicKey.toString(), data: { owner: null, data: null, slot: 101, version: 1 } })); },
    submissions: () => submitted, hideStatus: () => { hideStatus = true; }, loseResponse: () => { lostFirst = true; }, close: async () => { client.stop(); await providerServer.close(); await Bun.sleep(600); store.close(); server.stop(true); owner.secretKey.fill(0); provider.secretKey.fill(0); rmSync(directory, { recursive: true, force: true }); } };
}

for (const streamed of [true, false]) providerTest(`settlement admission resumes from ${streamed ? "live catalog" : "HTTP fallback"} without another payment`, async () => {
  const f = await fixture(), model = f.catalog.models[0], offer = model.offers[0];
  const body = JSON.stringify({ model: model.id, messages: [{ role: "user", content: "Hello" }], max_tokens: 128 });
  Object.assign(offer, { fundedBond: "1000", exposure: "900", activeBookings: 1 });
  await f.client.refresh();
  try {
    const pending = f.client.request("settlement", model.id, body, "session", "primary", new AbortController().signal);
    const deadline = Date.now() + 1000;
    while (!f.client["catalogWaiters"].size && Date.now() < deadline) await Bun.sleep(1);
    expect(f.client["catalogWaiters"].size).toBe(1);
    expect(f.submissions()).toBe(0); expect(f.store.pending(f.account.wallet)).toHaveLength(0);
    Object.assign(offer, { exposure: "100", activeBookings: 0 }); f.catalog.slot++;
    if (streamed) f.publishCatalog();
    expect((await pending).url).toBe(offer.provider.endpoint!);
    expect(f.submissions()).toBe(1); expect(f.store.pending(f.account.wallet)).toHaveLength(1);
    expect(f.client["catalogWaiters"].size).toBe(0);
  } finally { await f.close(); }
});

for (const action of ["abort", "stop", "timeout"] as const) providerTest(`settlement admission ${action} leaves no signed or pending payment`, async () => {
  const f = await fixture(), model = f.catalog.models[0], controller = new AbortController();
  Object.assign(model.offers[0], { fundedBond: "1000", exposure: "900", activeBookings: 1 });
  if (action === "timeout") f.cfg.opencode.requestTimeoutMs = f.client.cfg.opencode.requestTimeoutMs = 50;
  await f.client.refresh();
  try {
    const pending = f.client.request(action, model.id, JSON.stringify({ model: model.id, messages: [{ role: "user", content: "Hello" }], max_tokens: 128 }), "session", "primary", controller.signal);
    const result = pending.then(() => null, error => error);
    const deadline = Date.now() + 1000;
    while (!f.client["catalogWaiters"].size && Date.now() < deadline) await Bun.sleep(1);
    if (action === "abort") controller.abort(new Error("fixture cancelled"));
    if (action === "stop") f.client.stop();
    expect((await result)?.message).toContain(action === "abort" ? "fixture cancelled" : action === "stop" ? "connection closed" : "collateral");
    expect(f.submissions()).toBe(0); expect(f.store.pending(f.account.wallet)).toHaveLength(0);
    expect(f.client["catalogWaiters"].size).toBe(0);
  } finally { await f.close(); }
});

providerTest("funded admission adds no catalog read and permanent shortfall fails without waiting", async () => {
  const f = await fixture(), model = f.catalog.models[0], body = JSON.stringify({ model: model.id, messages: [{ role: "user", content: "Hello" }], max_tokens: 128 });
  try {
    Object.assign(model.offers[0], { fundedBond: "10", exposure: "0", activeBookings: 1 });
    await f.client.refresh(); const before = f.catalogReads();
    await expect(f.client.request("shortfall", model.id, body, "session", "primary", new AbortController().signal)).rejects.toThrow("more provider collateral");
    expect(f.catalogReads()).toBe(before); expect(f.submissions()).toBe(0);
    Object.assign(model.offers[0], { fundedBond: "100000000", activeBookings: 0 });
    await f.client.refresh(); const funded = f.catalogReads();
    await f.client.request("funded", model.id, body, "session", "primary", new AbortController().signal);
    await f.client.refresh();
    expect(f.catalogReads()).toBe(funded + 1); expect(f.submissions()).toBe(1);
  } finally { await f.close(); }
});

providerTest("older HTTP catalog cannot replace newer live settlement state within the same slot", async () => {
  const f = await fixture();
  try {
    const previous = structuredClone(f.client.catalog!), version = f.client["catalogVersion"];
    previous.models[0].offers[0].exposure = "900";
    const settled = structuredClone(previous); settled.models[0].offers[0].exposure = "100";
    f.client["updateCatalog"](settled);
    f.client["updateCatalog"](previous, version);
    expect(f.client.catalog!.models[0].offers[0].exposure).toBe("100");
    previous.slot--;
    f.client["updateCatalog"](previous);
    expect(f.client.catalog!.models[0].offers[0].exposure).toBe("100");
  } finally { await f.close(); }
});

for (const legacy of [false, true]) providerTest(`confirmed undispatched ${legacy ? "legacy" : "journaled"} reservation preserves funds and allows another chat`, async () => {
  const f = await fixture(), body = JSON.stringify({ model: "fixture/coder", messages: [{ role: "user", content: "Hello" }], max_tokens: 128 });
  try {
    await f.client.request("interrupted", "fixture/coder", body, "first-chat", "primary", new AbortController().signal);
    const row = f.store.pending(f.account.wallet)[0];
    row.stage = "uncertain";
    if (legacy) { delete row.dispatchStarted; delete row.provider; delete row.endpoint; }
    f.store.put(row);
    await f.client["reconcile"](true);
    expect(f.store.pending(f.account.wallet)[0].stage).toBe("reserved");
    expect(f.submissions()).toBe(1);
    const wallet = f.client["availableWallet"]();
    expect(BigInt(wallet.usdcAtomic) + BigInt(wallet.freeAtomic) + BigInt(row.reserve)).toBe(10_000_000n);
    expect(wallet.bookings.some(booking => booking.address === row.booking)).toBe(false);
    const secondBooking = await f.addBooking();
    const next = await f.client.request("second-request", "fixture/coder", body, "second-chat", "primary", new AbortController().signal);
    expect(next.headers.get("x-fossa-booking")).toBe(secondBooking);
    expect(f.submissions()).toBe(2);
    expect(f.store.pending(f.account.wallet)[0].signature).toBe(row.signature);
    f.bookData[148] = 3;
    await f.client["reconcile"](true);
    expect(f.store.pending(f.account.wallet)[0].stage).toBe("released");
    expect(f.store.pending(f.account.wallet)[0].charge).toBe("0");
  } finally { await f.close(); }
});

for (const legacy of [false, true]) providerTest(`possibly dispatched ${legacy ? "legacy" : "journaled"} request keeps recovery guard`, async () => {
  const f = await fixture(), body = JSON.stringify({ model: "fixture/coder", messages: [{ role: "user", content: "Hello" }], max_tokens: 128 });
  try {
    await f.client.request("interrupted", "fixture/coder", body, "session", "primary", new AbortController().signal);
    f.client.dispatched("interrupted", Date.now());
    const row = f.store.pending(f.account.wallet)[0];
    expect(row.dispatchStarted).toBe(true);
    if (legacy) delete row.dispatchStarted;
    row.stage = "uncertain"; f.store.put(row);
    await expect(f.client.request("replacement", "fixture/coder", body, "other-chat", "primary", new AbortController().signal)).rejects.toThrow("Previous payment");
    expect(f.store.pending(f.account.wallet)[0].stage).toBe("uncertain");
    expect(f.submissions()).toBe(1);
  } finally { await f.close(); }
});

providerTest("missing transaction confirmation cannot become a safe reservation", async () => {
  const f = await fixture(), body = JSON.stringify({ model: "fixture/coder", messages: [{ role: "user", content: "Hello" }], max_tokens: 128 });
  try {
    await f.client.request("unconfirmed", "fixture/coder", body, "session", "primary", new AbortController().signal);
    const row = f.store.pending(f.account.wallet)[0]; row.stage = "uncertain"; f.store.put(row);
    f.hideStatus(); f.client.cfg.opencode.requestTimeoutMs = 80;
    await expect(f.client.request("replacement", "fixture/coder", body, "other-chat", "primary", new AbortController().signal)).rejects.toThrow("unresolved");
    expect(f.store.pending(f.account.wallet)[0].stage).toBe("uncertain");
    expect(f.store.pending(f.account.wallet)[0].signature).toBe(row.signature);
    expect(f.submissions()).toBe(1);
  } finally { await f.close(); }
});

providerTest("recovery cannot overwrite a newer provider dispatch while account read is pending", async () => {
  const f = await fixture(), body = JSON.stringify({ model: "fixture/coder", messages: [{ role: "user", content: "Hello" }], max_tokens: 128 });
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  try {
    await f.client.request("interrupted", "fixture/coder", body, "session", "primary", new AbortController().signal);
    const row = f.store.pending(f.account.wallet)[0]; row.stage = "uncertain"; f.store.put(row);
    const read = f.client["rpc"].getAccountInfo.bind(f.client["rpc"]);
    f.client["rpc"].getAccountInfo = async (...args) => { enter(); await gate; return read(...args); };
    const recovery = f.client["reconcile"](true);
    await entered; f.client.dispatched(row.id, Date.now()); release(); await recovery;
    const latest = f.store.pending(f.account.wallet)[0];
    expect(latest.dispatchStarted).toBe(true); expect(latest.stage).toBe("uncertain"); expect(f.submissions()).toBe(1);
  } finally { release(); await f.close(); }
});

providerTest("confirmed missing-booking failure refreshes pool and safely retries once", async () => {
  const f = await fixture();
  try {
    f.staleBooking();
    const routed = await f.client.request("stale-pool", "fixture/coder", JSON.stringify({ model: "fixture/coder", messages: [{ role: "user", content: "Hello" }], max_tokens: 32 }), "session", "primary", new AbortController().signal);
    expect(routed.url).toBe(f.catalog.models[0].offers[0].provider.endpoint!);
    expect(f.submissions()).toBe(2);
    const rows = f.store.pending(f.account.wallet);
    expect(rows.filter(row => row.stage === "failed")).toHaveLength(1);
    expect(rows.filter(row => row.stage === "inference")).toHaveLength(1);
    expect(f.bookData.readBigUInt64LE(152)).toBe(1n);
  } finally { await f.close(); }
});

providerTest("streamed booking deletion removes storage without disconnecting native client", async () => {
  const f = await fixture();
  try {
    expect(f.client.wallet!.bookings).toHaveLength(1);
    f.closeBooking();
    for (let attempt = 0; attempt < 100 && f.client.wallet!.bookings.length; attempt++) await Bun.sleep(5);
    expect(f.client.wallet!.bookings).toHaveLength(0);
    expect(f.client.status.connected).toBe(true);
  } finally { await f.close(); }
});

providerTest("other confirmed program errors never trigger a replacement booking", async () => {
  const f = await fixture(20);
  try {
    f.staleBooking();
    await expect(f.client.request("other-error", "fixture/coder", JSON.stringify({ model: "fixture/coder", messages: [{ role: "user", content: "Hello" }], max_tokens: 32 }), "session", "primary", new AbortController().signal)).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });
    expect(f.submissions()).toBe(1);
    expect(f.store.pending(f.account.wallet).filter(row => row.stage === "failed")).toHaveLength(1);
  } finally { await f.close(); }
});

providerTest("native OpenCode encoder routes a signed booking through the real provider validator and reconciles usage", async () => {
  const f = await fixture(), ai = make();
  f.catalog.models[0].outputTokens = 393216;
  await f.client.refresh();
  const bridge = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const routed = await f.client.request("native-encoder", "fixture/coder", await request.text(), "session", "primary", request.signal);
    const outbound = new Request(routed.url, { method: "POST", body: routed.body, headers: routed.headers });
    return f.client.response(outbound, await fetch(outbound));
  } });
  try {
    const result = await ai.llm.generate({ model: configure({ provider: "fossa", apiKey: "fixture", baseURL: `${bridge.url.origin}/v1` }).model("fixture/coder"), prompt: "Hello", generation: { maxTokens: 393216 } });
    expect(result.text).toBe("Hello"); expect(f.submissions()).toBe(1);
    expect(f.bookData.readUInt32LE(128)).toBe(393216);
    expect(f.store.pending(f.account.wallet)[0].usage).toEqual({ input: 20, cached: 0, output: 8 });
    f.bookData[148] = 1; f.bookData.writeBigUInt64LE(26n, 160);
    await f.client["reconcile"]();
    expect(f.store.pending(f.account.wallet)[0].stage).toBe("settled");
    expect(f.store.pending(f.account.wallet)[0].charge).toBe("26");
  } finally { await ai.dispose(); bridge.stop(true); await f.close(); }
});

providerTest("booking bytes are journaled before submission and signed authorization binds exact body", async () => {
  const f = await fixture();
  try {
    const body = JSON.stringify({ model: "fixture/coder", messages: [{ role: "user", content: "hello" }], max_tokens: 128, stream: true });
    f.loseResponse(); const routed = await f.client.request("same-logical-call", "fixture/coder", body, "session", "primary", new AbortController().signal);
    expect(f.submissions()).toBe(1);
    const hash = createHash("sha256").update(body).digest("hex"), row = f.store.pending(f.account.wallet)[0];
    expect(routed.headers.get("x-fossa-body-sha256")).toBe(hash);
    const message = Buffer.from(`fossa-infer-v2:${f.cfg.programId}:${f.cfg.market}:${row.booking}:${row.generation}:${f.provider.publicKey}:${hash}`);
    expect(verifyMessage(message, Buffer.from(routed.headers.get("x-fossa-signature")!, "base64"), f.owner.publicKey.toBytes())).toBe(true);
    const retry = await f.client.request("same-logical-call", "fixture/coder", body, "session", "primary", new AbortController().signal);
    expect(retry.headers.get("x-fossa-booking")).toBe(routed.headers.get("x-fossa-booking")); expect(f.submissions()).toBe(1);
    await expect(f.client.request("same-logical-call", "fixture/coder", body.replace("hello", "changed"), "session", "primary", new AbortController().signal)).rejects.toThrow("changed");
  } finally { await f.close(); }
});
providerTest("insufficient funds and model price caps reject without submitting a transaction", async () => {
  const f = await fixture();
  try {
    const body = JSON.stringify({ model: "fixture/coder", messages: [{ role: "user", content: "hello" }], max_tokens: 128 });
    f.tokenData.writeBigUInt64LE(0n, 64);
    await f.client.refresh();
    await expect(f.client.request("unfunded", "fixture/coder", body, "session", "primary", new AbortController().signal)).rejects.toThrow("USDC"); expect(f.submissions()).toBe(0);
    f.tokenData.writeBigUInt64LE(10_000_000n, 64); f.store.setSettings(f.account.walletId, "fixture/coder", { ...f.client.settings("fixture/coder"), maxInputPrice: 0 });
    await f.client.refresh();
    await expect(f.client.request("price-cap", "fixture/coder", body, "session", "primary", new AbortController().signal)).rejects.toThrow("No provider matches"); expect(f.submissions()).toBe(0);
  } finally { await f.close(); }
});

providerTest("per-model routing modes constrain signed bookings to the selected ranking", async () => {
  const f = await fixture();
  try {
    const model = f.catalog.models[0], template = model.offers[0];
    model.offers = [
      { ...template, slot: 0, speed: 50, inputRate: 100000, cachedRate: 0, outputRate: 100000 },
      { ...template, slot: 1, speed: 125, inputRate: 300000, cachedRate: 0, outputRate: 300000 },
      { ...template, slot: 2, speed: 200, inputRate: 1000000, cachedRate: 0, outputRate: 1000000 },
    ];
    const body = JSON.stringify({ model: model.id, max_tokens: 128, messages: [{ role: "user", content: "Hello" }] });
    for (const [mode, slot] of [["cheapest", 0], ["balanced", 1], ["fastest", 2]] as const) {
      f.bookData[148] = 5;
      await f.client.refresh();
      f.store.setSettings(f.account.walletId, model.id, { ...f.client.settings(model.id), mode });
      await f.client.request(mode, model.id, body, "session", "primary", new AbortController().signal);
      expect(f.bookData.readUInt32LE(352)).toBe(slot);
    }
    expect(f.submissions()).toBe(3);
  } finally { await f.close(); }
});

providerTest("continued chat signs unrestricted caps and cache provenance before provider selection", async () => {
  const f = await fixture();
  try {
    const model = f.catalog.models[0], messages = [{ role: "user", content: "a".repeat(4096) }];
    const body = JSON.stringify({ model: model.id, max_tokens: 128, messages });
    const routed = await f.client.request("history", model.id, body, "session", "primary", new AbortController().signal);
    await f.client.response(new Request(routed.url, { headers: routed.headers }), await fetch(routed.url, { method: "POST", headers: routed.headers, body })).text();
    const template = model.offers[0];
    model.offers = [
      { ...template, inputRate: 2000000, cachedRate: 100000, outputRate: 1000000 },
      { ...template, slot: 1, provider: { ...template.provider, wallet: (await Keypair.generate()).publicKey.toString() }, inputRate: 1000000, cachedRate: 100000, outputRate: 1000000 },
    ];
    f.bookData[148] = 5;
    await f.client.refresh();
    const prior = f.store.pending(f.account.wallet).find(row => row.id === "history")!;
    f.store.put({ ...prior, stage: "settled", usage: { input: 1000, output: 10, cached: 0 } });
    f.store.setSettings(f.account.walletId, model.id, { ...f.client.settings(model.id), mode: "cheapest" });
    const continuation = JSON.stringify({ model: model.id, max_tokens: 128, messages: [...messages, { role: "assistant", content: "Hello" }, { role: "user", content: "Continue" }] });
    await f.client.request("continuation", model.id, continuation, "session", "primary", new AbortController().signal);
    const row = f.store.pending(f.account.wallet).find(row => row.id === "continuation")!;
    const instruction = Transaction.from(Buffer.from(row.transaction, "base64")).instructions.find(value => value.data[0] === 6 && value.programId.toString() === f.cfg.programId)!;
    for (const offset of [33, 37, 41]) expect(Buffer.from(instruction.data).readUInt32LE(offset)).toBe(0xffffffff);
    expect(Buffer.from(instruction.data).readUInt32LE(68)).toBe(1010);
    expect(new PublicKey(instruction.data.subarray(76, 108)).toString()).toBe(f.provider.publicKey.toString());
    expect(f.bookData.readUInt32LE(352)).toBe(0);
  } finally { await f.close(); }
});

providerTest("uncertain provider acceptance blocks a second payment until chain outcome is known", async () => {
  const f = await fixture();
  try {
    const body = JSON.stringify({ model: "fixture/coder", messages: [{ role: "user", content: "hello" }], max_tokens: 128 });
    const routed = await f.client.request("first", "fixture/coder", body, "session", "primary", new AbortController().signal);
    f.client.response(new Request(routed.url, { headers: routed.headers }), new Response("Unknown provider outcome", { status: 502 }));
    await expect(f.client.request("replacement", "fixture/coder", body, "session", "primary", new AbortController().signal)).rejects.toThrow("recovering automatically");
    expect(f.submissions()).toBe(1);
  } finally { await f.close(); }
});

providerTest("concurrent physical retries share one booking and streamed tools remain byte-identical", async () => {
  const f = await fixture();
  try {
    const body = JSON.stringify({ model: "fixture/coder", messages: [{ role: "user", content: "hello" }], max_tokens: 128, stream: true });
    const [one, two] = await Promise.all([f.client.request("concurrent", "fixture/coder", body, "session", "primary", new AbortController().signal), f.client.request("concurrent", "fixture/coder", body, "session", "primary", new AbortController().signal)]);
    expect(f.submissions()).toBe(1); expect(one.headers.get("x-fossa-signature")).toBe(two.headers.get("x-fossa-signature"));
    const stream = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-read", type: "function", function: { name: "read", arguments: '{"path":"main.ts"}' } }] }, finish_reason: "tool_calls" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 17, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 5 } } })}\n\ndata:[DONE]`;
    const response = f.client.response(new Request(one.url, { headers: one.headers }), new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    expect(await response.text()).toBe(stream);
    const row = f.store.pending(f.account.wallet).find(row => row.id === "concurrent")!; expect(row.stage).toBe("settling"); expect(row.usage).toEqual({ input: 17, output: 9, cached: 5 });
  } finally { await f.close(); }
});

providerTest("signed cancellation releases undispatched request without rebooking or changing original authorization", async () => {
  const f = await fixture();
  try {
    const body = JSON.stringify({ model: "fixture/coder", messages: [{ role: "user", content: "hello" }], max_tokens: 128 });
    const routed = await f.client.request("cancelled", "fixture/coder", body, "session", "primary", new AbortController().signal);
    const before = f.store.request("cancelled", f.account.wallet)!;
    await Promise.all([f.client.cancel("cancelled"), f.client.cancel("cancelled")]);
    const row = f.store.request("cancelled", f.account.wallet)!;
    expect(row.cancelRequested).toBe(true); expect(row.cancelSent).toBe(true);
    expect(row.bodyHash).toBe(before.bodyHash); expect(row.transaction).toBe(before.transaction);
    expect((await fetch(routed.url, { method: "POST", headers: routed.headers, body })).status).toBe(409);
    await expect(f.client.request("cancelled", "fixture/coder", body, "session", "primary", new AbortController().signal)).rejects.toThrow("cancelled");
    expect(f.submissions()).toBe(1);
    f.store.put({ ...before, stage: "inference" });
    expect(f.store.request("cancelled", f.account.wallet)!.cancelRequested).toBe(true);
    expect(f.store.request("cancelled", f.account.wallet)!.stage).toBe("uncertain");
  } finally { await f.close(); }
});

providerTest("aborting active response cancels reader and durably marks original booking for recovery", async () => {
  const f = await fixture();
  try {
    const body = JSON.stringify({ model: "fixture/coder", messages: [{ role: "user", content: "hello" }], max_tokens: 128, stream: true });
    const controller = new AbortController();
    const routed = await f.client.request("active-stop", "fixture/coder", body, "session", "primary", controller.signal);
    let cancelled = false;
    const upstream = new ReadableStream<Uint8Array>({ start(value) { value.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')); }, cancel() { cancelled = true; } });
    const response = f.client.response(new Request(routed.url, { headers: routed.headers, signal: controller.signal }), new Response(upstream, { headers: { "content-type": "text/event-stream" } }));
    const reader = response.body!.getReader(); await reader.read(); controller.abort();
    await reader.read();
    expect(cancelled).toBe(true);
    await f.client.cancel("active-stop");
    expect(f.store.request("active-stop", f.account.wallet)!.cancelRequested).toBe(true);
    expect(f.store.request("active-stop", f.account.wallet)!.stage).toBe("uncertain");
    expect(f.submissions()).toBe(1);
  } finally { await f.close(); }
});

providerTest("SSE error followed by DONE stays uncertain instead of declaring successful settlement", async () => {
  const f = await fixture();
  try {
    const body = JSON.stringify({ model: "fixture/coder", messages: [{ role: "user", content: "hello" }], max_tokens: 128, stream: true });
    const routed = await f.client.request("runaway", "fixture/coder", body, "session", "primary", new AbortController().signal);
    const wire = 'data: {"error":{"message":"Runaway stopped","code":"upstream_runaway"}}\n\ndata: [DONE]\n\n';
    expect(await f.client.response(new Request(routed.url, { headers: routed.headers }), new Response(wire, { headers: { "content-type": "text/event-stream" } })).text()).toBe(wire);
    expect(f.store.request("runaway", f.account.wallet)!.stage).toBe("uncertain");
    expect(f.submissions()).toBe(1);
  } finally { await f.close(); }
});

providerTest("recovery restores cancelled booking's provider from confirmed generation without a replacement payment", async () => {
  const f = await fixture();
  try {
    const body = JSON.stringify({ model: "fixture/coder", messages: [{ role: "user", content: "hello" }], max_tokens: 128 });
    const routed = await f.client.request("recover-stop", "fixture/coder", body, "session", "primary", new AbortController().signal);
    const row = f.store.request("recover-stop", f.account.wallet)!;
    delete row.provider; delete row.endpoint; row.cancelRequested = true; row.stage = "uncertain"; f.store.put(row);
    await f.client["reconcile"](true);
    const recovered = f.store.request("recover-stop", f.account.wallet)!;
    expect(recovered.cancelSent).toBe(true); expect(recovered.provider).toBe(f.provider.publicKey.toString());
    expect(recovered.signature).toBe(row.signature); expect(recovered.generation).toBe(row.generation);
    expect((await fetch(routed.url, { method: "POST", headers: routed.headers, body })).status).toBe(409);
    expect(f.submissions()).toBe(1);
  } finally { await f.close(); }
});

providerTest("cancellation during signing discards unsubmitted bytes without journaling a replacement", async () => {
  const f = await fixture();
  try {
    const body = JSON.stringify({ model: "fixture/coder", messages: [{ role: "user", content: "hello" }], max_tokens: 128 });
    await f.client.request("original", "fixture/coder", body, "session", "primary", new AbortController().signal);
    const row = f.store.request("original", f.account.wallet)!;
    const tx = Transaction.from(Buffer.from(row.transaction, "base64")), sign = tx.sign.bind(tx), controller = new AbortController();
    tx.sign = async (...signers) => { const result = await sign(...signers); controller.abort(); return result; };
    await expect(f.client["journal"](tx, [f.owner], { ...row, id: "discarded" }, 0, controller.signal)).rejects.toThrow();
    expect(f.store.request("discarded", f.account.wallet)).toBeUndefined(); expect(f.submissions()).toBe(1);
  } finally { await f.close(); }
});
