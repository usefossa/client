import { createHash, generateKeyPairSync, privateDecrypt, randomInt, constants } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { api, config, safeUrl } from "./api";
import { signMessage } from "./signing";
import { Store, parseKey } from "./store";
import { FossaError, type Account, type PublicConfig, type WalletSecrets } from "./types";

type Identity = Pick<Account, "wallet" | "lane" | "access" | "refresh" | "expires">;
type Device = { id: string; pollToken: string; code: string; url: string; expires: number };
type Delivery = Identity & { sealedKey: string; sealedLaneKey: string; pending?: boolean };

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const child = (owner: Keypair, cfg: PublicConfig, label: string) => Keypair.fromSeed(createHash("sha256").update(owner.secretKey.subarray(0, 32)).update(`fossa-opencode-v1:${cfg.market}:${label}`).digest());

async function install(store: Store, apiUrl: string, cfg: PublicConfig, identity: Identity, owner: Keypair, lane: Keypair, quick = false, signal?: AbortSignal) {
  if (owner.publicKey.toBase58() !== identity.wallet || lane.publicKey.toBase58() !== identity.lane) throw new FossaError("IDENTITY_CHANGED", "Fossa returned an unexpected signing identity.");
  const { wallet, lane: address, access, refresh, expires } = identity;
  const account: Account = { wallet, lane: address, access, refresh, expires, apiUrl, walletId: hash(`${apiUrl}:${wallet}:${address}`), name: `Fossa ${wallet.slice(0, 4)}…${wallet.slice(-4)}` };
  if (store.wallets().some(value => value.id === account.walletId)) { await store.autoUnlock(account.walletId); return account; }
  const secrets: WalletSecrets = { owner: [...owner.secretKey], lane: [...lane.secretKey], bookings: {} };
  try {
    for (let index = 0; index < cfg.opencode.localBookingPoolSize; index++) {
      const key = await child(owner, cfg, `${quick ? `${address}:` : ""}booking:${index}`);
      secrets.bookings[key.publicKey.toBase58()] = [...key.secretKey]; key.secretKey.fill(0);
    }
    await store.save(account, secrets, undefined, signal);
    return account;
  } finally { secrets.owner.fill(0); secrets.lane?.fill(0); Object.values(secrets.bookings).forEach(value => value.fill(0)); }
}

export async function importWallet(store: Store, apiUrl: string, key: string) {
  apiUrl = safeUrl(apiUrl);
  const cfg = await config(apiUrl), owner = await parseKey(key);
  let lane: Keypair | undefined;
  try {
    lane = await child(owner, cfg, "lane"); const wallet = owner.publicKey.toBase58();
    const proof = await api<{ challenge: string; message: string }>(apiUrl, "/opencode/challenge", { body: { wallet, lane: lane.publicKey.toBase58() } });
    if (proof.message !== `fossa-opencode-connect-v1:${cfg.programId}:${cfg.market}:${wallet}:${lane.publicKey.toBase58()}:${proof.challenge}`) throw new FossaError("INVALID_PROOF", "Fossa returned an invalid wallet ownership challenge.");
    const connected = await api<Identity>(apiUrl, "/opencode/connect", { body: { challenge: proof.challenge, signature: signMessage(Buffer.from(proof.message), owner.secretKey).toString("base64") } });
    return await install(store, apiUrl, cfg, connected, owner, lane);
  } finally { owner.secretKey.fill(0); lane?.secretKey.fill(0); }
}

export async function quickConnect(store: Store, apiUrl: string) {
  apiUrl = safeUrl(apiUrl); const cfg = await config(apiUrl);
  const wrapping = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const wrappingKey = wrapping.publicKey.export({ type: "spki", format: "der" });
  const adjectives = ["Amber", "Cedar", "Coral", "Lunar", "Maple", "Silver"], animals = ["Fox", "Otter", "Owl", "Panda", "Robin", "Wren"];
  const label = `${adjectives[randomInt(adjectives.length)]} ${animals[randomInt(animals.length)]} ${randomInt(100, 1000)}`;
  const device = await api<Device>(apiUrl, "/opencode/device", { body: { wrappingKey: wrappingKey.toString("base64"), label } });
  const url = new URL(device.url), website = new URL(safeUrl(cfg.opencode.siteUrl, "website"));
  if (url.origin !== website.origin || url.pathname !== "/opencode" || url.searchParams.get("device") !== device.id) throw new FossaError("CONFIGURATION", "Fossa returned an invalid approval link.");
  const controller = new AbortController();
  let settled = false, polling = false, resolve!: (account: Account) => void, reject!: (error: Error) => void;
  const completed = new Promise<Account>((ok, fail) => { resolve = ok; reject = fail; }); void completed.catch(() => {});
  const poll = async () => {
    if (settled || polling) return; polling = true;
    let owner: Keypair | undefined, lane: Keypair | undefined;
    try {
      const delivery = await api<Delivery>(apiUrl, `/opencode/device/${device.id}/poll`, { token: device.pollToken, signal: controller.signal });
      if (delivery.pending || settled) return;
      const bytes = privateDecrypt({ key: wrapping.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(delivery.sealedKey, "base64"));
      try { owner = await Keypair.fromSecretKey(Uint8Array.from(bytes)); } finally { bytes.fill(0); }
      const laneBytes = privateDecrypt({ key: wrapping.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(delivery.sealedLaneKey, "base64"));
      try { lane = await Keypair.fromSecretKey(Uint8Array.from(laneBytes)); } finally { laneBytes.fill(0); }
      const account = await install(store, apiUrl, cfg, delivery, owner, lane, true, controller.signal);
      if (!settled) { settled = true; resolve(account); }
    } catch (error) {
      if (!settled && !(error instanceof FossaError && ["FOSSA_OFFLINE", "FOSSA_TIMEOUT"].includes(error.code))) { settled = true; reject(error instanceof Error ? error : new Error("Fossa approval failed.")); }
    } finally { owner?.secretKey.fill(0); lane?.secretKey.fill(0); polling = false; }
  };
  const timer = setInterval(() => void poll(), cfg.opencode.pollIntervalMs);
  const timeout = setTimeout(() => { if (!settled) { settled = true; reject(new FossaError("SETUP_EXPIRED", "Connection expired. Start Fossa login again.")); } stop(); }, Math.max(0, device.expires - Date.now()));
  const stop = () => { clearInterval(timer); clearTimeout(timeout); controller.abort(); if (!settled) { settled = true; reject(new FossaError("SETUP_CANCELLED", "Fossa connection was cancelled.")); } };
  void completed.then(stop, stop); void poll();
  return { url: url.toString(), expires: device.expires, label, code: device.code, fingerprint: createHash("sha256").update(wrappingKey).digest("hex"), completed, stop };
}
