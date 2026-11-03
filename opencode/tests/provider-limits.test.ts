import { test } from "node:test";
import assert from "node:assert/strict";
import { AddressLookupTableAccount, Keypair, Transaction, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { Buffer } from "buffer";
import { compileBookingTransaction } from "../src/booking-transaction";
import { providerQuotaAvailable } from "../src/provider-limits";
import { providerLimitPageAddress, providerLimitPages } from "../src/provider-wallet";

test("provider quota expires without catalog writes and malformed counters fail closed", () => {
  const provider = { providerLimits: { global: { concurrency: 300, quota: 300, quotaWindowSeconds: 60 }, wallet: { concurrency: 300, quota: 300, quotaWindowSeconds: 60 } }, quotaUsed: 300, quotaWindowEnd: 120 };
  assert.equal(providerQuotaAvailable(provider, 119), false);
  assert.equal(providerQuotaAvailable(provider, 120), true);
  assert.equal(providerQuotaAvailable({ ...provider, quotaUsed: undefined }, 119), false);
  assert.equal(providerQuotaAvailable({}), true);
  assert.equal(providerQuotaAvailable({ ...provider, providerLimits: { ...provider.providerLimits, global: { ...provider.providerLimits.global, quota: 0 } } }), true);
});

test("complete provider page set fits versioned packets without omitting providers", async () => {
  const owner = await Keypair.generate(), program = (await Keypair.generate()).publicKey, market = (await Keypair.generate()).publicKey;
  const offers = Array.from({ length: 100 }, (_, index) => ({ providerLimitId: ((index >>> 5) << 5) | (index & 31) }));
  const pages = await providerLimitPages(program, market, offers);
  assert.equal(pages.length, 32);
  for (let page = 0; page < 32; page++) assert.ok(pages[page].equals(await providerLimitPageAddress(program, market, page)));
  await assert.rejects(providerLimitPages(program, market, [{ providerLimitId: undefined }]), /provider limit/i);
  const tx = new Transaction({ feePayer: owner.publicKey, recentBlockhash: String((await Keypair.generate()).publicKey.toBase58()) as NonNullable<Transaction["recentBlockhash"]> }).add(new TransactionInstruction({ programId: program, data: Buffer.alloc(168), keys: [market, ...pages].map(pubkey => ({ pubkey, isWritable: true, isSigner: false })) }));
  const table = new AddressLookupTableAccount({ key: (await Keypair.generate()).publicKey, state: { deactivationSlot: 0xffffffffffffffffn, lastExtendedSlot: 1n, lastExtendedSlotStartIndex: 0, addresses: [market, ...pages] } });
  const transaction = compileBookingTransaction(tx, [table]);
  await transaction.sign([owner]);
  const wire = transaction.serialize();
  assert.ok(wire.length <= 1232);
  assert.equal(VersionedTransaction.deserialize(wire).message.compiledInstructions[0].accountKeyIndexes.length, 33);
  assert.throws(() => compileBookingTransaction(tx).serialize(), /overrun|too large|encoding/i);
});
