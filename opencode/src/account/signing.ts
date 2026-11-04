import { createPrivateKey, sign } from "node:crypto";

export function signMessage(message: Uint8Array, secret: Uint8Array) {
  if (secret.length !== 32 && secret.length !== 64) throw Error("Invalid Ed25519 signing key");
  const der = Buffer.alloc(48);
  Buffer.from("302e020100300506032b657004220420", "hex").copy(der);
  der.set(secret.subarray(0, 32), 16);
  try { return sign(null, message, createPrivateKey({ key: der, format: "der", type: "pkcs8" })); }
  finally { der.fill(0); }
}
