import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { Buffer } from "buffer";

const HEADER = 112, STRIDE = 48;
const DISCRIMINATOR = Buffer.from([89, 4, 132, 220, 207, 78, 178, 52]);
const names = { initialize: "2b3d7d77c7961cf6", grow: "1266c09032fe285b", prune: "0e7cedad30bd29ae", close: "42c312f1e335d339" };
type Account = { owner: PublicKey; data: Uint8Array };
export interface ProviderWalletSnapshot { address: string; owner: string; data: string; slot: number; snapshotSlot: number; version: number }
const meta = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });

export function cachedProviderWallet(snapshot: ProviderWalletSnapshot | null | undefined, address: PublicKey, minimumSlot: number): Account | undefined {
  if (!snapshot || !Number.isSafeInteger(snapshot.snapshotSlot) || snapshot.snapshotSlot < minimumSlot) return;
  if (snapshot.address !== address.toString() || !Number.isSafeInteger(snapshot.slot) || snapshot.slot < 0 || snapshot.slot > snapshot.snapshotSlot
    || typeof snapshot.data !== "string" || snapshot.data.length > 14_000_000 || snapshot.data.length % 4 !== 0 || /[^A-Za-z0-9+/=]|=[^=]|={3}/.test(snapshot.data)) throw Error("Invalid provider wallet snapshot.");
  return { owner: new PublicKey(snapshot.owner), data: Buffer.from(snapshot.data, "base64") };
}

export async function providerWalletAddress(program: PublicKey, market: PublicKey, owner: PublicKey) {
  return (await PublicKey.findProgramAddress([Buffer.from("provider_wallet"), market.toBytes(), owner.toBytes()], program))[0];
}
export async function listRoutingAddresses(program: PublicKey, list: PublicKey, model: PublicKey) {
  const derive = async (seed: string, includeModel = true) => (await PublicKey.findProgramAddress([Buffer.from(seed), list.toBytes(), ...(includeModel ? [model.toBytes()] : [])], program))[0];
  return { routing: await derive("list_routing", false), terms: await derive("list_terms"), capacity: await derive("list_capacity") };
}
export function decodeProviderWallet(info: Account, program: PublicKey, market: PublicKey, owner: PublicKey) {
  const data = Buffer.from(info.data);
  if (!info.owner.equals(program) || data.length < HEADER || (data.length - HEADER) % STRIDE || !data.subarray(0, 8).equals(DISCRIMINATOR)
    || !data.subarray(8, 40).equals(Buffer.from(market.toBytes())) || !data.subarray(40, 72).equals(Buffer.from(owner.toBytes())) || data.subarray(105, 108).some(Boolean)) throw Error("Invalid provider wallet account.");
  const count = data.readUInt32LE(108), capacity = (data.length - HEADER) / STRIDE;
  if (count > capacity) throw Error("Invalid provider wallet account.");
  return { count, capacity, rentPayer: new PublicKey(data.subarray(72, 104)) };
}
export function providerWalletInstruction(action: keyof typeof names, program: PublicKey, market: PublicKey, owner: PublicKey, wallet: PublicKey, payer = owner, limit = 0) {
  const payload = Buffer.alloc(action === "initialize" || action === "grow" ? 4 : 0);
  if (payload.length) payload.writeUInt32LE(limit);
  const keys = action === "initialize" ? [meta(market), meta(owner, false, true), meta(payer, true, true), meta(wallet, true), meta(SystemProgram.programId)]
    : action === "grow" ? [meta(owner, false, true), meta(wallet, true), meta(payer, true, true), meta(SystemProgram.programId)]
      : action === "close" ? [meta(owner, false, true), meta(wallet, true), meta(payer, true)] : [meta(owner, false, true), meta(wallet, true)];
  return new TransactionInstruction({ programId: program, data: Buffer.concat([Buffer.from(names[action], "hex"), payload]), keys });
}
export async function prepareProviderWallet(program: PublicKey, market: PublicKey, owner: PublicKey, read: (address: PublicKey) => Promise<Account | null>) {
  const address = await providerWalletAddress(program, market, owner), info = await read(address);
  if (!info) return { address, instructions: [providerWalletInstruction("initialize", program, market, owner, address, owner, 8)], rentSize: HEADER + STRIDE * 8 };
  const state = decodeProviderWallet(info, program, market, owner);
  if (state.count < state.capacity) return { address, instructions: [], rentSize: 0 };
  if (state.capacity > 0xffffffff - 8) throw Error("Provider wallet storage is full.");
  const size = HEADER + STRIDE * (state.capacity + 8);
  return { address, instructions: [providerWalletInstruction("prune", program, market, owner, address), providerWalletInstruction("grow", program, market, owner, address, owner, state.capacity + 8)], rentSize: size, previousSize: HEADER + STRIDE * state.capacity };
}
