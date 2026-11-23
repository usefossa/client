import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { exactTextCount } from "../src/inference/text-counter";

const bytes = readFileSync(new URL("./fixtures/text-counter.json", import.meta.url));
const ref = { format: "huggingface-chat-v1", url: "https://assets.example.org/counter.json", sha256: createHash("sha256").update(bytes).digest("hex") };

test("verified local tokenizer counts the complete prompt and shares concurrent downloads", async () => {
  let reads = 0;
  const download = async (request: Request) => {
    reads++;
    expect(request.method).toBe("GET");
    expect(request.body).toBeNull();
    expect(request.headers.has("authorization")).toBe(false);
    return new Response(bytes);
  };
  const checks = JSON.parse(bytes.toString()).checks;
  const counts = await Promise.all(checks.map((body: unknown) => exactTextCount(ref, body, undefined, download)));
  expect(counts).toEqual(checks.map((c: {tokens: number}) => c.tokens));
  expect(reads).toBe(1);
  expect(await exactTextCount({ ...ref, sha256: "a".repeat(64) }, checks[0], undefined, download)).toBeUndefined();
  expect(await exactTextCount(undefined, checks[0], undefined, download)).toBeUndefined();
});

test("cancelling during a shared download leaves the other chat usable", async () => {
  const bundle = Buffer.concat([bytes, Buffer.from("\n")]);
  const reference = { ...ref, sha256: createHash("sha256").update(bundle).digest("hex") };
  const { promise, resolve } = Promise.withResolvers<Response>();
  const controller = new AbortController();
  const body = JSON.parse(bytes.toString()).checks[0];
  const cancelled = exactTextCount(reference, body, controller.signal, () => promise);
  const other = exactTextCount(reference, body, undefined, () => promise);
  controller.abort(new Error("chat cancelled"));
  await expect(cancelled).rejects.toThrow("chat cancelled");
  resolve(new Response(bundle));
  expect(await other).toBe(body.tokens);
});
