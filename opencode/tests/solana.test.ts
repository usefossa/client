import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { FossaClient } from "../src/inference/client";
import { Store } from "../src/account/store";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "../src/account/token";
import type { Account, PublicConfig, WalletState } from "../src/types";

for (const setup of [false, true]) test(`journal preserves v1 signed transaction bytes with ${setup ? "two signers" : "one signer"}`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "fossa-wire-")), store = new Store(directory);
  try {
    const owner = await Keypair.fromSeed(new Uint8Array(32).fill(1)), lane = await Keypair.fromSeed(new Uint8Array(32).fill(2)), program = new PublicKey(new Uint8Array(32).fill(3));
    const account = { walletId: "fixture", wallet: owner.publicKey.toString(), lane: lane.publicKey.toString() } as Account;
    const client = new FossaClient(store, account, () => {});
    client.cfg = { opencode: {} } as PublicConfig;
    client.wallet = { lamports: "1000000", usdcAtomic: "0", freeAtomic: "0", generation: "0", bookings: [] } as unknown as WalletState;
    client["transactionFees"] = { baselineMicroLamports: 1000, baselineFloorLamports: 1000, baselineCapLamports: 5000 };
    client.chain = { blockhash: new PublicKey(new Uint8Array(32).fill(4)).toString(), lastValidBlockHeight: 100, signatureFee: "5000" } as typeof client.chain;
    client["chainUntil"] = Date.now() + 60_000;
    client["rpc"] = { simulateTransaction: async () => ({ context: { slot: 0n }, value: { err: null, unitsConsumed: 35_454n } }), sendRawTransaction: async () => "fixture" } as unknown as typeof client["rpc"];
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 }));
    if (setup) tx.add(SystemProgram.createAccount({ fromPubkey: owner.publicKey, newAccountPubkey: lane.publicKey, lamports: 1000n, space: 120, programId: program }));
    tx.add(new TransactionInstruction({ programId: program, keys: [{ pubkey: lane.publicKey, isSigner: setup, isWritable: true }, { pubkey: owner.publicKey, isSigner: true, isWritable: false }], data: Buffer.alloc(116, 6) }));
    const row = await client["journal"](tx, setup ? [owner, lane] : [owner], { id: "fixture", wallet: account.wallet, model: "", bodyHash: "", session: "", kind: "setup", booking: "", generation: "0", reserve: "0" });
    const bytes = Buffer.from(row.transaction, "base64");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(setup ? "72799a71c260a495bcabd802bb8c73e9fcb09694a75aebcfdc91ee81667490bb" : "bc0b66c99badd85ec1bc9c0a44bce03cd47aa8cd0bad8add5198a33f7e44319d");
    expect(await Transaction.from(bytes).verifySignatures()).toBe(true);
    expect(row.feeLamports).toBe(setup ? "11000" : "6000");
    const price = Transaction.from(bytes).instructions.filter(ix => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 3);
    expect(price).toHaveLength(1);
    expect(Buffer.from(price[0].data).readBigUInt64LE(1)).toBe(25_000n);
    expect(store.request(row.id, account.wallet)?.transaction).toBe(row.transaction);
    await client.drain();
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("native paged journal reserves exact priority fee before signing without simulation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fossa-priority-")), store = new Store(directory);
  try {
    const owner = await Keypair.generate(), program = (await Keypair.generate()).publicKey;
    const account = { walletId: "fixture", wallet: owner.publicKey.toString(), lane: program.toString() } as Account;
    const client = new FossaClient(store, account, () => {});
    client.cfg = { opencode: {} } as PublicConfig;
    client.wallet = { lamports: "5000", usdcAtomic: "0", freeAtomic: "0", generation: "0", bookings: [] } as unknown as WalletState;
    client.chain = { blockhash: owner.publicKey.toString(), lastValidBlockHeight: 100, signatureFee: "5000" } as typeof client.chain;
    client["chainUntil"] = Date.now() + 60_000;
    client["transactionFees"] = { baselineMicroLamports: 1000, baselineFloorLamports: 1000, baselineCapLamports: 5000 };
    let simulations = 0;
    client["rpc"] = { simulateTransaction: async () => { simulations++; throw Error("native reserve must not simulate"); }, sendRawTransaction: async () => "fixture" } as unknown as typeof client["rpc"];
    const payload = Buffer.alloc(164); payload.set(createHash("sha256").update("global:reserve_list_booking").digest().subarray(0, 8));
    const tx = new Transaction().add(new TransactionInstruction({ programId: program, keys: [{ pubkey: owner.publicKey, isSigner: true, isWritable: true }], data: payload }));
    const fields = { id: "native", wallet: account.wallet, model: "fixture/model", bodyHash: "", session: "", kind: "inference", booking: program.toString(), generation: "1", reserve: "0" };
    const compute = { offers: 32, pages: 4, walletEntries: 8, walletBump: 255, initializeWallet: false, growWallet: false, deposit: false };
    let failure: unknown;
    try { await client["journal"](tx, [owner], fields, 0, undefined, compute); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "SOL_REQUIRED" });
    expect(tx.signatures.every(signature => signature.signature === null)).toBe(true);
    expect(store.pending()).toHaveLength(0);
    client.wallet.lamports = "1000000";
    const row = await client["journal"](tx, [owner], fields, 0, undefined, compute);
    const signed = Transaction.from(Buffer.from(row.transaction, "base64"));
    const price = signed.instructions.find(ix => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 3)!;
    const limit = signed.instructions.find(ix => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 2)!;
    const priority = (Buffer.from(price.data).readBigUInt64LE(1) * BigInt(Buffer.from(limit.data).readUInt32LE(1)) + 999999n) / 1000000n;
    expect(row.feeLamports).toBe(String(5000n + priority));
    expect(client["availableWallet"]().lamports).toBe(String(1000000n - BigInt(row.feeLamports!)));
    expect(await signed.verifySignatures()).toBe(true);
    expect(simulations).toBe(0);
    await client.drain();
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("missing streamed fees refresh one wallet snapshot and accept native updates without Jito tips", async () => {
  const account = { wallet: "fixture-wallet", lane: "fixture-lane", apiUrl: "https://fixture.invalid", access: "synthetic" } as Account;
  const client = new FossaClient({} as Store, account, () => {}), now = Math.floor(Date.now() / 1000);
  const fees = { available: true, updatedAt: now, expiresAt: now + 90, baselineMicroLamports: 1000, baselineFloorLamports: 1000, baselineCapLamports: 5000 };
  const preconnect = globalThis.fetch.preconnect;
  const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_input: Parameters<typeof globalThis.fetch>[0], options?: Parameters<typeof globalThis.fetch>[1]) => {
    expect(new Headers(options?.headers).get("authorization")).toBe("Bearer synthetic");
    return Response.json({ wallet: account.wallet, lane: account.lane, transactionFees: fees });
  }, { preconnect }));
  try {
    expect((await client["priority"](100000)).lamports).toBe(1000n);
    client["acceptFees"]({ baselineMicroLamports: 0, baselineFloorLamports: 1000, baselineCapLamports: 5000 });
    expect((await client["priority"](100000)).lamports).toBe(1000n);
    expect(fetch).toHaveBeenCalledTimes(1);
    client["transactionFees"] = undefined;
    fetch.mockImplementation(Object.assign(async () => {
      client["acceptFees"]({ ...fees, baselineFloorLamports: 2000 });
      return Response.json({ wallet: account.wallet, lane: account.lane, transactionFees: fees });
    }, { preconnect }));
    expect((await client["priority"](100000)).lamports).toBe(2000n);
    client["transactionFees"] = undefined;
    fetch.mockResolvedValue(Response.json({ wallet: "another-wallet", lane: account.lane, transactionFees: fees }));
    await expect(client["priority"](100000)).rejects.toThrow("another wallet");
  } finally { fetch.mockRestore(); }
});

test("stopping during compute measurement never signs or journals a new transaction", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fossa-stop-")), store = new Store(directory);
  try {
    const owner = await Keypair.generate(), account = { walletId: "fixture", wallet: owner.publicKey.toString() } as Account;
    const client = new FossaClient(store, account, () => {});
    client.cfg = { opencode: {} } as PublicConfig;
    client.wallet = { lamports: "1000000", usdcAtomic: "0", freeAtomic: "0", generation: "0", bookings: [] } as unknown as WalletState;
    client.chain = { blockhash: owner.publicKey.toString(), lastValidBlockHeight: 100, signatureFee: "5000" } as typeof client.chain;
    client["chainUntil"] = Date.now() + 60_000;
    client["rpc"] = { simulateTransaction: async () => { client.stop(); return { context: { slot: 0n }, value: { err: null, unitsConsumed: 1000n } }; } } as unknown as typeof client["rpc"];
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: (await Keypair.generate()).publicKey, lamports: 1n }));
    await expect(client["journal"](tx, [owner], { id: "fixture", wallet: account.wallet, model: "", bodyHash: "", session: "", kind: "setup", booking: "", generation: "0", reserve: "0" })).rejects.toThrow("connection closed");
    expect(tx.signatures.every(signature => signature.signature === null)).toBe(true);
    expect(store.pending()).toHaveLength(0);
    owner.secretKey.fill(0);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("RPC snapshot decodes account bytes and preserves amounts above Number precision", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fossa-snapshot-")), store = new Store(directory);
  try {
    const owner = await Keypair.fromSeed(new Uint8Array(32).fill(1)), lane = await Keypair.fromSeed(new Uint8Array(32).fill(2)), program = new PublicKey(new Uint8Array(32).fill(3)), market = new PublicKey(new Uint8Array(32).fill(4)), mint = new PublicKey(new Uint8Array(32).fill(5));
    const source = await getAssociatedTokenAddress(mint, owner.publicKey), [authority] = await PublicKey.findProgramAddress([Buffer.from("vault"), lane.publicKey.toBytes()], program), vault = await getAssociatedTokenAddress(mint, authority, true);
    const user = Buffer.alloc(128), token = Buffer.alloc(165), amount = 9007199254740995n;
    user.set(createHash("sha256").update("account:User").digest().subarray(0, 8)); user.set(owner.publicKey.toBytes(), 8); user.set(market.toBytes(), 40); user.set(vault.toBytes(), 80); user.writeBigUInt64LE(amount, 72); user.writeBigUInt64LE(0xffffffffffffffffn, 112);
    token.set(mint.toBytes()); token.set(owner.publicKey.toBytes(), 32); token.writeBigUInt64LE(amount, 64);
    const account = { walletId: "fixture", wallet: owner.publicKey.toString(), lane: lane.publicKey.toString(), rpcUrl: "http://127.0.0.1:1" } as Account;
    const client = new FossaClient(store, account, () => {});
    client.cfg = { programId: program.toString(), market: market.toString(), usdcMint: mint.toString() } as PublicConfig;
    client["rpc"] = new Connection(account.rpcUrl!, { fetch: Object.assign(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = JSON.parse(String(init?.body));
      expect(request.method).toBe("getMultipleAccounts"); expect(request.params[0]).toEqual([account.wallet, source.toString(), account.lane]);
      const info = (data: Buffer, owner: PublicKey) => ({ owner: owner.toString(), data: [data.toString("base64"), "base64"], executable: false, lamports: 1, rentEpoch: 0, space: data.length });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { context: { slot: 123 }, value: [info(Buffer.alloc(0), SystemProgram.programId), info(token, TOKEN_PROGRAM_ID), info(user, program)] } }).replace('"lamports":1', '"lamports":9007199254740995'));
    }, { preconnect: fetch.preconnect }) });
    const snapshot = await client.snapshot();
    expect(snapshot.ready).toBe(true); expect(snapshot.slot).toBe(123); expect(snapshot.generation).toBe("18446744073709551615");
    expect(snapshot.lamports).toBe(amount.toString()); expect(snapshot.usdcAtomic).toBe(amount.toString()); expect(snapshot.freeAtomic).toBe(amount.toString());
    await client.drain();
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("booking recovery accepts shared-provider and historical markers and rejects unsupported formats", () => {
  const program = new PublicKey(new Uint8Array(32).fill(1)), market = new PublicKey(new Uint8Array(32).fill(2)), owner = new PublicKey(new Uint8Array(32).fill(3)), lane = new PublicKey(new Uint8Array(32).fill(4));
  const client = new FossaClient({} as Store, { wallet: owner.toString(), lane: lane.toString() } as Account, () => {});
  client.cfg = { programId: program.toString(), market: market.toString() } as PublicConfig;
  const data = Buffer.alloc(520); data.set(createHash("sha256").update("account:FilteredBooking").digest().subarray(0, 8)); data.set(owner.toBytes(), 8); data.set(market.toBytes(), 72); data.set(lane.toBytes(), 192);
  const info = { owner: program, data, lamports: 1000n, executable: false, rentEpoch: 0n };
  for (const marker of [0, 2, 3]) { data[356] = marker; expect(client["bookingData"](info)).toEqual(data); }
  for (const marker of [1, 4, 255]) { data[356] = marker; expect(() => client["bookingData"](info)).toThrow("Unsupported booking quota marker."); }
});
