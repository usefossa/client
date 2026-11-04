export function providerError(value: unknown, fallback = "Provider request failed."): { message: string; code?: string } {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const error = body.error && typeof body.error === "object" ? body.error as Record<string, unknown> : {};
  return { message: typeof error.message === "string" ? error.message : typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : fallback, code: typeof error.code === "string" ? error.code : typeof body.code === "string" ? body.code : undefined };
}

export function bookingPending(status: number, error: ReturnType<typeof providerError>) {
  return status === 401 && (["booking_unavailable", "booking_generation_changed", "protocol_account_unavailable"].includes(error.code ?? "") || ["Booking unavailable", "Booking generation changed", "Protocol account unavailable"].includes(error.message));
}

export async function readProviderFailure(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader?.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (reader) {
      signal.throwIfAborted();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const { done, value } = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("Provider error response timed out.")), 10_000); })]).finally(() => clearTimeout(timer));
      signal.throwIfAborted(); if (done) break;
      size += value.byteLength; if (size > 65_536) throw Error("Provider error response exceeds the byte limit.");
      chunks.push(value);
    }
    const body = Buffer.concat(chunks).toString();
    let parsed: unknown; try { parsed = JSON.parse(body); } catch { /* retain non-json status feedback. */ }
    const headers = new Headers(response.headers);
    for (const name of ["content-length", "content-encoding", "transfer-encoding"]) headers.delete(name);
    return { response: new Response(body, { status: response.status, statusText: response.statusText, headers }), error: providerError(parsed) };
  } finally { signal.removeEventListener("abort", abort); void reader?.cancel().catch(() => {}); reader?.releaseLock(); }
}
