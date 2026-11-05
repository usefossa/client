import { FossaError, type Account, type PublicConfig } from "./types";
import { providerError } from "./inference/provider-response";

export const DEFAULT_API_URL = "https://api.fossa.ag";

export function safeUrl(value: unknown, label = "endpoint") {
  if (typeof value !== "string") throw new FossaError("CONFIGURATION", `Set the Fossa ${label} before loading the plugin.`);
  const url = new URL(value);
  if (url.username || url.password || !["https:", "http:"].includes(url.protocol) || url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new FossaError("CONFIGURATION", `Use HTTPS for the Fossa ${label}; HTTP is allowed only on localhost.`);
  return url.toString().replace(/\/$/, "");
}

export async function api<T>(base: string, path: string, options: { token?: string; body?: unknown; signal?: AbortSignal; method?: string } = {}): Promise<T> {
  const headers = new Headers({ accept: "application/json" });
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  let response: Response;
  try {
    response = await fetch(`${base}/v1${path}`, { method: options.method ?? (options.body === undefined ? "GET" : "POST"), headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000), redirect: "error" });
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof Error && error.name === "TimeoutError") throw new FossaError("FOSSA_TIMEOUT", "Fossa backend took too long to respond. Check the server or your connection.");
    throw new FossaError("FOSSA_OFFLINE", `Cannot reach Fossa at ${new URL(base).origin}. Check your connection and API endpoint.`);
  }
  const value = await readJson(response);
  if (!response.ok) throw new FossaError(response.status === 401 ? "AUTH_EXPIRED" : "FOSSA_API", providerError(value, `Fossa API returned ${response.status}.`).message);
  return value as T;
}
export async function config(base: string, signal?: AbortSignal) {
  const value = await api<PublicConfig>(base, "/config", { signal });
  if (!value?.programId || !value.market || !value.providerList || !value.usdcMint || !value.opencode || !Number.isSafeInteger(value.opencode.maxInputTokens)) throw new FossaError("CONFIGURATION", "Fossa API does not support this plugin version.");
  safeUrl(value.opencode.siteUrl, "website"); return value;
}
export async function refreshAccount(account: Account) {
  const value = await api<Pick<Account, "access" | "refresh" | "expires">>(account.apiUrl, "/opencode/refresh", { method: "POST", token: account.refresh });
  if (!value || typeof value.access !== "string" || !value.access || typeof value.refresh !== "string" || !value.refresh || !Number.isSafeInteger(value.expires) || value.expires <= 0) throw new FossaError("AUTH_INVALID", "Fossa returned invalid refreshed credentials.");
  return { ...account, access: value.access, refresh: value.refresh, expires: value.expires };
}

export async function readJson(response: Response, limit = 32 * 1024 * 1024): Promise<unknown> {
  const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (Number(response.headers.get("content-length")) > limit) throw new FossaError("RESPONSE_TOO_LARGE", "Fossa API response exceeds the byte limit.");
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new FossaError("RESPONSE_TOO_LARGE", "Fossa API response exceeds the byte limit.");
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return null; }
  } finally { void reader?.cancel().catch(() => {}); reader?.releaseLock(); }
}
