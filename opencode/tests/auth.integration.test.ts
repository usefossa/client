import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, Keypair } from "@solana/web3.js";
import { signMessage } from "../src/signing";
import { verifyMessage } from "./signing";
import bs58 from "bs58";
import { generateKeyPairSync, privateDecrypt, constants, createHash } from "node:crypto";
import { Store } from "../src/store";
import { importWallet, quickConnect } from "../src/auth";
import { api } from "../src/api";

const base = process.env.FOSSA_TEST_API_URL ?? "", origin = process.env.FOSSA_TEST_ORIGIN ?? "http://127.0.0.1:3000";
const integrationTest = test.skipIf(!base);
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach(action => action()));
async function web(path: string, body?: unknown, cookie?: string, csrf?: string) {
  const response = await fetch(`${base}/v1${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin, ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}), ...(csrf ? { "x-csrf-token": csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json(); return { response, value };
}

integrationTest("native key import sends ownership proof and encrypts without a passphrase", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fossa-auth-test-")), store = new Store(directory), owner = await Keypair.generate();
  cleanup.push(() => { store.close(); owner.secretKey.fill(0); rmSync(directory, { recursive: true, force: true }); });
  const account = await importWallet(store, base, bs58.encode(owner.secretKey));
  expect(account.wallet).toBe(owner.publicKey.toString()); expect(store.unlocked(account.walletId)).toBe(true);
  const snapshot = await api<{ wallet: string; usdcAtomic: string }>(base, "/opencode/wallet", { token: account.access });
  expect(snapshot.wallet).toBe(account.wallet); expect(snapshot.usdcAtomic).toBe("0");
  const rpc = new Connection(`${base}/v1/opencode/rpc`, { httpHeaders: { authorization: `Bearer ${account.access}` } });
  expect(String(await rpc.getGenesisHash())).toBe("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
  expect(BigInt(await rpc.getBalance(owner.publicKey))).toBe(0n);
  store.lock(account.walletId);
  await store.autoUnlock(account.walletId); expect(store.unlocked(account.walletId)).toBe(true);
  await store.protect(account, "abc"); store.lock();
  await importWallet(store, base, bs58.encode(owner.secretKey));
  expect(store.security(account.walletId)).toEqual({ protected: true, unlocked: false });
  await store.unlock(account.walletId, "abc");
}, 20_000);

integrationTest("website quick connect installs an automatically encrypted wallet without a passphrase", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fossa-quick-test-")), store = new Store(directory), login = await Keypair.generate();
  const setup = await quickConnect(store, base), id = new URL(setup.url).searchParams.get("device")!;
  cleanup.push(() => { setup.stop(); store.close(); login.secretKey.fill(0); rmSync(directory, { recursive: true, force: true }); });
  const challenge = await web("/auth/challenge", { chain: "solana", address: login.publicKey.toString(), purpose: "login" });
  const flow = challenge.response.headers.get("set-cookie")!.split(";")[0];
  const verified = await web("/auth/verify", { id: challenge.value.id, signature: bs58.encode(signMessage(Buffer.from(challenge.value.message), login.secretKey)) }, flow);
  const cookie = verified.response.headers.getSetCookie().find(value => value.startsWith("fossa_session="))!.split(";")[0], csrf = verified.value.csrfToken;
  const approval = await web("/auth/challenge", { chain: "solana", address: login.publicKey.toString(), purpose: "opencode", resource: setup.fingerprint }, cookie, csrf);
  const signed = await web("/auth/verify", { id: approval.value.id, signature: bs58.encode(signMessage(Buffer.from(approval.value.message), login.secretKey)) }, cookie, csrf);
  expect((await web(`/opencode/device/${id}/approve`, { authorization: signed.value.authorization }, cookie, csrf)).response.status).toBe(200);
  const account = await setup.completed;
  expect(new URL(setup.url).pathname).toBe("/opencode");
  expect(store.security(account.walletId)).toEqual({ protected: false, unlocked: true });
  store.lock(); await store.autoUnlock(account.walletId);
  const owner = await Keypair.fromSecretKey(Uint8Array.from(store.secrets(account.walletId).owner));
  expect(owner.publicKey.toString()).toBe(account.wallet);
  owner.secretKey.fill(0); await web("/auth/logout", {}, cookie, csrf);
}, 20_000);

integrationTest("website quick approval binds wrapping key, seals key, and allows only one polling delivery", async () => {
  const login = await Keypair.generate(), wrapping = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const spki = wrapping.publicKey.export({ type: "spki", format: "der" }), fingerprint = createHash("sha256").update(spki).digest("hex");
  const device = await api<{ id: string; pollToken: string }>(base, "/opencode/device", { body: { wrappingKey: spki.toString("base64"), label: "Disposable quick-connect test" } });
  const challenge = await web("/auth/challenge", { chain: "solana", address: login.publicKey.toString(), purpose: "login" });
  const flow = challenge.response.headers.get("set-cookie")!.split(";")[0];
  const verified = await web("/auth/verify", { id: challenge.value.id, signature: bs58.encode(signMessage(Buffer.from(challenge.value.message), login.secretKey)) }, flow);
  expect(verified.response.status).toBe(200);
  const cookie = verified.response.headers.getSetCookie().find(value => value.startsWith("fossa_session="))!.split(";")[0], csrf = verified.value.csrfToken;
  const approval = await web("/auth/challenge", { chain: "solana", address: login.publicKey.toString(), purpose: "opencode", resource: fingerprint }, cookie, csrf);
  expect(approval.response.status).toBe(200);
  const signed = await web("/auth/verify", { id: approval.value.id, signature: bs58.encode(signMessage(Buffer.from(approval.value.message), login.secretKey)) }, cookie, csrf);
  const approved = await web(`/opencode/device/${device.id}/approve`, { authorization: signed.value.authorization }, cookie, csrf);
  expect(approved.response.status).toBe(200);
  const polled = await api<{ sealedKey: string; sealedLaneKey: string; wallet: string; lane: string; access: string }>(base, `/opencode/device/${device.id}/poll`, { token: device.pollToken });
  const bytes = privateDecrypt({ key: wrapping.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(polled.sealedKey, "base64"));
  const owner = await Keypair.fromSecretKey(Uint8Array.from(bytes)); bytes.fill(0);
  expect(owner.publicKey.toString()).toBe(polled.wallet);
  const laneBytes = privateDecrypt({ key: wrapping.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(polled.sealedLaneKey, "base64"));
  const lane = await Keypair.fromSecretKey(Uint8Array.from(laneBytes)); laneBytes.fill(0); expect(lane.publicKey.toString()).toBe(polled.lane); lane.secretKey.fill(0);
  const message = Buffer.from("quick connect ownership verified"); expect(verifyMessage(message, signMessage(message, owner.secretKey), owner.publicKey.toBytes())).toBe(true);
  await expect(api(base, `/opencode/device/${device.id}/poll`, { token: device.pollToken })).rejects.toThrow();
  const rpc = await fetch(base + "/v1/opencode/rpc", { method: "POST", headers: { authorization: `Bearer ${polled.access}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: ["not-a-signed-transaction", { encoding: "base64" }] }) });
  expect(rpc.status).toBe(400);
  await web("/auth/logout", {}, cookie, csrf); owner.secretKey.fill(0); login.secretKey.fill(0);
}, 20_000);
