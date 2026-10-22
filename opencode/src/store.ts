import { Database } from "bun:sqlite";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, scrypt, randomUUID } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { defaultSettings, priceFields, validateSettings } from "./routing";
import { defaultRakeback, validateRakeback } from "./rakeback";
import { FossaError, type Account, type Settings, type WalletSecrets } from "./types";

const derive = (passphrase: string, salt: Buffer) => new Promise<Buffer>((resolve, reject) => scrypt(passphrase, salt, 32, { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
type Sealed = { protection?: "device" | "passphrase"; salt: string; iv: string; tag: string; ciphertext: string };
export interface Pending { previousRequestId?: string; previousResponseFinishedAt?: number; requestGapMs?: number; gapToSubmitMs?: number; gapToProviderMs?: number; modelRequestAt?: number; transportReceivedAt?: number; walletLockMs?: number; recoveryWaitMs?: number; admissionWaitMs?: number; bookingPoolWaitMs?: number; bookingObservedAt?: number; providerDispatchedAt?: number; responseHeadersAt?: number; firstByteAt?: number; responseDoneAt?: number; responseFinishedAt?: number; responseCompleted?: boolean; settlementSlot?: number; settledAt?: number; confirmationMs?: number; cancelRequested?: boolean; cancelSent?: boolean; id: string; wallet: string; model: string; bodyHash: string; cache?: { messages: number; prefix: string }; kind: string; flow?: string; session: string; booking: string; generation: string; signature: string; transaction: string; expiry: number; reserve: string; stage: string; provider?: string; providerName?: string; endpoint?: string; claimEnd?: number; charge?: string; deposit?: string; withdrawal?: string; refund?: string; feeLamports?: string; processedSlot?: number; startedAt?: number; submittedAt?: number; prepareMs?: number; broadcastMs?: number; processedMs?: number; bookingSource?: "stream" | "rpc"; dispatchStarted?: boolean; providerRequestMs?: number; sendToProviderMs?: number; usage?: { input: number; cached: number; output: number }; created: number; error?: string }

export function validatePassphrase(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 3) throw new FossaError("WEAK_PASSPHRASE", "Use a local wallet passphrase of at least 3 characters.");
}

export async function parseKey(value: string) {
  let bytes: Uint8Array;
  try { if (value.trim().startsWith("[")) { const array = JSON.parse(value); if (!Array.isArray(array) || !array.every(item => Number.isInteger(item) && item >= 0 && item <= 255)) throw Error("bytes"); bytes = Uint8Array.from(array); } else bytes = bs58.decode(value.trim()); }
  catch { throw new FossaError("INVALID_KEY", "Enter a Base58 private key or Solana keypair JSON array."); }
  try {
    if (bytes.length === 32) return await Keypair.fromSeed(bytes);
    if (bytes.length === 64) return await Keypair.fromSecretKey(Uint8Array.from(bytes));
    throw new FossaError("INVALID_KEY", "Private key must contain 32 or 64 bytes.");
  } finally { bytes.fill(0); }
}

export class Store {
  readonly db: Database;
  private keys = new Map<string, WalletSecrets>();
  constructor(directory = join(homedir(), ".local", "share", "fossa-opencode")) {
    mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
    const path = join(directory, "wallets.sqlite"); this.db = new Database(path, { create: true }); chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000; CREATE TABLE IF NOT EXISTS wallets(id TEXT PRIMARY KEY,address TEXT NOT NULL,name TEXT NOT NULL,sealed TEXT NOT NULL,settings TEXT); CREATE TABLE IF NOT EXISTS pending(id TEXT PRIMARY KEY,wallet TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS pending_wallet_created ON pending(wallet,created); CREATE TABLE IF NOT EXISTS model_settings(wallet TEXT NOT NULL,model TEXT NOT NULL,settings TEXT NOT NULL,PRIMARY KEY(wallet,model)); CREATE TABLE IF NOT EXISTS locks(wallet TEXT PRIMARY KEY,owner TEXT NOT NULL,pid INTEGER NOT NULL,expires INTEGER NOT NULL)");
  }
  private deviceKey(create = false) {
    const path = join(dirname(this.db.filename), "device.key");
    if (create) {
      let fd: number | undefined;
      const bytes = randomBytes(32);
      try { fd = openSync(path, "wx", 0o600); writeFileSync(fd, bytes); fsyncSync(fd); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      finally { bytes.fill(0); if (fd !== undefined) closeSync(fd); }
    }
    let key: Buffer;
    try { key = readFileSync(path); }
    catch { throw new FossaError("DEVICE_KEY_MISSING", "Local encryption key is missing. Restore this computer's wallet backup."); }
    if (key.length !== 32) { key.fill(0); throw new FossaError("DEVICE_KEY_INVALID", "Local encryption key is damaged. Restore this computer's wallet backup."); }
    chmodSync(path, 0o600); return key;
  }
  security(id: string) {
    const row = this.db.query("SELECT sealed FROM wallets WHERE id=?").get(id) as { sealed: string } | null;
    if (!row) throw new FossaError("WALLET_MISSING", "Wallet is unavailable on this PC. Connect Fossa again.");
    return { protected: (JSON.parse(row.sealed) as Sealed).protection !== "device", unlocked: this.unlocked(id) };
  }
  async autoUnlock(id: string) { if (!this.unlocked(id) && !this.security(id).protected) await this.unlock(id); }
  async protect(account: Account, passphrase?: string) {
    await this.autoUnlock(account.walletId);
    await this.save(account, this.secrets(account.walletId), passphrase);
  }
  async save(account: Account, secrets: WalletSecrets, passphrase?: string, signal?: AbortSignal) {
    if (passphrase !== undefined) validatePassphrase(passphrase);
    const salt = randomBytes(32), iv = randomBytes(12);
    const plain = Buffer.from(JSON.stringify(secrets));
    let key: Buffer | undefined;
    try {
      key = passphrase === undefined ? this.deviceKey(true) : await derive(passphrase, salt);
      const cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(Buffer.from(account.walletId));
      const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
      const sealed: Sealed = { protection: passphrase === undefined ? "device" : "passphrase", salt: salt.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: encrypted.toString("base64") };
      signal?.throwIfAborted();
      this.db.query("INSERT INTO wallets(id,address,name,sealed) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET address=excluded.address,name=excluded.name,sealed=excluded.sealed").run(account.walletId, account.wallet, account.name, JSON.stringify(sealed));
      const copy = JSON.parse(plain.toString()) as WalletSecrets; this.lock(account.walletId); this.keys.set(account.walletId, copy);
    } finally { key?.fill(0); plain.fill(0); }
  }
  async unlock(id: string, passphrase?: string) {
    const row = this.db.query("SELECT sealed,address FROM wallets WHERE id=?").get(id) as { sealed: string; address: string } | null;
    if (!row) throw new FossaError("WALLET_MISSING", "Wallet is unavailable on this PC. Connect Fossa again.");
    const sealed = JSON.parse(row.sealed) as Sealed;
    if (sealed.protection !== "device" && passphrase === undefined) throw new FossaError("WALLET_LOCKED", "Enter your passphrase to unlock this wallet.");
    const key = sealed.protection === "device" ? this.deviceKey() : await derive(passphrase!, Buffer.from(sealed.salt, "base64"));
    let plain: Buffer | undefined;
    try {
      const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64")); cipher.setAAD(Buffer.from(id)); cipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
      plain = Buffer.concat([cipher.update(Buffer.from(sealed.ciphertext, "base64")), cipher.final()]);
      const secrets = JSON.parse(plain.toString()) as WalletSecrets;
      const owner = await Keypair.fromSecretKey(Uint8Array.from(secrets.owner));
      if (owner.publicKey.toBase58() !== row.address) throw Error("identity");
      owner.secretKey.fill(0); this.lock(id); this.keys.set(id, secrets);
    } catch { throw new FossaError("WALLET_LOCKED", "Incorrect passphrase or damaged local wallet."); }
    finally { key.fill(0); plain?.fill(0); }
  }
  secrets(id: string) { const value = this.keys.get(id); if (!value) throw new FossaError("WALLET_LOCKED", "Enter your passphrase to unlock your Fossa wallet, then send your message again."); return value; }
  unlocked(id: string) { return this.keys.has(id); }
  lock(id?: string) { for (const [key, secrets] of this.keys) if (!id || key === id) { secrets.owner.fill(0); secrets.lane?.fill(0); Object.values(secrets.bookings).forEach(value => value.fill(0)); this.keys.delete(key); } }
  lockProtected() { for (const id of this.keys.keys()) if (this.security(id).protected) this.lock(id); }
  wallets() { return this.db.query("SELECT id,address,name FROM wallets ORDER BY name").all() as { id: string; address: string; name: string }[]; }
  settings(id: string, model: string) {
    const row = this.db.query("SELECT settings FROM model_settings WHERE wallet=? AND model=?").get(id, model) as { settings: string } | null;
    if (row) return validateSettings(JSON.parse(row.settings));
    const legacy = this.db.query("SELECT settings FROM wallets WHERE id=?").get(id) as { settings: string | null } | null;
    const old = legacy?.settings ? JSON.parse(legacy.settings) : {};
    return validateSettings(Object.fromEntries(["minSpeed", ...priceFields].filter(key => old[key] !== undefined).map(key => [key, old[key]])), defaultSettings);
  }
  setSettings(id: string, model: string, value: Settings) { this.db.query("INSERT INTO model_settings VALUES(?,?,?) ON CONFLICT(wallet,model) DO UPDATE SET settings=excluded.settings").run(id, model, JSON.stringify(validateSettings(value))); }
  rakeback(id: string) {
    this.db.exec("CREATE TABLE IF NOT EXISTS rakeback_settings(wallet TEXT PRIMARY KEY,settings TEXT NOT NULL,last_run INTEGER NOT NULL DEFAULT 0)");
    const row = this.db.query("SELECT settings,last_run FROM rakeback_settings WHERE wallet=?").get(id) as { settings: string; last_run: number } | null;
    return { settings: row ? validateRakeback(JSON.parse(row.settings)) : { ...defaultRakeback }, lastRun: row?.last_run ?? 0 };
  }
  setRakeback(id: string, patch: unknown) {
    const value = validateRakeback(patch, this.rakeback(id).settings);
    this.db.query("INSERT INTO rakeback_settings(wallet,settings) VALUES(?,?) ON CONFLICT(wallet) DO UPDATE SET settings=excluded.settings").run(id, JSON.stringify(value));
    return value;
  }
  rakebackRan(id: string) { this.setRakeback(id, {}); this.db.query("UPDATE rakeback_settings SET last_run=? WHERE wallet=?").run(Date.now(), id); }
  pending(wallet?: string) { return (wallet ? this.db.query("SELECT state FROM pending WHERE wallet=? ORDER BY created").all(wallet) : this.db.query("SELECT state FROM pending ORDER BY created").all()).map(row => JSON.parse((row as { state: string }).state) as Pending); }
  request(id: string, wallet: string) { const row = this.db.query("SELECT state FROM pending WHERE id=? AND wallet=?").get(id, wallet) as { state: string } | null; return row ? JSON.parse(row.state) as Pending : undefined; }
  put(value: Pending) {
    const previous = this.request(value.id, value.wallet);
    if (previous?.settlementSlot !== undefined && previous.booking === value.booking && previous.generation === value.generation
      && (value.settlementSlot === undefined || previous.settlementSlot >= value.settlementSlot)) {
      value.stage = previous.stage; value.charge = previous.charge; value.settlementSlot = previous.settlementSlot; value.settledAt = previous.settledAt;
    }
    if (previous?.cancelRequested) value.cancelRequested = true;
    if (previous?.cancelSent) value.cancelSent = true;
    if (value.cancelRequested && !["settled", "released", "failed", "expired"].includes(value.stage)) value.stage = "uncertain";
    this.db.query("INSERT INTO pending VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state").run(value.id, value.wallet, JSON.stringify(value), value.created); }
  async exclusive<T>(wallet: string, action: () => Promise<T>) {
    const owner = randomUUID(), deadline = Date.now() + 60_000;
    while (true) {
      const old = this.db.query("SELECT pid,expires FROM locks WHERE wallet=?").get(wallet) as { pid: number; expires: number } | null;
      if (old && old.expires < Date.now()) { let alive = true; try { process.kill(old.pid, 0); } catch { alive = false; } if (!alive) this.db.query("DELETE FROM locks WHERE wallet=? AND pid=?").run(wallet, old.pid); }
      if (this.db.query("INSERT OR IGNORE INTO locks VALUES(?,?,?,?)").run(wallet, owner, process.pid, Date.now() + 60_000).changes) break;
      if (Date.now() > deadline) throw new FossaError("WALLET_BUSY", "Another Fossa request is using this wallet. Wait for its booking to process.");
      await Bun.sleep(100);
    }
    const timer = setInterval(() => this.db.query("UPDATE locks SET expires=? WHERE wallet=? AND owner=?").run(Date.now() + 60_000, wallet, owner), 10_000);
    try { return await action(); } finally { clearInterval(timer); this.db.query("DELETE FROM locks WHERE wallet=? AND owner=?").run(wallet, owner); }
  }
  close() { this.lock(); this.db.close(); }
}

const shared = Symbol.for("fossa.opencode.local-wallet-store");
export function localStore() {
  const cache = globalThis as typeof globalThis & { [shared]?: Store };
  const store = cache[shared] ??= new Store();
  Object.setPrototypeOf(store, Store.prototype);
  store.db.exec("CREATE TABLE IF NOT EXISTS model_settings(wallet TEXT NOT NULL,model TEXT NOT NULL,settings TEXT NOT NULL,PRIMARY KEY(wallet,model)); CREATE INDEX IF NOT EXISTS pending_wallet_created ON pending(wallet,created)");
  return store;
}
