import { AddressLookupTableAccount, AddressLookupTableProgram, PublicKey, TransactionMessage, VersionedTransaction, type Connection, type Transaction } from "@solana/web3.js";
import { Buffer } from "buffer";

const cache = new WeakMap<Connection, { identity: string; at: number; value: Promise<AddressLookupTableAccount[]> }>();
export async function bookingLookupTables(rpc: Connection, addresses: string[] = []) {
  if (!Array.isArray(addresses) || addresses.length > 32) throw Error("Invalid provider limit lookup tables.");
  if (!addresses.length) return [];
  const keys = addresses.map(address => new PublicKey(address));
  const identity = keys.map(key => key.toBase58()).join(":");
  const previous = cache.get(rpc);
  if (previous?.identity === identity && Date.now() - previous.at < 5_000) return previous.value;
  const value = rpc.getMultipleAccountsInfoAndContext(keys, "confirmed").then(({ context, value: accounts }) => accounts.map((info, index) => {
    if (!info || info.executable || !info.owner.equals(AddressLookupTableProgram.programId)) throw Error("Invalid provider limit lookup table owner.");
    const state = AddressLookupTableAccount.deserialize(Buffer.from(info.data));
    if (state.deactivationSlot !== 0xffffffffffffffffn) throw Error("Provider limit lookup table is inactive.");
    if (context.slot <= state.lastExtendedSlot) state.addresses = state.addresses.slice(0, state.lastExtendedSlotStartIndex);
    return new AddressLookupTableAccount({ key: keys[index], state });
  }));
  cache.set(rpc, { identity, at: Date.now(), value });
  void value.catch(() => { if (cache.get(rpc)?.value === value) cache.delete(rpc); });
  return value;
}
export function compileBookingTransaction(tx: Transaction, tables: AddressLookupTableAccount[] = []) {
  if (!tx.feePayer || !tx.recentBlockhash) throw Error("Booking transaction is incomplete.");
  const message = tables.length ? new TransactionMessage({ payerKey: tx.feePayer, recentBlockhash: tx.recentBlockhash, instructions: tx.instructions }).compileToV0Message(tables) : tx.compileMessage();
  const transaction = new VersionedTransaction(message);
  if (transaction.serialize().length > 1232) throw Error("Booking transaction too large; configure provider limit lookup tables.");
  return transaction;
}
