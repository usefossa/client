import { expect, test } from "bun:test";
import { bookingPending, providerError } from "../src/provider-response";

test("structured and legacy booking errors retry only before acceptance", () => {
  for (const value of [{ error: "Booking unavailable" }, { error: { message: "Booking unavailable", code: "booking_unavailable" } }, { error: { message: "Synchronizing", code: "booking_generation_changed" } }]) {
    expect(bookingPending(401, providerError(value))).toBe(true);
    expect(bookingPending(409, providerError(value))).toBe(false);
    expect(bookingPending(502, providerError(value))).toBe(false);
  }
  expect(bookingPending(401, providerError({ error: { message: "Invalid signature", code: "invalid_booking" } }))).toBe(false);
  expect(providerError(null).message).toBe("Provider request failed.");
});
