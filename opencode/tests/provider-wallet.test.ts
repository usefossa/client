import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import { cachedProviderWallet, decodeProviderWallet, prepareProviderWallet, providerWalletAddress } from "../src/inference/provider-wallet";

test("provider wallet preparation binds identity and grows full storage without resetting counters", async () => {
  const program = (await Keypair.generate()).publicKey, market = (await Keypair.generate()).publicKey, owner = (await Keypair.generate()).publicKey;
  const missing = await prepareProviderWallet(program, market, owner, async () => null);
  assert.ok(missing.address.equals(await providerWalletAddress(program, market, owner)));
  assert.equal(Buffer.from(missing.instructions[0].data).toString("hex"), "2b3d7d77c7961cf608000000");
  assert.equal(missing.instructions[0].keys.length, 5);
  const data = Buffer.alloc(112 + 48 * 8);
  data.set([89, 4, 132, 220, 207, 78, 178, 52]); data.set(market.toBytes(), 8); data.set(owner.toBytes(), 40); data.set(owner.toBytes(), 72);
  const snapshot = { address: missing.address.toString(), owner: program.toString(), data: data.toString("base64"), slot: 50, snapshotSlot: 100, version: 1 };
  assert.deepEqual(cachedProviderWallet(snapshot, missing.address, 100)?.data, data);
  assert.equal(cachedProviderWallet(snapshot, missing.address, 101), undefined);
  assert.throws(() => cachedProviderWallet({ ...snapshot, address: owner.toString() }, missing.address, 100), /Invalid provider wallet snapshot/);
  const read = async () => ({ owner: program, data });
  assert.equal((await prepareProviderWallet(program, market, owner, read)).instructions.length, 0);
  data.writeUInt32LE(8, 108);
  const full = await prepareProviderWallet(program, market, owner, read);
  assert.deepEqual(full.instructions.map(ix => Buffer.from(ix.data).toString("hex")), ["0e7cedad30bd29ae", "1266c09032fe285b10000000"]);
  data.writeUInt32LE(9, 108);
  assert.throws(() => decodeProviderWallet({ owner: program, data }, program, market, owner), /Invalid provider wallet/);
  data.writeUInt32LE(0, 108);
  assert.throws(() => decodeProviderWallet({ owner: PublicKey.default, data }, program, market, owner), /Invalid provider wallet/);
  data[40] ^= 1;
  assert.throws(() => decodeProviderWallet({ owner: program, data }, program, market, owner), /Invalid provider wallet/);
});


test("cached ledger accepts large accounts and rejects malformed base64 padding", () => {
  const program = new PublicKey(new Uint8Array(32).fill(1)), market = new PublicKey(new Uint8Array(32).fill(2)), owner = new PublicKey(new Uint8Array(32).fill(3));
  const data = Buffer.alloc(112 + 48 * 100_000);
  data.set([89, 4, 132, 220, 207, 78, 178, 52]); data.set(market.toBytes(), 8); data.set(owner.toBytes(), 40); data.set(owner.toBytes(), 72);
  const snapshot = { address: owner.toString(), owner: program.toString(), data: data.toString("base64"), slot: 100, snapshotSlot: 100, version: 1 };
  const cached = cachedProviderWallet(snapshot, owner, 100)!;
  assert.equal(cached.data.length, 4_800_112);
  assert.deepEqual(decodeProviderWallet(cached, program, market, owner), { count: 0, capacity: 100_000, rentPayer: owner });
  for (const encoded of ["", "Zg==", "Zm8=", "Zm9v", "////", "++++"]) assert.deepEqual(cachedProviderWallet({ ...snapshot, data: encoded }, owner, 100)?.data, Buffer.from(encoded, "base64"));
  for (const encoded of ["A", "AA", "AAA", "====", "A===", "AA=A", "AA==AAAA", "AA~A", "AA\nA", "AAA\n", "AAA\r", "AAA\u2028", "AAA\u2029", "AAAA===="]) assert.throws(() => cachedProviderWallet({ ...snapshot, data: encoded }, owner, 100), /Invalid provider wallet snapshot/);
});
