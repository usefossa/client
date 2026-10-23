import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { signMessage } from "../src/signing";
import { verifyMessage } from "./signing";
import { Store, parseKey, type Pending } from "../src/store";
import type { Account } from "../src/types";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));

test("journal terminal accounting survives stale stream, history and timing writes without repeated updates", () => {
  const directory = mkdtempSync(join(tmpdir(), "fossa-monotonic-")); directories.push(directory); const store = new Store(directory);
  try {
    const row = { id: "request", wallet: "wallet", booking: "booking", generation: "1", stage: "inference", created: 1, reserve: "10", signature: "signature" } as Pending;
    store.put(row); store.put({ ...row, stage: "settled", charge: "7", settledAt: 2 });
    store.put({ ...row, stage: "settling", responseCompleted: true, responseFinishedAt: 3 });
    store.put({ ...row, stage: "released", charge: "0", processedMs: 4 });
    const saved = store.request(row.id, row.wallet)!;
    expect(saved.stage).toBe("settled"); expect(saved.charge).toBe("7"); expect(saved.settledAt).toBe(2);
    expect(saved.responseCompleted).toBe(true); expect(saved.responseFinishedAt).toBe(3); expect(saved.processedMs).toBe(4);
    const changes = () => (store.db.query("SELECT total_changes() AS count").get() as { count: number }).count;
    const before = changes(); store.put({ ...saved }); expect(changes()).toBe(before);
  } finally { store.close(); }
});

test("scoped journals preserve exact generations, alternate API recovery and unknown legacy records", () => {
  const directory = mkdtempSync(join(tmpdir(), "fossa-scopes-")); directories.push(directory); const store = new Store(directory);
  const scope = { program: "program", market: "market", lane: "lane", genesis: "chain", mint: "mint" };
  try {
    const row = { wallet: "wallet", booking: "booking", kind: "inference", session: "session", flow: "primary", stage: "uncertain", signature: "signature", transaction: "legacy bytes", created: 1 } as Pending;
    for (const [id, generation] of [["small", "1"], ["large", "9223372036854775808"], ["largest", "18446744073709551615"]]) store.put({ ...row, id, generation, scope });
    store.put({ ...row, id: "different-lane", generation: "2", scope: { ...scope, lane: "other" } });
    store.put({ ...row, id: "different-network", generation: "3", scope: { ...scope, genesis: "other" } });
    store.put({ ...row, id: "legacy", generation: "4" });
    store.put({ ...row, id: "old-scope", generation: "5", scope: { program: scope.program, market: scope.market, lane: scope.lane } });
    store.put({ ...row, id: "unknown-terminal", generation: "6", stage: "settled", charge: "9" });
    expect(store.generation("wallet", scope)).toBe(18446744073709551615n);
    expect(store.pending("wallet", { ...scope }, true).map(value => value.id)).toEqual(["small", "large", "largest"]);
    expect(store.accounting("wallet", 0, "chain").map(value => value.id)).toEqual(["small", "large", "largest", "different-lane"]);
    expect(store.legacy("wallet").map(value => value.id)).toEqual(["legacy", "old-scope"]);
    expect(store.history("wallet", scope)).toHaveLength(3); expect(store.request("unknown-terminal", "wallet")?.charge).toBe("9");
    store.migrateJournal(); store.migrateJournal(); expect(store.request("legacy", "wallet")?.transaction).toBe("legacy bytes");
  } finally { store.close(); }
});

test("imported key remains able to sign after temporary input is zeroed", async () => {
  const owner = await Keypair.generate(), encoded = bs58.encode(owner.secretKey), imported = await parseKey(encoded), message = new TextEncoder().encode("local wallet ownership");
  expect(verifyMessage(message, signMessage(message, imported.secretKey), owner.publicKey.toBytes())).toBe(true);
  expect((await parseKey(JSON.stringify([...owner.secretKey]))).publicKey.equals(owner.publicKey)).toBe(true);
  await expect(parseKey(JSON.stringify(new Array(32).fill(256)))).rejects.toThrow();
  imported.secretKey.fill(0); owner.secretKey.fill(0);
});

test("wallet persists encrypted and wrong passphrase cannot unlock or sign", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fossa-wallet-test-")); directories.push(directory);
  const owner = await Keypair.generate(), passphrase = "abc", account: Account = { walletId: "wallet-test", wallet: owner.publicKey.toString(), lane: (await Keypair.generate()).publicKey.toString(), name: "Test", apiUrl: "http://127.0.0.1:1", access: "", refresh: "", expires: 0 };
  let store = new Store(directory);
  await store.save(account, { owner: [...owner.secretKey], bookings: {} }, passphrase);
  store.close();
  const bytes = readFileSync(join(directory, "wallets.sqlite"));
  expect(bytes.includes(Buffer.from(owner.secretKey))).toBe(false);
  expect(bytes.includes(Buffer.from(bs58.encode(owner.secretKey)))).toBe(false);
  store = new Store(directory);
  expect(() => store.secrets(account.walletId)).toThrow(/unlock/i);
  await expect(store.unlock(account.walletId, "incorrect passphrase")).rejects.toThrow("Incorrect");
  expect(store.unlocked(account.walletId)).toBe(false);
  await store.unlock(account.walletId, passphrase);
  expect(store.secrets(account.walletId).owner).toEqual([...owner.secretKey]);
  store.lock(); expect(store.unlocked(account.walletId)).toBe(false); store.close(); owner.secretKey.fill(0);
});

test("separate store connections serialize one wallet and preserve journal before recovery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fossa-lock-test-")); directories.push(directory);
  const one = new Store(directory), two = new Store(directory), order: string[] = [];
  await Promise.all([one.exclusive("wallet", async () => { order.push("one-start"); await Bun.sleep(150); order.push("one-end"); }), two.exclusive("wallet", async () => { order.push("two-start"); order.push("two-end"); })]);
  expect(order).toEqual(["one-start", "one-end", "two-start", "two-end"]);
  one.put({ id: "request", wallet: "wallet", model: "model", bodyHash: "hash", kind: "inference", session: "session", booking: "booking", generation: "2", signature: "signature", transaction: "signed bytes", expiry: 1, reserve: "1000", stage: "uncertain", created: Date.now() });
  expect(two.request("request", "wallet")?.transaction).toBe("signed bytes");
  expect(two.request("request", "other-wallet")).toBeUndefined();
  expect(two.request("missing", "wallet")).toBeUndefined();
  one.close(); expect(two.pending("wallet")[0].transaction).toBe("signed bytes"); expect(two.pending("wallet")[0].reserve).toBe("1000"); two.close();
});

test("automatic encryption survives restart and optional protection preserves all signing keys", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fossa-security-test-")); directories.push(directory);
  const owner = await Keypair.generate(), lane = await Keypair.generate(), booking = await Keypair.generate();
  const account: Account = { walletId: "security-test", wallet: owner.publicKey.toString(), lane: lane.publicKey.toString(), name: "Test", apiUrl: "http://127.0.0.1:1", access: "", refresh: "", expires: 0 };
  const secrets = { owner: [...owner.secretKey], lane: [...lane.secretKey], bookings: { [booking.publicKey.toString()]: [...booking.secretKey] } };
  let store = new Store(directory);
  await store.save(account, secrets);
  expect(store.security(account.walletId)).toEqual({ protected: false, unlocked: true });
  expect(statSync(join(directory, "device.key")).mode & 0o777).toBe(0o600);
  store.close(); store = new Store(directory); await store.autoUnlock(account.walletId);
  expect(store.secrets(account.walletId)).toEqual(secrets);
  await expect(store.protect(account, "ab")).rejects.toThrow("3 characters");
  await store.protect(account, "abc");
  expect(store.secrets(account.walletId)).toEqual(secrets);
  store.close(); store = new Store(directory); await store.autoUnlock(account.walletId);
  expect(store.security(account.walletId)).toEqual({ protected: true, unlocked: false });
  await expect(store.protect(account)).rejects.toThrow(/unlock/i);
  await store.unlock(account.walletId, "abc");
  await store.protect(account, "new passphrase"); store.lock();
  await expect(store.unlock(account.walletId, "abc")).rejects.toThrow("Incorrect");
  await store.unlock(account.walletId, "new passphrase");
  await store.protect(account);
  expect(store.secrets(account.walletId)).toEqual(secrets);
  store.close(); store = new Store(directory); await store.autoUnlock(account.walletId);
  expect(store.secrets(account.walletId)).toEqual(secrets);
  store.close(); owner.secretKey.fill(0); lane.secretKey.fill(0); booking.secretKey.fill(0);
});

test("legacy passphrase wallets migrate only after a successful unlock", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fossa-legacy-test-")); directories.push(directory);
  const owner = await Keypair.generate(), store = new Store(directory);
  const account: Account = { walletId: "legacy", wallet: owner.publicKey.toString(), lane: "", name: "Test", apiUrl: "http://127.0.0.1:1", access: "", refresh: "", expires: 0 };
  await store.save(account, { owner: [...owner.secretKey], bookings: {} }, "old passphrase");
  const row = store.db.query("SELECT sealed FROM wallets WHERE id=?").get(account.walletId) as { sealed: string }, sealed = JSON.parse(row.sealed);
  delete sealed.protection;
  store.db.query("UPDATE wallets SET sealed=? WHERE id=?").run(JSON.stringify(sealed), account.walletId); store.lock();
  await store.autoUnlock(account.walletId); expect(store.unlocked(account.walletId)).toBe(false);
  await expect(store.protect(account)).rejects.toThrow(/unlock/i);
  await store.unlock(account.walletId, "old passphrase"); await store.protect(account);
  expect(store.security(account.walletId).protected).toBe(false);
  expect(store.secrets(account.walletId).owner).toEqual([...owner.secretKey]);
  store.close(); owner.secretKey.fill(0);
});
