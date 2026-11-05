import { lookup } from "node:dns";
import { BlockList, isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
// the package alias bypasses bun's built-in undici stub, which ignores custom dns.
import { Agent, type Dispatcher } from "undici-client";
import { FossaError } from "../types";

const blocked = new BlockList(), globalV6 = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]] as const) blocked.addSubnet(address, prefix, "ipv4");
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) blocked.addSubnet(address, prefix, "ipv6");
export function publicProviderAddress(address: string) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, "ipv4") : family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}
const denied = () => new FossaError("PROVIDER_ENDPOINT", "Provider endpoint must use a public HTTPS address.");
export function providerLookup(resolve = lookup): LookupFunction {
  return (hostname, options, callback) => resolve(hostname, { all: true, family: options.family }, (error, addresses) => {
    if (error) { callback(error, "", 0); return; }
    if (!addresses.length || addresses.some(entry => !publicProviderAddress(entry.address))) { callback(denied(), "", 0); return; }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}
export const providerDispatcher = (resolve = lookup) => new Agent({ connect: { lookup: providerLookup(resolve), timeout: 15_000 }, maxHeaderSize: 32 * 1024 });
const dispatcher = providerDispatcher();

export async function providerFetch(request: Request, apiUrl: string, transport: Dispatcher = dispatcher) {
  const url = new URL(request.url);
  // explicitly configured api origins retain their existing self-hosted access.
  if (url.origin === new URL(apiUrl).origin) return fetch(new Request(request, { redirect: "error" }));
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || url.username || url.password || url.hash || isIP(hostname) && !publicProviderAddress(hostname)) throw denied();
  const response = await transport.request({ origin: url.origin, path: url.pathname + url.search, method: request.method as Dispatcher.HttpMethod, headers: { ...Object.fromEntries(request.headers), "accept-encoding": "gzip, deflate, br" }, body: await request.text(), signal: request.signal, maxRedirections: 0, headersTimeout: 60_000, bodyTimeout: 120_000 });
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) for (const field of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, field);
  const encoding = headers.get("content-encoding")?.trim().toLowerCase();
  const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate() : encoding === "br" ? createBrotliDecompress() : undefined;
  if (encoding && encoding !== "identity" && !decoder) { response.body.destroy(); throw new FossaError("PROVIDER_RESPONSE", "Provider returned an unsupported content encoding."); }
  const stream = decoder ? response.body.pipe(decoder) : response.body;
  if (decoder) response.body.on("error", error => decoder.destroy(error));
  const iterator = stream[Symbol.asyncIterator]();
  const cancel = () => { stream.destroy(); response.body.destroy(); };
  const body = new ReadableStream<Uint8Array>({ async pull(controller) {
    try { const value = await iterator.next(); if (value.done) controller.close(); else controller.enqueue(value.value); }
    catch (error) { cancel(); controller.error(error); }
  }, cancel });
  for (const name of ["content-length", "content-encoding", "transfer-encoding"]) headers.delete(name);
  if ([204, 205, 304].includes(response.statusCode)) { cancel(); return new Response(null, { status: response.statusCode, headers }); }
  return new Response(body, { status: response.statusCode, headers });
}
