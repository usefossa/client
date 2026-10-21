import { expect, test } from "bun:test";
import { Connection, PublicKey } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "../src/token";

const mint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const owner = new PublicKey("GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB");

test("token account address and instruction match SPL Token reference vector", async () => {
  const address = await getAssociatedTokenAddress(mint, owner);
  expect(address.toString()).toBe("7woc3ajaGMMXczFYjxon4aQoHH3j126fMUR9c58eHRsK");
  const instruction = createAssociatedTokenAccountIdempotentInstruction(owner, address, owner, mint);
  expect(instruction.programId.toString()).toBe("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  expect(Buffer.from(instruction.data).toString("hex")).toBe("01");
  expect(instruction.keys.map(key => [key.pubkey.toString(), key.isSigner, key.isWritable])).toEqual([
    [owner.toString(), true, true], [address.toString(), false, true], [owner.toString(), false, false],
    [mint.toString(), false, false], ["11111111111111111111111111111111", false, false], [TOKEN_PROGRAM_ID.toString(), false, false],
  ]);
});

test("program-owned token account requires explicit off-curve permission", async () => {
  const authority = new PublicKey("AispKP3Ls5d2m6t411kMtP1xkPemdZPGPJUvemsBqmXA");
  expect(async () => await getAssociatedTokenAddress(mint, authority)).toThrow("off curve");
  expect((await getAssociatedTokenAddress(mint, authority, true)).toString()).toBe("6fQcUCMPgjKE6STVFXsyRXH98B3At9cg8468wozEUjtF");
});

test("web3 JSON-RPC transport works with native fetch", async () => {
  const rpc = new Connection("http://127.0.0.1:8899", {
    commitment: "confirmed",
    fetch: Object.assign(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = JSON.parse(String(init?.body));
      expect(request.method).toBe("getBalance");
      expect(request.params[0]).toBe(owner.toString());
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { context: { slot: 1 }, value: 42 } }));
    }, { preconnect: fetch.preconnect }),
  });
  expect(BigInt(await rpc.getBalance(owner))).toBe(42n);
});
