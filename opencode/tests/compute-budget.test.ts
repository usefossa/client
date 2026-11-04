import { expect, test } from "bun:test";
import { ComputeBudgetProgram, Keypair, Transaction, TransactionInstruction, Connection, type VersionedTransaction } from "@solana/web3.js";
import { bookingCompute, measureCompute, simulationMiddleware, sizeCompute, transactionPriority } from "../src/inference/compute-budget";
import type { TransactionFees } from "../src/types";

async function transaction(count = 1) {
  const payer = (await Keypair.generate()).publicKey, program = (await Keypair.generate()).publicKey;
  const tx = new Transaction();
  tx.feePayer = payer; tx.recentBlockhash = payer.toBase58() as unknown as Transaction["recentBlockhash"];
  for (let index = 0; index < count; index++) tx.add(new TransactionInstruction({ programId: program, keys: [{ pubkey: payer, isSigner: true, isWritable: true }], data: Buffer.from([index]) }));
  return tx;
}
const rpc = (value: { unitsConsumed?: bigint; err?: object }, slot = 10n) => ({ simulateTransaction: async () => ({ context: { slot }, value: { err: null, logs: [], ...value } }) }) as unknown as Pick<Connection, "simulateTransaction">;

test("real sdk transport sends explicit unsigned simulation policy", async () => {
  let calls = 0;
  const connection = new Connection("http://127.0.0.1:1", { fetchMiddleware: simulationMiddleware, httpHeaders: { authorization: "Bearer fixture" }, fetch: Object.assign(async (_url: unknown, options?: RequestInit) => {
    const body = JSON.parse(String(options?.body)), [bytes, config] = body.params;
    calls++;
    expect(body.method).toBe("simulateTransaction");
    expect(new Headers(options?.headers).get("authorization")).toBe("Bearer fixture");
    expect(config).toEqual({ sigVerify: false, encoding: "base64", commitment: "processed", minContextSlot: 10 });
    expect(Transaction.from(Buffer.from(bytes, "base64")).signatures.every(item => item.signature === null)).toBe(true);
    if (config.sigVerify !== false) return new Response("Invalid transaction signatures", { status: 400 });
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { context: { slot: 10 }, value: { err: null, logs: [], unitsConsumed: 10000 } } });
  }, { preconnect: fetch.preconnect }) });
  expect(await measureCompute(await transaction(), connection, 10)).toBe(12000);
  expect(calls).toBe(1);
});

test("simulation transport preserves explicit signature verification and other rpc requests", () => {
  for (const body of [{ method: "simulateTransaction", params: ["bytes", { sigVerify: true }] }, { method: "sendTransaction", params: ["bytes", { encoding: "base64" }] }]) {
    const options = { body: JSON.stringify(body) };
    simulationMiddleware("http://localhost", options, (_url, forwarded) => expect(JSON.parse(forwarded.body)).toEqual(body));
  }
});

test("measures every instruction unsigned using existing blockhash and context", async () => {
  const tx = await transaction(3), hash = tx.recentBlockhash;
  let calls = 0;
  const connection = { simulateTransaction: async (probe: VersionedTransaction, options: object) => {
    calls++;
    expect(probe.signatures.every(signature => signature.every(byte => byte === 0))).toBe(true);
    expect(probe.message.compiledInstructions).toHaveLength(4);
    expect(probe.message.recentBlockhash).toBe(hash!);
    expect(options).toEqual({ sigVerify: false, commitment: "processed", minContextSlot: 10n });
    return { context: { slot: 10n }, value: { err: null, unitsConsumed: 10_001n, logs: [] } };
  } } as unknown as Pick<Connection, "simulateTransaction">;
  expect(await measureCompute(tx, connection, 10)).toBe(12_002);
  expect(calls).toBe(1);
  expect(Buffer.from(tx.instructions[0].data).readUInt32LE(1)).toBe(12_002);
  expect(tx.signatures.every(signature => signature.signature === null)).toBe(true);
});

test("replaces old limit, preserves compute price and sizes changed topology", async () => {
  const tx = await transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100n }));
  await measureCompute(tx, rpc({ unitsConsumed: 2000n }), 10);
  expect(tx.instructions.filter(ix => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 2)).toHaveLength(1);
  expect(tx.instructions.some(ix => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 3)).toBe(true);
  expect(await measureCompute(await transaction(2), rpc({ unitsConsumed: 5000n }), 10)).toBe(6500);
  expect(await measureCompute(await transaction(), rpc({ unitsConsumed: 1_400_000n }), 10)).toBe(1_400_000);
});

test("rejects missing, invalid, failed or stale simulation evidence before signing", async () => {
  for (const value of [{}, { unitsConsumed: 1000n, err: undefined }, { unitsConsumed: 0n }, { unitsConsumed: 1_400_001n }, { unitsConsumed: 1000n, err: { InstructionError: [0, "failure"] } }]) {
    const tx = await transaction();
    await expect(measureCompute(tx, rpc(value), 10)).rejects.toThrow();
    expect(tx.signatures.every(signature => signature.signature === null)).toBe(true);
  }
  await expect(measureCompute(await transaction(), rpc({ unitsConsumed: 1000n }, 9n), 10)).rejects.toThrow("stale");
});

test("native paged booking sizing covers measured routes without RPC simulation", async () => {
  const state = { offers: 2, pages: 1, walletEntries: 0, walletBump: 255, initializeWallet: false, growWallet: false, deposit: false };
  const deadRpc = { simulateTransaction: async () => { throw Error("hot path must not simulate"); } } as unknown as Pick<Connection, "simulateTransaction">;
  for (const [offers, pages, walletEntries, measured] of [[2, 1, 0, 3338], [32, 32, 32, 15494], [100, 1, 100, 9202], [4096, 32, 4096, 853694], [4096, 1, 4096, 674816], [2, 1, 100000, 4565]]) {
    const input = { ...state, offers, pages, walletEntries }, consumed = bookingCompute(input), tx = await transaction();
    expect(consumed).toBeGreaterThanOrEqual(measured);
    const units = await sizeCompute(tx, deadRpc, 100, [], input);
    expect(units).toBe(consumed + Math.ceil(consumed / 10) + 1000);
    expect(Buffer.from(tx.instructions[0].data).readUInt32LE(1)).toBe(units);
    expect(tx.signatures.every(signature => signature.signature === null)).toBe(true);
  }
  expect(bookingCompute({ ...state, initializeWallet: true, walletBump: 240 })).toBeGreaterThan(bookingCompute({ ...state, initializeWallet: true }));
  expect(bookingCompute({ ...state, deposit: true })).toBeGreaterThan(bookingCompute(state));
  expect(() => bookingCompute({ ...state, offers: 4097 })).toThrow();
  expect(() => bookingCompute({ ...state, growWallet: true, walletEntries: 100000 })).toThrow("separate wallet maintenance");
});

test("streamed native priority floors and caps use exact bigint rounding independently of Jito tips", () => {
  const now = Math.floor(Date.now() / 1000), fees: TransactionFees = { baselineMicroLamports: 1000, baselineFloorLamports: 1000, baselineCapLamports: 100000 };
  for (const units of [1, 12001, 100000, 1400000]) {
    const priority = transactionPriority(units, fees);
    expect(priority.microLamports).toBeGreaterThan(0n);
    expect(priority.lamports).toBe((priority.microLamports * BigInt(units) + 999999n) / 1000000n);
    expect(priority.lamports).toBeGreaterThanOrEqual(1000n);
    expect(priority.lamports).toBeLessThanOrEqual(100001n);
  }
  expect(transactionPriority(100000, { ...fees, baselineMicroLamports: Number.MAX_SAFE_INTEGER }).lamports).toBe(100000n);
  for (const tips of [{ available: false }, { updatedAt: now - 91 }, { expiresAt: now - 1 }]) expect(transactionPriority(1000, { ...fees, ...tips }).microLamports).toBeGreaterThan(0n);
  for (const invalid of [{ ...fees, baselineFloorLamports: 0 }, { ...fees, baselineCapLamports: 100001 }, { ...fees, baselineMicroLamports: NaN }]) expect(() => transactionPriority(1000, invalid)).toThrow("synchronizing");
});
