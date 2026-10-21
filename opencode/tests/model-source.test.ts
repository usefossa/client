import { expect, test } from "bun:test";
import { createModelSource } from "../src/model-source";
import type { ModelDetails } from "../src/types";

const value: ModelDetails = { id: "test", name: "Test", settings: { mode: "balanced", minSpeed: 0, zdrOnly: false }, offers: [{ provider: "Provider", wallet: "wallet", url: "https://example.com", input: 0.1, output: 0.2, cached: 0.03, speed: 100, zdr: true }] };

test("shares concurrent model reads and publishes only changed data or connection recovery", async () => {
  let queries = 0, failed = false, next = structuredClone(value);
  const source = createModelSource({ client: { rpc: () => ({ model: async () => { queries++; await Promise.resolve(); if (failed) throw Error("Disconnected"); return structuredClone(next); } }) } } as never);
  const updates: { value?: ModelDetails; error?: string }[] = [];
  const stop = source.watch("test", (value, error) => updates.push({ value, error }));
  try {
    const [a, b] = await Promise.all([source.get("test"), source.get("test")]);
    expect(a).toBe(b); expect(queries).toBe(1); expect(updates).toHaveLength(1);
    await source.get("test", true); expect(updates).toHaveLength(1);
    next.offers[0].input = 0.3;
    const changed = await source.get("test", true); expect(changed).not.toBe(a); expect(updates).toHaveLength(2);
    failed = true; await expect(source.get("test", true)).rejects.toThrow("Disconnected");
    await expect(source.get("test", true)).rejects.toThrow("Disconnected"); expect(updates).toHaveLength(3);
    failed = false; expect(await source.get("test", true)).toBe(changed);
    expect(updates).toHaveLength(4); expect(updates.at(-1)?.error).toBeUndefined();
    stop(); await source.get("test", true); expect(updates).toHaveLength(4);
  } finally { stop(); source.dispose(); }
});

test("endpoint changes discard a model response from the previous API", async () => {
  let release!: () => void, queries = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const source = createModelSource({ client: { rpc: () => ({ model: async () => { if (++queries === 1) await gate; return structuredClone(value); } }) } } as never);
  const updates: (ModelDetails | undefined)[] = [], stop = source.watch("test", value => updates.push(value));
  try {
    const pending = source.get("test"); source.invalidate(); release();
    await expect(pending).rejects.toThrow("API endpoint changed");
    expect(updates).toEqual([undefined]);
    expect(await source.get("test")).toEqual(value); expect(queries).toBe(2); expect(updates).toHaveLength(2);
  } finally { release(); stop(); source.dispose(); }
});
