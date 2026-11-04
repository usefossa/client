import { compileBookingTransaction } from "./booking-transaction";
import { ComputeBudgetProgram, type Connection, type ConnectionConfig, type AddressLookupTableAccount, type Transaction } from "@solana/web3.js";
import { FossaError, type TransactionFees } from "../types";

export interface BookingComputeState { offers: number; pages: number; walletEntries: number; walletBump: number; initializeWallet: boolean; growWallet: boolean; deposit: boolean }

export function bookingCompute(state: BookingComputeState) {
  const { offers, pages, walletEntries, walletBump, initializeWallet, growWallet, deposit } = state;
  if (!Number.isSafeInteger(offers) || offers < 1 || offers > 4096 || !Number.isSafeInteger(pages) || pages < 1 || pages > 32
    || !Number.isSafeInteger(walletEntries) || walletEntries < 0 || walletEntries > 100_000
    || !Number.isInteger(walletBump) || walletBump < 0 || walletBump > 255 || initializeWallet && growWallet) throw new FossaError("COMPUTE_UNAVAILABLE", "Booking compute data is unavailable.");
  const consumed = 6_000 + 240 * offers + 350 * pages + Math.ceil(walletEntries / 4)
    + (initializeWallet ? 5_000 + 1_500 * (255 - walletBump) : 0) + (growWallet ? 18_000 + 160 * walletEntries : 0) + (deposit ? 10_000 : 0);
  if (consumed + Math.ceil(consumed / 10) + 1_000 > 1_400_000) throw new FossaError("COMPUTE_UNAVAILABLE", "Booking needs separate wallet maintenance.");
  return consumed;
}

export function transactionPriority(units: number, fees: TransactionFees) {
  if (!Number.isSafeInteger(units) || units < 1 || units > 1_400_000 || !fees
    || ![fees.baselineMicroLamports, fees.baselineFloorLamports, fees.baselineCapLamports].every(value => Number.isSafeInteger(value) && value >= 0)
    || fees.baselineFloorLamports < 1 || fees.baselineCapLamports < fees.baselineFloorLamports || fees.baselineCapLamports > 100_000) throw new FossaError("FEES_SYNCING", "Transaction fees are synchronizing. Try again shortly.");
  const count = BigInt(units), estimate = (BigInt(fees.baselineMicroLamports) * count + 999_999n) / 1_000_000n;
  const floor = BigInt(fees.baselineFloorLamports), cap = BigInt(fees.baselineCapLamports);
  const budget = estimate < floor ? floor : estimate > cap ? cap : estimate;
  const microLamports = (budget * 1_000_000n + count - 1n) / count;
  return { microLamports, lamports: (microLamports * count + 999_999n) / 1_000_000n };
}

export async function sizeCompute(tx: Transaction, rpc: Pick<Connection, "simulateTransaction">, slot: number, tables: AddressLookupTableAccount[] = [], state?: BookingComputeState) {
  if (!state) return measureCompute(tx, rpc, slot, tables);
  const consumed = bookingCompute(state), units = consumed + Math.ceil(consumed / 10) + 1_000;
  tx.instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units }), ...tx.instructions.filter(ix => !ix.programId.equals(ComputeBudgetProgram.programId) || ![2, 3].includes(ix.data[0]))];
  return units;
}

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
