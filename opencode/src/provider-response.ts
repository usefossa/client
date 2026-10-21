export function providerError(value: unknown, fallback = "Provider request failed."): { message: string; code?: string } {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const error = body.error && typeof body.error === "object" ? body.error as Record<string, unknown> : {};
  return { message: typeof error.message === "string" ? error.message : typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : fallback, code: typeof error.code === "string" ? error.code : typeof body.code === "string" ? body.code : undefined };
}

export function bookingPending(status: number, error: ReturnType<typeof providerError>) {
  return status === 401 && (["booking_unavailable", "booking_generation_changed", "protocol_account_unavailable"].includes(error.code ?? "") || ["Booking unavailable", "Booking generation changed", "Protocol account unavailable"].includes(error.message));
}
