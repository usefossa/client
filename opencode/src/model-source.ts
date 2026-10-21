import type { Context } from "@opencode/plugin/tui/context";
import { Fossa } from "./rpc";
import { errorMessage, type ModelDetails } from "./types";

type Listener = (value?: ModelDetails, error?: string) => void;
type Entry = { value?: ModelDetails; at: number; version: number; error?: string; pending?: Promise<ModelDetails>; listeners: Set<Listener> };
const settings = ["mode", "minSpeed", "maxInputPrice", "maxOutputPrice", "maxCachedPrice", "zdrOnly"] as const;
const offers = ["provider", "wallet", "url", "input", "output", "cached", "speed", "zdr"] as const;

export function sameModel(a: ModelDetails | undefined, b: ModelDetails) {
  return !!a && a.id === b.id && a.name === b.name && settings.every(key => a.settings[key] === b.settings[key])
    && a.offers.length === b.offers.length && a.offers.every((offer, index) => offers.every(key => offer[key] === b.offers[index][key]));
}

export function createModelSource(context: Context) {
  const rpc = context.client.rpc(Fossa), entries = new Map<string, Entry>();
  let timer: ReturnType<typeof setInterval> | undefined, stopped = false;
  const entry = (id: string) => {
    let value = entries.get(id);
    if (!value) {
      if (entries.size >= 32) { const oldest = [...entries].find(([, row]) => !row.listeners.size && !row.pending); if (oldest) entries.delete(oldest[0]); }
      value = { at: 0, version: 0, listeners: new Set() }; entries.set(id, value);
    }
    return value;
  };
  const get = (id: string, force = false): Promise<ModelDetails> => {
    const row = entry(id);
    if (row.pending) return row.pending;
    if (!force && row.value && Date.now() - row.at < 2000) return Promise.resolve(row.value);
    const version = row.version;
    return row.pending = (async () => {
      try {
        const value = await rpc.model({ model: id }) as ModelDetails;
        if (version !== row.version) throw Error("Fossa API endpoint changed. Refresh the model.");
        row.at = Date.now();
        if (!stopped) {
          const changed = !sameModel(row.value, value), recovered = !!row.error;
          if (changed) row.value = value;
          row.error = undefined;
          if (changed || recovered) for (const listener of row.listeners) listener(row.value);
        }
        return row.value ?? value;
      } catch (error) {
        if (!stopped && version === row.version) { const message = errorMessage(error); if (row.error !== message) { row.error = message; for (const listener of row.listeners) listener(row.value, message); } }
        throw error;
      }
      finally { row.pending = undefined; }
    })();
  };
  return {
    get,
    invalidate() { for (const row of entries.values()) { row.version++; row.value = undefined; row.error = undefined; row.at = 0; for (const listener of row.listeners) listener(); } },
    watch(id: string, listener: Listener) {
      const row = entry(id); row.listeners.add(listener);
      if (row.value || row.error) listener(row.value, row.error);
      void get(id).catch(() => {});
      timer ??= setInterval(() => { for (const [id, row] of entries) if (row.listeners.size) void get(id).catch(() => {}); }, 2000);
      return () => {
        row.listeners.delete(listener);
        if (![...entries.values()].some(row => row.listeners.size)) { clearInterval(timer); timer = undefined; }
      };
    },
    dispose() { stopped = true; clearInterval(timer); entries.clear(); },
  };
}

export type ModelSource = ReturnType<typeof createModelSource>;
