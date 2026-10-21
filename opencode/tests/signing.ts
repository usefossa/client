import { createPublicKey, verify } from "node:crypto";

export function verifyMessage(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array) {
  return verify(null, message, createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKey).toString("base64url") }, format: "jwk" }), signature);
}
