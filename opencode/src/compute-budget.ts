import { compileBookingTransaction } from "./booking-transaction";
import { ComputeBudgetProgram, type Connection, type ConnectionConfig, type AddressLookupTableAccount, type Transaction } from "@solana/web3.js";
import { FossaError } from "./types";

// web3.js omits sigVerify:false; the authenticated rpc requires it explicitly.
export const simulationMiddleware: NonNullable<ConnectionConfig["fetchMiddleware"]> = (url, options, next) => {
  if (typeof options.body === "string" && options.body.includes('"simulateTransaction"')) {
    const body = JSON.parse(options.body);
    if (body.method === "simulateTransaction") {
      body.params[1] = { sigVerify: false, ...body.params[1] };
      options = { ...options, body: JSON.stringify(body) };
    }
  }
  next(url, options);
};

export async function measureCompute(tx: Transaction, rpc: Pick<Connection, "simulateTransaction">, slot: number, tables: AddressLookupTableAccount[] = []) {
  const instructions = tx.instructions.filter(ix => !ix.programId.equals(ComputeBudgetProgram.programId) || ix.data[0] !== 2);
  tx.instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...instructions];
  const simulated = await rpc.simulateTransaction(compileBookingTransaction(tx, tables), { sigVerify: false, commitment: "processed", minContextSlot: BigInt(slot) });
  if (Number(simulated.context.slot) < slot) throw new FossaError("SIMULATION_FAILED", "Transaction simulation returned stale state.");
  if (simulated.value.err !== null) throw new FossaError("SIMULATION_FAILED", "Transaction simulation failed. Refresh balances and try again.");
  const consumed = simulated.value.unitsConsumed;
  if (typeof consumed !== "bigint" || consumed <= 0n || consumed > 1_400_000n) throw new FossaError("SIMULATION_FAILED", "Transaction compute estimate is unavailable.");
  const units = Math.min(1_400_000, Number(consumed + (consumed + 9n) / 10n + 1000n));
  tx.instructions[0] = ComputeBudgetProgram.setComputeUnitLimit({ units });
  return units;
}
