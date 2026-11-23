type Reference = { format: string; url: string; sha256: string };
type Pending = { finish: (count?: number) => void };
const maxBytes = 32 * 1024 * 1024;
const counters = new Map<string, Counter>();
type Counter = {
  worker: Worker;
  download: AbortController;
  ready: Promise<ArrayBuffer | undefined>;
  pending: Map<number, Pending>;
  idle?: ReturnType<typeof setTimeout>;
};
let sequence = 0;

async function download(ref: Reference, signal: AbortSignal, fetcher: (request: Request) => Promise<Response>) {
  const url = new URL(ref.url);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash ||
      !url.hostname.includes(".") || /^[\d.]+$/.test(url.hostname) || url.hostname.endsWith(".local") || url.hostname.endsWith(".localhost")) throw Error("Invalid tokenizer URL");
  const response = await fetcher(new Request(url, { credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]) }));
  const reader = response.body?.getReader();
  if (!reader || !response.ok) { await reader?.cancel(); throw Error("Tokenizer unavailable"); }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw Error("Tokenizer is too large");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  if (Array.from(hash, n => n.toString(16).padStart(2, "0")).join("") !== ref.sha256) throw Error("Tokenizer digest mismatch");
  return bytes.buffer;
}

function close(hash: string, counter: Counter) {
  if (counters.get(hash) === counter) counters.delete(hash);
  clearTimeout(counter.idle);
  counter.download.abort();
  counter.worker.terminate();
  for (const { finish } of counter.pending.values()) finish();
  counter.pending.clear();
}

function waitForDownload(ready: Counter["ready"], signal?: AbortSignal) {
  if (!signal) return ready;
  signal.throwIfAborted();
  return new Promise<ArrayBuffer | undefined>((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    ready.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

export async function exactTextCount(ref: Reference | null | undefined, body: unknown, signal?: AbortSignal, fetcher = (request: Request) => fetch(request)): Promise<number | undefined> {
  signal?.throwIfAborted();
  if (ref?.format !== "huggingface-chat-v1" || !/^[a-f0-9]{64}$/.test(ref.sha256)) return;
  let counter = counters.get(ref.sha256);
  try {
    if (!counter) {
      if (counters.size >= 2) { const [key, old] = counters.entries().next().value!; close(key, old); }
      const worker = new Worker(new URL("./text-counter.worker.ts", import.meta.url), { type: "module" });
      const controller = new AbortController();
      const entry: Counter = { worker, download: controller, ready: download(ref, controller.signal, fetcher), pending: new Map() };
      worker.onmessage = event => entry.pending.get(event.data.id)?.finish(event.data.tokens);
      worker.onerror = () => close(ref.sha256, entry);
      counter = entry;
      counters.set(ref.sha256, entry);
    }
    const entry = counter;
    clearTimeout(entry.idle);
    entry.idle = undefined;
    const bytes = await waitForDownload(entry.ready, signal);
    signal?.throwIfAborted();
    if (counters.get(ref.sha256) !== entry) return;
    // only the first message initializes the worker, even when downloads coalesce.
    const first = bytes && bytes.byteLength > 0;
    if (first) entry.ready = Promise.resolve(undefined);
    const id = ++sequence;
    return await new Promise<number | undefined>((resolve, reject) => {
      const cancel = () => finish();
      const timer = setTimeout(() => close(ref.sha256, entry), 5000);
      function finish(count?: number) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        entry.pending.delete(id);
        if (!entry.pending.size && counters.get(ref!.sha256) === entry) entry.idle = setTimeout(() => close(ref!.sha256, entry), 60_000);
        if (signal?.aborted) reject(signal.reason);
        else resolve(Number.isSafeInteger(count) && count! > 0 ? count : undefined);
      }
      entry.pending.set(id, { finish });
      signal?.addEventListener("abort", cancel, { once: true });
      entry.worker.postMessage({ id, body, ...(first ? { bytes } : {}) }, first ? [bytes] : []);
    });
  } catch {
    if (signal?.aborted) {
      if (counter && !counter.pending.size && !counter.idle) {
        const entry = counter;
        entry.idle = setTimeout(() => close(ref.sha256, entry), 60_000);
      }
      signal.throwIfAborted();
    }
    if (counter) close(ref.sha256, counter);
    return undefined;
  }
}
