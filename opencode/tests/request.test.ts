import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import imageCases from "./fixtures/image-token-cases.json";
import { estimateInput, measureInput, validateBody, inputBound } from "../src/protocol";
import { make } from "@opencode/ai/promise";
import { configure } from "@opencode/ai/providers/openai-compatible";

const config = { model: "test-coder", speed_tps: 100, context_tokens: 65536, output_tokens: 8192, tools: true };
const booking = { maxInput: 65536, maxOutput: 1024, claimEnd: Date.now() / 1000 + 300 };
test("standard optional values and tool content preserve the booked allowance", () => {
  const body = { model: config.model, n: 1, logprobs: false, stream: null, temperature: null, top_p: null, stop: null, store: null, seed: null, reasoning_effort: null, tools: [{ type: "function", function: { name: "noop" } }], messages: [{ role: "assistant", content: null, refusal: null, tool_calls: [{ id: "one", type: "function", function: { name: "noop", arguments: "{}" } }] }, { role: "tool", tool_call_id: "one", content: [{ type: "text", text: "done" }] }] };
  expect(validateBody(body, booking, config)).toBe(1024);
  for (const patch of [{ n: 2 }, { logprobs: true }, { temperature: -0.1 }, { top_p: 1.01 }, { stream_options: { include_usage: true } }]) expect(() => validateBody({ ...body, ...patch }, booking, config)).toThrow();
});
test("website text requests retain their existing token bound", () => {
  const body = { model: config.model, messages: [{ role: "user", content: "hello" }], max_tokens: 128, stream: true };
  expect(inputBound(body)).toBe(Buffer.byteLength(JSON.stringify(body.messages)) + 512);
  expect(validateBody(body, { ...booking, maxInput: inputBound(body) }, config)).toBe(128);
});
const fixture = readFileSync(new URL("./fixtures/image.png", import.meta.url));

test("checkpoint reservations cover each image and exclude only its transport bytes", () => {
  const url = `data:image/png;base64,${fixture.toString("base64")}`;
  const part = { type: "image_url", image_url: { url } };
  const messages = [{ role: "user", content: [{ type: "text", text: url }, part, part] }];
  const body = { model: config.model, messages, max_tokens: 128 };
  const bytes = Buffer.byteLength(JSON.stringify(messages));
  for (const [id, tokens] of imageCases) {
    const checkpoint = createHash("sha256").update(String(id)).digest("hex");
    const model = { ...config, checkpoint, input: ["text", "image"] };
    const expected = bytes - 2 * url.length + 512 + 2 * Number(tokens);
    const measurement = measureInput(body, checkpoint);
    expect(measurement.bound).toBe(expected);
    expect(estimateInput(bytes, measurement)).toBe(Math.ceil((bytes - 2 * url.length) / 4) + 2 * Number(tokens));
    expect(validateBody(body, { ...booking, maxInput: expected }, model)).toBe(128);
    expect(() => validateBody(body, { ...booking, maxInput: expected - 1 }, model)).toThrow("Input limit");
  }
});

test("deepseek screenshot fits at its published image ceiling regardless of compression", () => {
  const checkpoint = createHash("sha256").update("deepseek-ai/DeepSeek-V4.1-Flash-1017").digest("hex");
  const bounds = ["screenshot.png", "screenshot-small.png"].map(file => {
    const image = readFileSync(new URL(`./fixtures/${file}`, import.meta.url)).toString("base64");
    return inputBound({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${image}` } }] }] }, checkpoint);
  });
  expect(bounds[0]).toBe(bounds[1]);
  expect(bounds[0]).toBeLessThan(1700);
});
test("image read fits the model context with a conservative pixel allowance", () => {
  const image = readFileSync(new URL("./fixtures/image.png", import.meta.url)).toString("base64");
  const body = { model: config.model, max_tokens: 393216, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${image}` } }] }] };
  const bound = inputBound(body), model = { ...config, context_tokens: 1048576, output_tokens: 393216, input: ["image"] };
  expect(bound).toBe(Buffer.byteLength(JSON.stringify(body.messages)) + 512 + 512 * 256 * 2);
  expect(bound + body.max_tokens).toBeLessThanOrEqual(model.context_tokens);
  expect(validateBody(body, { maxInput: bound, maxOutput: body.max_tokens, claimEnd: Date.now() / 1000 + 5000 }, model)).toBe(body.max_tokens);
  expect(() => validateBody(body, { maxInput: bound - 1, maxOutput: body.max_tokens, claimEnd: Date.now() / 1000 + 5000 }, model)).toThrow("Input limit");
});
test("coding continuation accepts reasoning, tool calls, and matching tool results", () => {
  const body = { model: config.model, max_tokens: 1024, stream: true, tools: [{ type: "function", function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } } }], messages: [{ role: "user", content: "read a file" }, { role: "assistant", content: null, reasoning_content: "inspect first", tool_calls: [{ id: "call-one", type: "function", function: { name: "read", arguments: '{"path":"main.ts"}' } }] }, { role: "tool", tool_call_id: "call-one", content: "export const value = 1;" }] };
  expect(validateBody(body, booking, config)).toBe(1024);
  expect(() => validateBody({ ...body, messages: [{ role: "tool", tool_call_id: "unmatched", content: "result" }] }, booking, config)).toThrow("matching tool call");
  expect(() => validateBody(body, { ...booking, maxInput: inputBound(body) - 1 }, config)).toThrow("Input limit");
  expect(() => validateBody(body, { ...booking, maxOutput: 100 }, config)).toThrow("Output limit");
});
test("unsupported attachments and unknown request fields fail before acceptance", () => {
  expect(() => validateBody({ model: config.model, max_tokens: 1, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "http://example.invalid" } }] }] }, booking, config)).toThrow("does not support images");
  expect(() => validateBody({ model: config.model, messages: [{ role: "user", content: "hello" }], unexpected: true }, booking, config)).toThrow("Unsupported");
  expect(() => validateBody({ model: config.model, messages: [{ role: "user", content: "hello" }], store: true }, booking, config)).toThrow("Request storage");
});

for (const maxOutput of [32768, 131072, 393216]) test(`long output ${maxOutput} requires sufficient reserved tokens and payment time`, () => {
  const body = { model: config.model, max_tokens: maxOutput, messages: [{ role: "user", content: "Write a detailed implementation." }] };
  const model = { ...config, context_tokens: 1048576, output_tokens: maxOutput };
  const funded = { maxInput: inputBound(body), maxOutput, claimEnd: Date.now() / 1000 + 300 + Math.ceil(maxOutput / model.speed_tps) };
  expect(validateBody(body, funded, model)).toBe(maxOutput);
  expect(() => validateBody(body, { ...funded, claimEnd: Date.now() / 1000 + 300 }, model)).toThrow("deadline");
  expect(() => validateBody(body, { ...funded, maxOutput: maxOutput - 1 }, model)).toThrow("Output limit");
});

test("OpenCode's real chat encoder passes Fossa validation and decodes streamed text", async () => {
  let received: Record<string, unknown> | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    received = await request.json() as Record<string, unknown>;
    try { validateBody(received, booking, config); }
    catch (error) { return Response.json({ error: { message: String(error) } }, { status: 400 }); }
    const chunk = { id: "fixture", object: "chat.completion.chunk", created: 1, model: config.model, choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const ai = make();
  try {
    const response = await ai.llm.generate({ model: configure({ provider: "fossa", apiKey: "fixture", baseURL: `${server.url.origin}/v1` }).model(config.model), prompt: "Hello", generation: { maxTokens: 128 } });
    expect(received?.store).toBe(false);
    expect(response.text).toBe("Hello");
  } finally { await ai.dispose(); server.stop(true); }
});

test("text bounds never clamp away oversized input and combined context stays bounded", () => {
  const body = { model: config.model, max_tokens: 1024, messages: [{ role: "user", content: "a".repeat(2048) }] };
  expect(inputBound(body)).toBeGreaterThan(2048);
  expect(() => validateBody(body, { ...booking, maxInput: 1024 }, { ...config, context_tokens: 1024 })).toThrow("Input limit");
  const bound = inputBound(body);
  expect(() => validateBody(body, { ...booking, maxInput: bound }, { ...config, context_tokens: bound + 1023 })).toThrow("Context limit");
});
