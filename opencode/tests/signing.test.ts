import { expect, test } from "bun:test";
import { signMessage } from "../src/signing";
import { verifyMessage } from "./signing";

// rfc 8032, section 7.1, test 1: public test material only.
test("native signing matches the Ed25519 reference vector and binds exact bytes", () => {
  const seed = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex");
  const publicKey = Buffer.from("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "hex");
  const signature = signMessage(Buffer.alloc(0), seed);
  expect(signature.toString("hex")).toBe("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");
  expect(signMessage(Buffer.alloc(0), Buffer.concat([seed, publicKey]))).toEqual(signature);
  expect(verifyMessage(Buffer.alloc(0), signature, publicKey)).toBe(true);
  expect(verifyMessage(Buffer.from("changed"), signature, publicKey)).toBe(false);
  expect(seed.toString("hex")).toBe("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
  expect(() => signMessage(Buffer.alloc(0), Buffer.alloc(31))).toThrow("Invalid Ed25519");
});
