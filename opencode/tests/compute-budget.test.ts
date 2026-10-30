import { expect, test } from "bun:test";
import { ComputeBudgetProgram, Keypair, Transaction, TransactionInstruction, type Connection, type VersionedTransaction } from "@solana/web3.js";
import { measureCompute } from "../src/compute-budget";

async function transaction(count = 1) {
  const payer = (await Keypair.generate()).publicKey, program = (await Keypair.generate()).publicKey;
  const tx = new Transaction();
  tx.feePayer = payer; tx.recentBlockhash = payer.toBase58() as unknown as Transaction["recentBlockhash"];
  for (let index = 0; index < count; index++) tx.add(new TransactionInstruction({ programId: program, keys: [{ pubkey: payer, isSigner: true, isWritable: true }], data: Buffer.from([index]) }));
  return tx;
}
const rpc = (value: { unitsConsumed?: bigint; err?: object }, slot = 10n) => ({ simulateTransaction: async () => ({ context: { slot }, value: { err: null, logs: [], ...value } }) }) as unknown as Pick<Connection, "simulateTransaction">;

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
