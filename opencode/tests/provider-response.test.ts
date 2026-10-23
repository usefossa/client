import { expect, test } from "bun:test";
import { bookingPending, providerError, readProviderFailure } from "../src/provider-response";

test("structured and legacy booking errors retry only before acceptance", () => {
  for (const value of [{ error: "Booking unavailable" }, { error: { message: "Booking unavailable", code: "booking_unavailable" } }, { error: { message: "Synchronizing", code: "booking_generation_changed" } }]) {
    expect(bookingPending(401, providerError(value))).toBe(true);
    expect(bookingPending(409, providerError(value))).toBe(false);
    expect(bookingPending(502, providerError(value))).toBe(false);
  }
  expect(bookingPending(401, providerError({ error: { message: "Invalid signature", code: "invalid_booking" } }))).toBe(false);
  expect(providerError(null).message).toBe("Provider request failed.");
});

test("bounded provider errors preserve status and feedback without stale wire headers", async () => {
  for (const status of [401, 429, 500]) {
    const body = JSON.stringify({ error: { message: "Try later", code: "unavailable" } });
    const result = await readProviderFailure(new Response(body, { status, headers: { "content-type": "application/json", "content-length": "999", "content-encoding": "gzip", "transfer-encoding": "chunked", "retry-after": "5" } }), new AbortController().signal);
    expect(result.error).toEqual({ message: "Try later", code: "unavailable" }); expect(result.response.status).toBe(status); expect(await result.response.text()).toBe(body);
    for (const name of ["content-length", "content-encoding", "transfer-encoding"]) expect(result.response.headers.has(name)).toBe(false);
    expect(result.response.headers.get("retry-after")).toBe("5");
  }
});

test("provider error bounds and abort do not wait for upstream cancellation", async () => {
  let cancelled = 0;
  const stream = (bytes = 0) => new ReadableStream<Uint8Array>({ start(controller) { if (bytes) controller.enqueue(new Uint8Array(bytes)); }, cancel() { cancelled++; return new Promise(() => {}); } });
  await expect(readProviderFailure(new Response(stream(65_537), { status: 500 }), new AbortController().signal)).rejects.toThrow("byte limit");
  const controller = new AbortController(), pending = readProviderFailure(new Response(stream(), { status: 429 }), controller.signal);
  controller.abort(Error("cancelled")); await expect(pending).rejects.toThrow("cancelled"); expect(cancelled).toBe(2);
});
