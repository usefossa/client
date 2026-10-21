import { expect, test } from "bun:test";
import { validateBody, inputBound } from "../src/protocol";
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
