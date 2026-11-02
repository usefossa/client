import { expect, test } from "bun:test";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "../src/token";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import { verifyMessage } from "./signing";
import { Store } from "../src/store";
import { FossaClient } from "../src/client";
import type { Account, Catalog, PublicConfig } from "../src/types";
import { make } from "@opencode/ai/promise";
import { configure } from "@opencode/ai/providers/openai-compatible";
import { rustProvider } from "./provider";
import { listRoutingAddresses, providerWalletAddress } from "../src/provider-wallet";

const discriminator = (name: string) => createHash("sha256").update(name).digest().subarray(0, 8);
const providerTest = test.skipIf(!process.env.FOSSA_PROVIDER_ROOT);

async function fixture(customError = 2, retries = 0, scoped = false) {
  const directory = mkdtempSync(join(tmpdir(), "fossa-client-test-")), store = new Store(directory);
  const owner = await Keypair.generate(), lane = await Keypair.generate(), booking = await Keypair.generate(), provider = await Keypair.generate(), program = (await Keypair.generate()).publicKey, market = (await Keypair.generate()).publicKey, model = (await PublicKey.findProgramAddress([Buffer.from("model"), market.toBytes(), createHash("sha256").update("fixture/coder").digest()], program))[0], mint = (await Keypair.generate()).publicKey;
  const source = await getAssociatedTokenAddress(mint, owner.publicKey), vault = await getAssociatedTokenAddress(mint, (await PublicKey.findProgramAddress([Buffer.from("vault"), lane.publicKey.toBytes()], program))[0], true);
  const userData = Buffer.alloc(128); userData.set(discriminator("account:User")); Buffer.from(owner.publicKey.toBytes()).copy(userData, 8); Buffer.from(market.toBytes()).copy(userData, 40); Buffer.from(vault.toBytes()).copy(userData, 80);
  const bookData = Buffer.alloc(520); bookData.set(discriminator("account:FilteredBooking")); Buffer.from(owner.publicKey.toBytes()).copy(bookData, 8); Buffer.from(market.toBytes()).copy(bookData, 72); Buffer.from(lane.publicKey.toBytes()).copy(bookData, 192); Buffer.from(owner.publicKey.toBytes()).copy(bookData, 256); bookData[148] = 5;
  const tokenData = Buffer.alloc(165); Buffer.from(mint.toBytes()).copy(tokenData); Buffer.from(owner.publicKey.toBytes()).copy(tokenData, 32); tokenData.writeBigUInt64LE(10_000_000n, 64);
  const modelData = Buffer.alloc(176); modelData.set(discriminator("account:Model")); Buffer.from(market.toBytes()).copy(modelData, 8);
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
    if (url.pathname === "/v1/opencode/receipts") return json({ receipts: bookData[148] === 5 ? store.pending(owner.publicKey.toString()).filter(row => row.generation === bookData.readBigUInt64LE(152).toString()).map(row => ({ booking: row.booking, generation: row.generation, charge: bookData.readBigUInt64LE(160).toString() })) : [] });
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
    else if (body.method === "simulateTransaction") {
      const tx = Transaction.from(Buffer.from(body.params[0], "base64"));
      expect(body.params[1].sigVerify).toBe(false);
      expect(tx.signatures.every(signer => signer.signature === null)).toBe(true);
      expect(Buffer.from(tx.instructions[0].data).readUInt32LE(1)).toBe(1_400_000);
      result = { context: { slot: 100 }, value: { err: null, unitsConsumed: 30_000, logs: [] } };
    }
    else if (body.method === "getSignatureStatuses") result = { context: { slot: 100 }, value: body.params[0].map((value: string) => !hideStatus && (confirmedSignatures.has(value) || failures.has(value)) ? { slot: 100, confirmations: 1, confirmationStatus: "confirmed", err: failures.has(value) ? { InstructionError: [1, { Custom: customError }] } : null } : null) };
    else if (body.method === "getProgramAccounts") {
      const options = body.params[1];
      expect(options.commitment).toBe(options.filters.some((filter: { dataSize?: number; memcmp?: { offset: number; bytes: string } }) => filter.memcmp?.offset === 0 && Buffer.from(bs58.decode(filter.memcmp.bytes)).equals(discriminator("account:FilteredBooking"))) ? "processed" : "confirmed");
      expect(options.withContext).toBe(true);
      expect(Number(options.minContextSlot ?? 0)).toBeLessThanOrEqual(100);
      result = { context: { slot: 100 }, value: [...records].filter(([, value]) => value.owner.toString() === body.params[0] && options.filters.every((filter: { dataSize?: number; memcmp?: { offset: number; bytes: string } }) => filter.dataSize === undefined ? filter.memcmp && value.data.subarray(filter.memcmp.offset, filter.memcmp.offset + bs58.decode(filter.memcmp.bytes).length).equals(bs58.decode(filter.memcmp.bytes)) : value.data.length === filter.dataSize)).map(([pubkey, value]) => ({ pubkey, account: { data: [value.data.toString("base64"), "base64"], owner: value.owner.toString(), lamports: 1000, executable: false, rentEpoch: 0 } })) };
    }
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
      const instruction = tx.instructions.find(value => value.programId.equals(program) && ["global:reserve_booking", "global:reserve_list_booking"].some(name => Buffer.from(value.data).subarray(0, 8).equals(discriminator(name))))!;
      if (instruction.keys[6].pubkey.toString() === deleted) { failures.add(signature); return json({ jsonrpc: "2.0", id: body.id, result: signature }); }
      expect(instruction.data.length).toBe(scoped ? 168 : 163);
      expect(Buffer.from(tx.instructions[0].data).readUInt32LE(1)).toBe(34_000);
      expect(instruction.keys).toHaveLength(scoped ? 12 : 10); expect(instruction.keys[scoped ? 11 : 9].pubkey.toString()).toBe(catalog.models[0].group ?? program.toString()); expect(instruction.data[154]).toBe(1);
      expect(instruction.keys[8].pubkey.toString()).toBe(cfg.providerList);
      expect(instruction.keys[8].isWritable).toBe(false);
      expect(instruction.keys[8].isSigner).toBe(false);
      if (scoped) {
        expect(Buffer.from(instruction.data).subarray(0, 8)).toEqual(discriminator("global:reserve_list_booking"));
        expect(instruction.data[163]).toBe(1); expect(Buffer.from(instruction.data).readUInt32LE(164)).toBe(1000);
        expect(instruction.keys[10].pubkey.toString()).toBe((await providerWalletAddress(program, market, owner.publicKey)).toString());
        const ledgerAddress = (await providerWalletAddress(program, market, owner.publicKey)).toString();
        const initialize = tx.instructions.some(value => Buffer.from(value.data).subarray(0, 8).equals(discriminator("global:initialize_provider_wallet")));
        expect(initialize).toBe(!records.has(ledgerAddress));
        if (initialize) {
          const data = Buffer.alloc(112 + 48 * 8); data.set([89, 4, 132, 220, 207, 78, 178, 52]); data.set(market.toBytes(), 8); data.set(owner.publicKey.toBytes(), 40); data.set(owner.publicKey.toBytes(), 72);
          records.set(ledgerAddress, { data, owner: program });
        }
      }
      const payload = Buffer.from(instruction.data.subarray(8));
      const target = records.get(instruction.keys[6].pubkey.toString())!.data;
      const matched = catalog.models[0].offers.find(offer => offer.inputRate <= payload.readUInt32LE(32) && offer.cachedRate <= payload.readUInt32LE(36) && offer.outputRate <= payload.readUInt32LE(40) && offer.speed >= payload.readUInt16LE(44) && (!payload[54] || offer.private) && offer.checkpoint === payload.subarray(107, 139).toString("hex") && offer.contextTokens >= Math.max(payload.readUInt32LE(141), payload.readUInt32LE(46) + payload.readUInt32LE(50)));
      if (!matched) throw Error("Fixture found no provider matching signed routing constraints");
      const depositInstruction = tx.instructions.find(value => value.programId.equals(program) && Buffer.from(value.data).subarray(0, 8).equals(discriminator("global:deposit"))), deposit = depositInstruction ? Buffer.from(depositInstruction.data).readBigUInt64LE(8) : 0n;
      tokenData.writeBigUInt64LE(tokenData.readBigUInt64LE(64) - deposit, 64);
      userData.writeBigUInt64LE(userData.readBigUInt64LE(72) + deposit - payload.readBigUInt64LE(55), 72);
      Buffer.from(new PublicKey(cfg.providerList).toBytes()).copy(target, 320);
      Buffer.from(model.toBytes()).copy(target, 224); Buffer.from(new PublicKey(matched.provider.wallet).toBytes()).copy(target, 40); payload.subarray(147, 155).copy(target, 152); payload.subarray(55, 63).copy(target, 104); payload.subarray(46, 50).copy(target, 124); payload.subarray(50, 54).copy(target, 128); target.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000) + 300 + Math.ceil(payload.readUInt32LE(50) / matched.speed)), 132); target[148] = 0; target[356] = scoped ? 2 : 0; target.copy(userData, 112, 152, 160); target.writeUInt32LE(matched.slot, 352); payload.subarray(107, 139).copy(target, 472); target.writeUInt32LE(matched.contextTokens, 504); target.writeUInt32LE(matched.inputBoundTokens, 508); target.writeUInt32LE(matched.outputTokens, 512); target.set([1, 1, payload[139], payload[140]], 516);
      for (const socket of sockets) if (socket.data.subscribed) socket.send(JSON.stringify({ jsonrpc: "2.0", method: "accountNotification", params: { subscription: 1, result: { context: { slot: 100 }, value: { data: [target.toString("base64"), "base64"], owner: program.toString(), lamports: 1000, executable: false, rentEpoch: 0 } } } }));
      for (const socket of sockets) if (socket.data.live && socket.data.watch === instruction.keys[6].pubkey.toString()) socket.send(JSON.stringify({ type: "booking", address: socket.data.watch, data: { owner: program.toString(), data: target.toString("base64"), slot: 100 } }));
      if (lostFirst) { lostFirst = false; return new Response("Submission response lost", { status: 503 }); }
      result = signature;
    } else throw Error(`Unexpected fixture RPC ${body.method}`);
    return json({ jsonrpc: "2.0", id: body.id, result });
  } });
  cfg = { programId: program.toString(), market: market.toString(), providerList: (await Keypair.generate()).publicKey.toString(), usdcMint: mint.toString(), solanaRpc: server.url.origin + "/rpc", opencode: { siteUrl: server.url.origin, deviceTtlSecs: 60, maxInputTokens: 65536, maxRequestBytes: 2_200_000, catalogMaxAgeMs: 30_000, requestTimeoutMs: 5000, pollIntervalMs: 100, mainnetGenesisHash: "fixture-mainnet-genesis", localBookingPoolSize: 2 } };
  catalog = { providerListFeeBps: 100, providerListProtocolShareBps: 5000, ready: true, slot: 100, programId: cfg.programId, market: cfg.market, providerList: cfg.providerList, models: [{ id: "fixture/coder", address: model.toString(), group: null, name: "Fixture coder", terms: (await Keypair.generate()).publicKey.toString(), capacity: (await Keypair.generate()).publicKey.toString(), contextTokens: 65536, outputTokens: 8192, capabilities: { tools: true, reasoning: true }, modalities: { input: ["text"], output: ["text"] }, offerCount: 64, offers: [{ checkpoint: createHash("sha256").update("fixture/coder@1017").digest("hex"), checkpointId: "fixture/coder@1017", checkpointName: "1017", checkpointOrder: 0, modalities: { input: ["text"], output: ["text"] }, contextTokens: 1048576, inputBoundTokens: 1048576, outputTokens: 1048576, slot: 0, provider: { wallet: provider.publicKey.toString(), name: "Fixture provider", endpoint: server.url.origin + "/v1/chat/completions" }, inputRate: 500000, cachedRate: 40000, outputRate: 2000000, speed: 100, available: true, active: true, private: false, capacity: 10, activeBookings: 0 }] }] };
  if (scoped) {
    const keys = await listRoutingAddresses(program, new PublicKey(cfg.providerList), model);
    catalog.listRoutingEnabled = true; catalog.listRouting = keys.routing.toString();
    catalog.models[0].terms = keys.terms.toString(); catalog.models[0].capacity = keys.capacity.toString();
    catalog.models[0].offers[0].capacity = 2000;
    catalog.models[0].offers[0].provider.bookingLimits = { walletWindowSeconds: 60, walletBookingsPerWindow: 5000, walletBookingCapacity: 1000 };
  }
  let providerStream: ReturnType<typeof Bun.serve>;
  try { providerStream = Bun.serve({ hostname: "127.0.0.1", port: Number(server.port) + 1, fetch(request, socket) { if (socket.upgrade(request, { data: undefined })) return; return new Response(null, { status: 400 }); }, websocket: { message(socket, message) { const request = JSON.parse(String(message)); socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: request.method.endsWith("Unsubscribe") ? true : request.id })); } } }); }
  catch (error) { server.stop(true); store.close(); rmSync(directory, { recursive: true, force: true }); if ((error as { code?: string }).code === "EADDRINUSE" && retries < 10) return fixture(customError, retries + 1, scoped); throw error; }
  providerServer = await rustProvider({ rpc: cfg.solanaRpc, program: cfg.programId, market: cfg.market, mint: cfg.usdcMint, seed: [...provider.secretKey.slice(0, 32)] });
  catalog.models[0].offers[0].provider.endpoint = providerServer.url + "/v1/chat/completions";
  const account: Account = { walletId: "fixture-wallet", wallet: owner.publicKey.toString(), lane: lane.publicKey.toString(), name: "Fixture", apiUrl: server.url.origin, rpcUrl: server.url.origin + "/rpc", rpcWsUrl: server.url.origin.replace("http:", "ws:") + "/rpc", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 100000 };
  await store.save(account, { owner: [...owner.secretKey], lane: [...lane.secretKey], bookings: { [booking.publicKey.toString()]: [...booking.secretKey] } }, "fixture wallet passphrase");
  const client = new FossaClient(store, account, () => {}); await client.start();
  for (let attempt = 0; attempt < 100 && !client["chain"]; attempt++) await Bun.sleep(5);
  expect(client["chain"]).toBeDefined();
  return { client, store, account, provider, owner, bookData, tokenData, modelData, cfg, catalog,
    catalogReads: () => catalogReads,
    publish: (value: unknown) => { for (const socket of sockets) if (socket.data.live) socket.send(JSON.stringify(value)); },
    publishCatalog: () => { for (const socket of sockets) if (socket.data.live) socket.send(JSON.stringify({ type: "catalog", data: catalog })); },
    addBooking: async () => { const address = (await Keypair.generate()).publicKey.toString(), data = Buffer.from(bookData); data[148] = 5; data.writeBigUInt64LE(0n, 152); records.set(address, { data, owner: program }); client.wallet!.bookings.push({ address, status: 5, generation: "0", rentPayer: owner.publicKey.toString() }); return address; },
    staleBooking: () => { client.wallet!.bookings.unshift({ address: deleted, status: 5, generation: "0", rentPayer: owner.publicKey.toString() }); },
    closeBooking: () => { for (const socket of sockets) if (socket.data.live) socket.send(JSON.stringify({ type: "booking", address: booking.publicKey.toString(), data: { owner: null, data: null, slot: 101, version: 1 } })); },
    submissions: () => submitted, hideStatus: () => { hideStatus = true; }, loseResponse: () => { lostFirst = true; }, close: async () => { client.stop(); await providerServer.close(); await Bun.sleep(600); store.close(); server.stop(true); providerStream.stop(true); owner.secretKey.fill(0); provider.secretKey.fill(0); rmSync(directory, { recursive: true, force: true }); } };
}

providerTest("shared model group remains in the signed native reservation", async () => {
  const f = await fixture();
  try {
    const model = f.catalog.models[0], group = (await Keypair.generate()).publicKey;
    model.group = group.toString(); f.modelData.set(group.toBytes(), 144);
    await f.client.refresh();
    const body = JSON.stringify({ model: model.id, messages: [{ role: "user", content: "Hello" }], max_tokens: 128 });
    const routed = await f.client.request("group", model.id, body, "session", "primary", new AbortController().signal);
    const response = await fetch(routed.url, { method: "POST", headers: routed.headers, body });
    expect(response.ok).toBe(true);
    expect(await f.client.response(new Request(routed.url, { headers: routed.headers }), response).text()).toContain("Hello");
    expect(f.submissions()).toBe(1);
  } finally { await f.close(); }
});

for (const streamed of [true, false]) providerTest(`capacity admission resumes from ${streamed ? "live catalog" : "HTTP fallback"} without another payment`, async () => {
  const f = await fixture(), model = f.catalog.models[0], offer = model.offers[0];
  const body = JSON.stringify({ model: model.id, messages: [{ role: "user", content: "Hello" }], max_tokens: 128 });
  Object.assign(offer, { activeBookings: 10 });
  await f.client.refresh();
  try {
    const pending = f.client.request("settlement", model.id, body, "session", "primary", new AbortController().signal);
    const deadline = Date.now() + 1000;
    while (!f.client["catalogWaiters"].size && Date.now() < deadline) await Bun.sleep(1);
    expect(f.client["catalogWaiters"].size).toBe(1);
    expect(f.submissions()).toBe(0); expect(f.store.pending(f.account.wallet)).toHaveLength(0);
    Object.assign(offer, { activeBookings: 0 }); f.catalog.slot++;
    if (streamed) f.publishCatalog();
    expect((await pending).url).toBe(offer.provider.endpoint!);
    expect(f.submissions()).toBe(1); expect(f.store.pending(f.account.wallet)).toHaveLength(1);
    expect(f.client["catalogWaiters"].size).toBe(0);
  } finally { await f.close(); }
});

for (const action of ["abort", "stop", "timeout"] as const) providerTest(`capacity admission ${action} leaves no signed or pending payment`, async () => {
  const f = await fixture(), model = f.catalog.models[0], controller = new AbortController();
  Object.assign(model.offers[0], { activeBookings: 10 });
  if (action === "timeout") f.cfg.opencode.requestTimeoutMs = f.client.cfg.opencode.requestTimeoutMs = 50;
  await f.client.refresh();
  try {
    const pending = f.client.request(action, model.id, JSON.stringify({ model: model.id, messages: [{ role: "user", content: "Hello" }], max_tokens: 128 }), "session", "primary", controller.signal);
    const result = pending.then(() => null, error => error);
    const deadline = Date.now() + 1000;
    while (!f.client["catalogWaiters"].size && Date.now() < deadline) await Bun.sleep(1);
    if (action === "abort") controller.abort(new Error("fixture cancelled"));
    if (action === "stop") f.client.stop();
    expect((await result)?.message).toContain(action === "abort" ? "fixture cancelled" : action === "stop" ? "connection closed" : "busy");
    expect(f.submissions()).toBe(0); expect(f.store.pending(f.account.wallet)).toHaveLength(0);
    expect(f.client["catalogWaiters"].size).toBe(0);
  } finally { await f.close(); }
});

providerTest("available capacity adds no catalog read and inactive offers fail without waiting", async () => {
  const f = await fixture(), model = f.catalog.models[0], body = JSON.stringify({ model: model.id, messages: [{ role: "user", content: "Hello" }], max_tokens: 128 });
  try {
    Object.assign(model.offers[0], { active: false, activeBookings: 0 });
    await f.client.refresh(); const before = f.catalogReads();
    await expect(f.client.request("shortfall", model.id, body, "session", "primary", new AbortController().signal)).rejects.toThrow("No provider matches");
    expect(f.catalogReads()).toBe(before); expect(f.submissions()).toBe(0);
    Object.assign(model.offers[0], { active: true, activeBookings: 0 });
    await f.client.refresh(); const funded = f.catalogReads();
    await f.client.request("funded", model.id, body, "session", "primary", new AbortController().signal);
    await f.client.refresh();
    expect(f.catalogReads()).toBe(funded + 1); expect(f.submissions()).toBe(1);
  } finally { await f.close(); }
});

providerTest("older HTTP catalog cannot replace newer live capacity state within the same slot", async () => {
  const f = await fixture();
  try {
    const previous = structuredClone(f.client.catalog!), version = f.client["catalogVersion"];
    previous.models[0].offers[0].activeBookings = 10;
    const settled = structuredClone(previous); settled.models[0].offers[0].activeBookings = 0;
    f.client["updateCatalog"](settled);
    f.client["updateCatalog"](previous, version);
    expect(f.client.catalog!.models[0].offers[0].activeBookings).toBe(0);
    previous.slot--;
    f.client["updateCatalog"](previous);
    expect(f.client.catalog!.models[0].offers[0].activeBookings).toBe(0);
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
    f.bookData[148] = 5; f.bookData.writeBigUInt64LE(26n, 160);
    await f.client["reconcile"]();
    expect(f.store.pending(f.account.wallet)[0].stage).toBe("settled");
    expect(f.store.pending(f.account.wallet)[0].charge).toBe("26");
  } finally { await ai.dispose(); bridge.stop(true); await f.close(); }
});

providerTest("changed provider list rejects catalog refresh before any signing", async () => {
  const f = await fixture();
  try {
    f.catalog.providerList = (await Keypair.generate()).publicKey.toString();
    await expect(f.client.refresh()).rejects.toMatchObject({ code: "MARKET_CHANGED" });
    expect(f.submissions()).toBe(0); expect(f.store.pending(f.account.wallet)).toHaveLength(0);
  } finally { await f.close(); }
});

providerTest("booking bytes are journaled before submission and signed authorization binds exact body", async () => {
  const f = await fixture();
  try {
    const body = JSON.stringify({ model: "fixture/coder", messages: [{ role: "user", content: "hello" }], max_tokens: 128, stream: true });
    f.loseResponse(); const routed = await f.client.request("same-logical-call", "fixture/coder", body, "session", "primary", new AbortController().signal);
    expect(f.submissions()).toBe(1);
    const hash = createHash("sha256").update(body).digest("hex"), row = f.store.pending(f.account.wallet)[0];
    expect(row.providerList).toBe(f.cfg.providerList);
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
    const instruction = Transaction.from(Buffer.from(row.transaction, "base64")).instructions.find(value => Buffer.from(value.data).subarray(0, 8).equals(discriminator("global:reserve_booking")) && value.programId.toString() === f.cfg.programId)!;
    for (const offset of [40, 44, 48]) expect(Buffer.from(instruction.data).readUInt32LE(offset)).toBe(0xffffffff);
    expect(Buffer.from(instruction.data).readUInt32LE(75)).toBe(1010);
    expect(new PublicKey(instruction.data.subarray(83, 115)).toString()).toBe(f.provider.publicKey.toString());
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
    await expect(reader.read()).rejects.toThrow();
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

for (const pinned of [false, true]) providerTest(`recovery ${pinned ? "retains cancelled booking endpoint after list closure" : "restores cancelled booking provider"} without a replacement payment`, async () => {
  const f = await fixture();
  try {
    const body = JSON.stringify({ model: "fixture/coder", messages: [{ role: "user", content: "hello" }], max_tokens: 128 });
    const routed = await f.client.request("recover-stop", "fixture/coder", body, "session", "primary", new AbortController().signal);
    const row = f.store.request("recover-stop", f.account.wallet)!;
    if (pinned) { f.catalog.models = []; f.catalog.ready = false; }
    else { delete row.provider; delete row.endpoint; }
    row.cancelRequested = true; row.stage = "uncertain"; f.store.put(row);
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

providerTest("confirmed receipt wakes booking reuse and records consecutive request gaps", async () => {
  const f = await fixture(), model = f.catalog.models[0];
  const body = JSON.stringify({ model: model.id, messages: [{ role: "user", content: "Hello" }], max_tokens: 128 });
  try {
    await f.client.request("gap-first", model.id, body, "gap-session", "primary", new AbortController().signal);
    f.client.dispatched("gap-first", Date.now());
    const request = new Request("http://127.0.0.1/inference", { headers: { "x-fossa-call-id": "gap-first" } });
    await f.client.response(request, new Response('data: {"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })).text();
    const first = f.store.request("gap-first", f.account.wallet)!;
    expect(first.responseCompleted).toBe(true);
    expect(first.firstByteAt!).toBeLessThanOrEqual(first.responseDoneAt!);
    expect(first.responseDoneAt!).toBeLessThanOrEqual(first.responseFinishedAt!);
    const refreshed = f.client.refresh;
    // no timer or http history refresh may release this request in the fixture.
    await f.client.refresh(); f.client.refresh = async () => {};
    const modelRequestAt = Date.now();
    const next = f.client.request("gap-next", model.id, body, "gap-session", "primary", new AbortController().signal, { modelRequestAt, transportReceivedAt: modelRequestAt });
    const waiting = Date.now() + 1000;
    while (!f.client["walletWaiters"].size && Date.now() < waiting) await Bun.sleep(1);
    expect(f.client["walletWaiters"].size).toBe(1);
    f.bookData[148] = 5;
    f.publish({ type: "wallet", data: await f.client.snapshot() });
    const receipt = { owner: f.account.wallet, provider: f.provider.publicKey.toString(), booking: first.booking, generation: first.generation, charge: "1", slot: 100 };
    f.publish({ type: "receipt", commitment: "processed", data: receipt });
    await Bun.sleep(10); expect(f.submissions()).toBe(1);
    f.publish({ type: "receipt", commitment: "confirmed", data: receipt });
    await next; f.client.dispatched("gap-next", Date.now());
    const second = f.store.request("gap-next", f.account.wallet)!;
    expect(f.store.request("gap-first", f.account.wallet)?.stage).toBe("settled");
    expect(second.previousRequestId).toBe(first.id);
    expect(second.requestGapMs).toBe(modelRequestAt - first.responseFinishedAt!);
    expect(second.gapToSubmitMs).toBe(second.submittedAt! - first.responseFinishedAt!);
    expect(second.gapToProviderMs).toBe(second.providerDispatchedAt! - first.responseFinishedAt!);
    expect(second.bookingPoolWaitMs).toBeGreaterThan(0);
    expect(f.submissions()).toBe(2);
    f.client.refresh = refreshed;
  } finally { await f.close(); }
});

providerTest("advanced token requirements and checkpoint are signed and pinned to the matched booking", async () => {
  const f = await fixture();
  try {
    const model = f.catalog.models[0], offer = model.offers[0];
    f.store.setSettings(f.account.walletId, model.id, { ...f.client.settings(model.id), advancedRouting: true, modelCheckpoint: offer.checkpoint, inputModalities: 1, outputModalities: 1, minContextTokens: 16384, maxInputTokens: 4096, maxOutputTokens: 1024 });
    const body = JSON.stringify({ model: model.id, messages: [{ role: "user", content: "Hello" }], max_tokens: 128 });
    const routed = await f.client.request("advanced", model.id, body, "session", "primary", new AbortController().signal);
    const row = f.store.pending(f.account.wallet)[0];
    const transaction = Transaction.from(Buffer.from(row.transaction, "base64"));
    const data = Buffer.from(transaction.instructions.find(ix => ix.programId.toString() === f.cfg.programId && Buffer.from(ix.data).subarray(0, 8).equals(discriminator("global:reserve_booking")))!.data);
    expect(data.length).toBe(163);
    expect(data.subarray(115, 147).toString("hex")).toBe(offer.checkpoint);
    expect(data.readUInt32LE(54)).toBe(4096);
    expect([...data.subarray(147, 149)]).toEqual([1, 1]);
    expect(data.readUInt32LE(149)).toBe(16384);
    expect(data[153]).toBe(1); expect(data[154]).toBe(1);
    expect(f.bookData.subarray(472, 504).toString("hex")).toBe(offer.checkpoint);
    expect(row.checkpoint).toBe(offer.checkpoint);
    const response = await fetch(routed.url, { method: "POST", headers: routed.headers, body });
    expect(response.ok).toBe(true);
    await f.client.response(new Request(routed.url, { headers: routed.headers }), response).text();
  } finally { await f.close(); }
});


providerTest("list routing signs wallet ledger setup and enforces desired concurrency in native payload", async () => {
  const f = await fixture(2, 0, true);
  try {
    const model = f.catalog.models[0];
    f.store.setSettings(f.account.walletId, model.id, { mode: "cheapest", minSpeed: 0, zdrOnly: false, advancedRouting: true, desiredConcurrency: 1000 });
    const body = JSON.stringify({ model: model.id, messages: [{ role: "user", content: "Hello" }], max_tokens: 128 });
    const routed = await f.client.request("scoped", model.id, body, "session", "primary", new AbortController().signal);
    expect(routed.url).toBe(model.offers[0].provider.endpoint!);
    expect(f.bookData[356]).toBe(2);
    const row = f.store.request("scoped", f.account.wallet)!;
    expect(row.rentLamports).toBe("1000"); expect(row.stage).toBe("inference");
    expect(f.submissions()).toBe(1);
    await f.addBooking();
    await f.client.request("scoped-warm", model.id, body, "another-session", "primary", new AbortController().signal);
    expect(f.store.request("scoped-warm", f.account.wallet)?.rentLamports).toBe("0");
    expect(f.submissions()).toBe(2);
  } finally { await f.close(); }
});
