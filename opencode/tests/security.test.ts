import { expect, spyOn, test } from "bun:test";
import { lookup } from "node:dns";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { gzipSync } from "node:zlib";
import { Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction } from "@solana/web3.js";
import { readJson, refreshAccount } from "../src/api";
import { inputBound, validateBody } from "../src/protocol";
import { providerDispatcher, providerFetch, providerLookup, publicProviderAddress } from "../src/inference/provider-fetch";
import { MockAgent } from "undici-client";
import { FossaClient } from "../src/inference/client";
import { getAssociatedTokenAddress } from "../src/account/token";
import { Store, type Pending } from "../src/account/store";
import type { Account, PublicConfig, WalletState } from "../src/types";

test("refresh credentials cannot replace endpoint, RPC, wallet, or encryption bindings", async () => {
  const account = { apiUrl: "https://api.example.invalid", wallet: "owner", lane: "lane", walletId: "encrypted", name: "Saved", access: "old", refresh: "old-refresh", expires: 1 } as Account;
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ...account, access: "new", refresh: "new-refresh", expires: 2, wallet: "attacker", lane: "attacker-lane", walletId: "other", apiUrl: "https://attacker.invalid", rpcUrl: "https://attacker.invalid/rpc" }));
  try {
    expect(await refreshAccount(account)).toEqual({ ...account, access: "new", refresh: "new-refresh", expires: 2 });
    fetch.mockResolvedValue(Response.json({ access: "new", refresh: "", expires: 2 }));
    await expect(refreshAccount(account)).rejects.toThrow("invalid refreshed credentials");
  } finally { fetch.mockRestore(); }
});

test("API JSON is bounded by streamed bytes even without trustworthy content length", async () => {
  expect(await readJson(Response.json({ ok: true }), 16)).toEqual({ ok: true });
  for (const headers of [{}, { "content-length": "1" }, { "content-length": "999" }] as Record<string, string>[]) {
    let cancelled = false;
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(17))); }, cancel() { cancelled = true; } }), { headers });
    await expect(readJson(response, 16)).rejects.toThrow("byte limit"); expect(cancelled).toBe(true);
  }
});

test("response schemas consume booked input and context with exact UTF-8 accounting", () => {
  const body = { model: "fixture", messages: [{ role: "user", content: "hello" }], max_tokens: 8, response_format: { type: "json_schema", json_schema: { name: "fixture", schema: { type: "string", description: "é".repeat(1000) } } } };
  const base = inputBound({ messages: body.messages });
  expect(inputBound(body)).toBe(base + Buffer.byteLength(JSON.stringify(body.response_format)) + 32);
  expect(inputBound({ ...body, response_format: null })).toBe(base);
  const booking = { maxInput: base, maxOutput: 8, claimEnd: Date.now() / 1000 + 60 }, model = { model: body.model, speed_tps: 100, context_tokens: 65536, output_tokens: 8, tools: true };
  expect(() => validateBody(body, booking, model)).toThrow("Input limit");
  expect(validateBody(body, { ...booking, maxInput: inputBound(body) }, model)).toBe(8);
  expect(() => validateBody(body, { ...booking, maxInput: inputBound(body) }, { ...model, context_tokens: inputBound(body) + 7 })).toThrow("Context limit");
});

test("provider DNS pins only public addresses and rejects mixed/private answers", async () => {
  for (const address of ["127.0.0.1", "0.0.0.0", "10.1.2.3", "100.64.1.1", "169.254.169.254", "172.16.0.1", "192.168.0.1", "224.1.2.3", "::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "fd00::1", "fe80::1", "2002:7f00:1::", "2001:db8::1"]) expect(publicProviderAddress(address)).toBe(false);
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(publicProviderAddress(address)).toBe(true);
  for (const addresses of [[{ address: "127.0.0.1", family: 4 }], [{ address: "8.8.8.8", family: 4 }, { address: "::1", family: 6 }], []]) {
    const resolve = ((_host: unknown, _options: unknown, done: Function) => done(null, addresses)) as typeof lookup;
    const pinned = providerLookup(resolve);
    await expect(new Promise((resolve, reject) => pinned("provider.invalid", { all: true }, (error, result) => error ? reject(error) : resolve(result)))).rejects.toThrow("public HTTPS");
  }
  const addresses = [{ address: "8.8.8.8", family: 4 }];
  const pinned = providerLookup(((_host: unknown, _options: unknown, done: Function) => done(null, addresses)) as typeof lookup);
  expect(await new Promise<unknown>((resolve, reject) => pinned("provider.invalid", { all: true }, (error, result) => error ? reject(error) : resolve(result)))).toEqual(addresses);
  for (const url of ["http://127.0.0.1/private", "https://127.0.0.1/private", "https://[::ffff:127.0.0.1]/private"]) await expect(providerFetch(new Request(url), "https://api.example.invalid")).rejects.toThrow();
});

test("native provider HTTP transport uses guarded DNS and preserves body and status", async () => {
  let resolutions = 0;
  const dispatcher = providerDispatcher(((host: string, _options: unknown, done: Function) => { expect(host).toBe("provider.example.invalid"); resolutions++; done(null, [{ address: "127.0.0.1", family: 4 }]); }) as typeof lookup);
  try {
    await expect(providerFetch(new Request("https://provider.example.invalid/v1/chat/completions", { method: "POST", body: "{}" }), "https://api.example.invalid", dispatcher)).rejects.toThrow();
    expect(resolutions).toBe(1);
  } finally { await dispatcher.destroy(); }
  const mock = new MockAgent(); mock.disableNetConnect();
  try {
    for (const status of [200, 429]) {
      const body = status === 200 ? "data: [DONE]\n\n" : '{"error":"limited"}';
      mock.get("https://provider.example.invalid").intercept({ path: "/v1/chat/completions", method: "POST", body: '{"model":"fixture"}' }).reply(status, body, { headers: { "content-type": status === 200 ? "text/event-stream" : "application/json", "retry-after": "5" } });
      const response = await providerFetch(new Request("https://provider.example.invalid/v1/chat/completions", { method: "POST", body: '{"model":"fixture"}' }), "https://api.example.invalid", mock);
      expect(response.status).toBe(status); expect(await response.text()).toBe(body); expect(response.headers.get("retry-after")).toBe("5");
    }
    mock.get("https://provider.example.invalid").intercept({ path: "/gzip", method: "POST" }).reply(200, gzipSync("data: [DONE]\n\n"), { headers: { "content-type": "text/event-stream", "content-encoding": "gzip", "content-length": "999" } });
    const compressed = await providerFetch(new Request("https://provider.example.invalid/gzip", { method: "POST", body: "{}" }), "https://api.example.invalid", mock);
    expect(await compressed.text()).toBe("data: [DONE]\n\n"); expect(compressed.headers.has("content-encoding")).toBe(false); expect(compressed.headers.has("content-length")).toBe(false);
    mock.get("https://provider.example.invalid").intercept({ path: "/redirect", method: "POST" }).reply(302, "redirect", { headers: { location: "http://127.0.0.1/private" } });
    const redirected = await providerFetch(new Request("https://provider.example.invalid/redirect", { method: "POST", body: "{}" }), "https://api.example.invalid", mock);
    expect(redirected.status).toBe(302); expect(await redirected.text()).toBe("redirect");
    mock.assertNoPendingInterceptors();
  } finally { await mock.close(); }
});

test("provider stream cancellation destroys upstream while preserving received bytes", async () => {
  const upstream = new PassThrough();
  const transport = { request: async () => ({ statusCode: 200, headers: { "content-type": "text/event-stream" }, body: upstream }) } as unknown as Parameters<typeof providerFetch>[2];
  const response = await providerFetch(new Request("https://provider.example.invalid/stream", { method: "POST", body: "{}" }), "https://api.example.invalid", transport);
  const reader = response.body!.getReader(); upstream.write("data: first\n\n");
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
  await reader.cancel(); expect(upstream.destroyed).toBe(true);
});

test("wallet snapshots bind locally derived token accounts and exact unsigned amounts", async () => {
  const owner = await Keypair.generate(), lane = await Keypair.generate(), program = (await Keypair.generate()).publicKey, mint = (await Keypair.generate()).publicKey;
  const client = new FossaClient({} as Store, { wallet: owner.publicKey.toString(), lane: lane.publicKey.toString() } as Account, () => {});
  client.cfg = { programId: program.toString(), usdcMint: mint.toString() } as PublicConfig;
  const [authority] = await PublicKey.findProgramAddress([Buffer.from("vault"), lane.publicKey.toBytes()], program);
  const snapshot = { wallet: owner.publicKey.toString(), lane: lane.publicKey.toString(), source: (await getAssociatedTokenAddress(mint, owner.publicKey)).toString(), vault: (await getAssociatedTokenAddress(mint, authority, true)).toString(), ready: true, lamports: "9007199254740995", usdcAtomic: "18446744073709551615", freeAtomic: "0", generation: "1", slot: 1, bookings: [] } as WalletState;
  expect(await client["validateSnapshot"](snapshot)).toEqual(snapshot);
  for (const patch of [{ wallet: "other" }, { lane: "other" }, { source: program.toString() }, { vault: program.toString() }, { usdcAtomic: 9007199254740995 }, { freeAtomic: "-1" }, { generation: "18446744073709551616" }, { slot: -1 }]) await expect(client["validateSnapshot"]({ ...snapshot, ...patch } as WalletState)).rejects.toThrow();
  owner.secretKey.fill(0); lane.secretKey.fill(0);
});

test("signed journal cannot change bytes, signature, expiry, body, or model", () => {
  const directory = mkdtempSync(join(tmpdir(), "fossa-journal-security-")), store = new Store(directory);
  try {
    const row = { id: "fixture", wallet: "owner", booking: "booking", generation: "1", signature: "signature", transaction: "signed bytes", expiry: 100, bodyHash: "body", model: "model", stage: "uncertain", created: 1 } as Pending;
    store.put(row);
    for (const patch of [{ signature: "other" }, { transaction: "other" }, { expiry: 0 }, { bodyHash: "other" }, { model: "other" }]) expect(() => store.put({ ...row, ...patch })).toThrow("signed transaction changed");
    expect(store.request(row.id, row.wallet)).toEqual(row);
    expect(store.db.query("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("live blockhash and nonfinal failures never release an uncertain signed transaction", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fossa-finality-")), store = new Store(directory);
  const client = new FossaClient(store, { wallet: "owner" } as Account, () => {});
  client.cfg = { opencode: { requestTimeoutMs: 25, pollIntervalMs: 4 } } as PublicConfig;
  const hash = new PublicKey(new Uint8Array(32).fill(7)).toString();
  const transaction = Buffer.from(new VersionedTransaction(new Transaction({ feePayer: SystemProgram.programId, recentBlockhash: hash as never }).add(SystemProgram.transfer({ fromPubkey: SystemProgram.programId, toPubkey: SystemProgram.programId, lamports: 0n })).compileMessage()).serialize()).toString("base64");
  try {
    for (const mode of ["live", "too-new", "malformed", "confirmed-error", "finalized-error"]) {
      const row = { id: mode, wallet: "owner", booking: "booking", generation: "1", signature: "signature", transaction, expiry: 1, stage: "sent", created: 1 } as Pending;
      client["rpc"] = { getSignatureStatuses: async () => ({ context: { slot: 20 }, value: [mode.endsWith("error") ? { err: { InstructionError: [1, { Custom: 2 }] }, slot: 10, confirmationStatus: mode === "finalized-error" ? "finalized" : "confirmed" } : null] }), getBlockHeight: async () => 1000, isBlockhashValid: async (blockhash: string, options: { commitment: string }) => { expect(blockhash).toBe(hash); return { context: { slot: 20 }, value: mode === "malformed" ? null : mode === "live" || options.commitment === "confirmed" }; } } as never;
      store.put(row);
      await expect(client["processed"](row, undefined, undefined, true)).rejects.toThrow(mode === "finalized-error" ? "transaction failed" : "unresolved");
      expect(store.request(row.id, row.wallet)?.stage).toBe(mode === "finalized-error" ? "failed" : "uncertain");
    }
  } finally { client.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
