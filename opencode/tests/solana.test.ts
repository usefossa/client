import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { FossaClient } from "../src/client";
import { Store } from "../src/store";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "../src/token";
import type { Account, PublicConfig, WalletState } from "../src/types";

for (const setup of [false, true]) test(`journal preserves v1 signed transaction bytes with ${setup ? "two signers" : "one signer"}`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "fossa-wire-")), store = new Store(directory);
  try {
    const owner = await Keypair.fromSeed(new Uint8Array(32).fill(1)), lane = await Keypair.fromSeed(new Uint8Array(32).fill(2)), program = new PublicKey(new Uint8Array(32).fill(3));
    const account = { walletId: "fixture", wallet: owner.publicKey.toString(), lane: lane.publicKey.toString() } as Account;
    const client = new FossaClient(store, account, () => {});
    client.cfg = { opencode: {} } as PublicConfig;
    client.wallet = { lamports: "1000000", usdcAtomic: "0", freeAtomic: "0", generation: "0", bookings: [] } as unknown as WalletState;
    client.chain = { blockhash: new PublicKey(new Uint8Array(32).fill(4)).toString(), lastValidBlockHeight: 100, signatureFee: "5000" } as typeof client.chain;
    client["chainUntil"] = Date.now() + 60_000;
    client["rpc"] = { sendRawTransaction: async () => "fixture" } as unknown as typeof client["rpc"];
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 }));
    if (setup) tx.add(SystemProgram.createAccount({ fromPubkey: owner.publicKey, newAccountPubkey: lane.publicKey, lamports: 1000n, space: 120, programId: program }));
    tx.add(new TransactionInstruction({ programId: program, keys: [{ pubkey: lane.publicKey, isSigner: setup, isWritable: true }, { pubkey: owner.publicKey, isSigner: true, isWritable: false }], data: Buffer.alloc(116, 6) }));
    const row = await client["journal"](tx, setup ? [owner, lane] : [owner], { id: "fixture", wallet: account.wallet, model: "", bodyHash: "", session: "", kind: "setup", booking: "", generation: "0", reserve: "0" });
    const bytes = Buffer.from(row.transaction, "base64");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(setup ? "105747493da9210c7e8e864f3f3c53011fb3357120be4d55786c40b3423a5d07" : "9a9ce41089c237c7ed1283ee326cbcecd68f379bc61a097bdc42277e6e65a692");
    expect(await Transaction.from(bytes).verifySignatures()).toBe(true);
    expect(row.feeLamports).toBe(setup ? "10000" : "5000");
    expect(store.request(row.id, account.wallet)?.transaction).toBe(row.transaction);
    await client.drain();
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("RPC snapshot decodes account bytes and preserves amounts above Number precision", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fossa-snapshot-")), store = new Store(directory);
  try {
    const owner = await Keypair.fromSeed(new Uint8Array(32).fill(1)), lane = await Keypair.fromSeed(new Uint8Array(32).fill(2)), program = new PublicKey(new Uint8Array(32).fill(3)), market = new PublicKey(new Uint8Array(32).fill(4)), mint = new PublicKey(new Uint8Array(32).fill(5));
    const source = await getAssociatedTokenAddress(mint, owner.publicKey), [authority] = await PublicKey.findProgramAddress([Buffer.from("vault"), lane.publicKey.toBytes()], program), vault = await getAssociatedTokenAddress(mint, authority, true);
    const user = Buffer.alloc(120), token = Buffer.alloc(165), amount = 9007199254740995n;
    user.write("USER0V20"); user.set(owner.publicKey.toBytes(), 8); user.set(market.toBytes(), 40); user.set(vault.toBytes(), 80); user.writeBigUInt64LE(amount, 72); user[113] = 7;
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
    expect(snapshot.ready).toBe(true); expect(snapshot.slot).toBe(123); expect(snapshot.generation).toBe("7");
    expect(snapshot.lamports).toBe(amount.toString()); expect(snapshot.usdcAtomic).toBe(amount.toString()); expect(snapshot.freeAtomic).toBe(amount.toString());
    await client.drain();
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
