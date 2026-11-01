import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultSettings, eligible, modelCheckpoints, rankOffers, routingRequirements, validateSettings } from "../src/routing";
import { Store } from "../src/store";
import type { MarketModel, Offer } from "../src/types";

const offer = (slot: number, rate: number, speed: number, zdr = false): Offer => ({ checkpoint: "07".repeat(32), checkpointId: "example/model@1017", checkpointName: "1017", checkpointOrder: 0, modalities: { input: ["text"], output: ["text"] }, contextTokens: 65536, inputBoundTokens: 65536, outputTokens: 8192, slot, provider: { wallet: `provider-${slot}`, name: `Provider ${slot}`, endpoint: "https://provider.invalid/v1/chat/completions" }, inputRate: rate, cachedRate: rate, outputRate: rate, speed, available: true, active: true, private: zdr, capacity: 10, activeBookings: 0 });
const offers = [offer(0, 1000000, 10), offer(1, 2000000, 50, true), offer(2, 9000000, 100)];

test("routing modes rank distinct offers and enforce price, speed, ZDR, and capacity", () => {
  expect(rankOffers(offers, { ...defaultSettings, mode: "cheapest" })[0].slot).toBe(0);
  expect(rankOffers(offers, { ...defaultSettings, mode: "balanced" })[0].slot).toBe(1);
  expect(rankOffers(offers, { ...defaultSettings, mode: "fastest" })[0].slot).toBe(2);
  const model = { offers } as MarketModel;
  expect(eligible(model, { ...defaultSettings, zdrOnly: true }).map(value => value.slot)).toEqual([1]);
  expect(eligible(model, { ...defaultSettings, minSpeed: 50, maxOutputPrice: 2 }).map(value => value.slot)).toEqual([1]);
  expect(eligible({ offers: [{ ...offers[0], activeBookings: offers[0].capacity }] } as MarketModel, defaultSettings)).toEqual([]);
  expect(() => validateSettings({ minSpeed: -1 })).toThrow();
  expect(() => validateSettings({ dailyBudgetAtomic: "1" })).toThrow();
});

test("filters persist per wallet and model while obsolete spend and output caps are discarded", () => {
  const directory = mkdtempSync(join(tmpdir(), "fossa-routing-")); let store = new Store(directory);
  try {
    store.db.query("INSERT INTO wallets(id,address,name,sealed,settings) VALUES(?,?,?,?,?)").run("wallet", "public", "Test", "{}", JSON.stringify({ maxRequestAtomic: "1", dailyBudgetAtomic: "1", maxOutputTokens: 1, privateOnly: true, minSpeed: 7 }));
    expect(store.settings("wallet", "old")).toEqual({ ...defaultSettings, minSpeed: 7 });
    store.setSettings("wallet", "model-a", { ...defaultSettings, minSpeed: 100, mode: "fastest" });
    store.close(); store = new Store(directory);
    expect(store.settings("wallet", "model-a").minSpeed).toBe(100);
    expect(store.settings("wallet", "model-b").minSpeed).toBe(7);
    expect(store.settings("another-wallet", "model-a")).toEqual(defaultSettings);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("request cost includes cached history only for its provider and respects explicit caps", () => {
  const previous = { ...offer(0, 2000000, 100), cachedRate: 100000, outputRate: 1000000 };
  const alternative = offer(1, 1000000, 100), model = { offers: [previous, alternative] } as MarketModel;
  const settings = { ...defaultSettings, mode: "cheapest" as const };
  const estimate = { input: 1000, cached: 900, output: 100, provider: previous.provider.wallet };
  expect(rankOffers(eligible(model, settings), settings, estimate)[0].slot).toBe(0);
  expect(rankOffers(model.offers, settings, { ...estimate, provider: "missing" })[0].slot).toBe(1);
  expect(rankOffers(eligible(model, { ...settings, maxInputPrice: 1 }), settings, estimate)[0].slot).toBe(1);
});

test("advanced requirements select committed versions and enforce per-offer capabilities and limits", () => {
  const earlier = { ...offers[0], checkpoint: "08".repeat(32), checkpointName: "0905", checkpointOrder: 0 };
  const latest = { ...offers[1], checkpointOrder: 1, modalities: { input: ["text", "image"], output: ["text"] } };
  const model = { offers: [earlier, latest] } as MarketModel;
  expect(eligible(model, defaultSettings)).toEqual([latest]);
  const settings = validateSettings({ advancedRouting: true, modelCheckpoint: earlier.checkpoint });
  expect(eligible(model, settings)).toEqual([earlier]);
  expect(eligible(model, { ...settings, modelCheckpoint: latest.checkpoint, inputModalities: 3 })).toEqual([latest]);
  expect(eligible(model, { ...settings, minContextTokens: 131072 })).toEqual([]);
  expect(eligible(model, settings, 64000, 2000)).toEqual([]);
  for (const patch of [{ modelCheckpoint: "0".repeat(64) }, { inputModalities: 0 }, { outputModalities: 16 }, { maxOutputTokens: -1 }, { minContextTokens: 4294967296 }]) expect(() => validateSettings(patch)).toThrow();
});

test("missing versions have no separate option and use the earliest published identity", () => {
  const unspecified = { ...offers[0], checkpoint: "09".repeat(32), checkpointName: "Unspecified", checkpointOrder: null };
  const latest = { ...offers[1], checkpoint: "08".repeat(32), checkpointOrder: 1 };
  const model = { offers: [unspecified, offers[1], latest] } as MarketModel;
  expect(modelCheckpoints(model).map(version => version.order)).toEqual([0, 1]);
  expect(eligible(model, defaultSettings)).toEqual([latest]);
  expect(eligible(model, { ...defaultSettings, advancedRouting: true, modelCheckpoint: unspecified.checkpoint })).toEqual([unspecified, offers[1]]);
  expect(modelCheckpoints({ offers: [unspecified] } as MarketModel)).toEqual([{ hash: unspecified.checkpoint, name: "Latest", order: 0 }]);
  expect(routingRequirements({ offers: [unspecified] } as MarketModel, defaultSettings).checkpoint).toBe(unspecified.checkpoint);
});

test("canonical model settings reuse a retired alias without replacing newer settings", () => {
  const directory = mkdtempSync(join(tmpdir(), "fossa-routing-alias-")), store = new Store(directory);
  try {
    store.setSettings("wallet", "retired", { ...defaultSettings, minSpeed: 123 });
    expect(store.settings("wallet", "canonical", ["retired"]).minSpeed).toBe(123);
    store.setSettings("wallet", "canonical", { ...defaultSettings, minSpeed: 456 });
    expect(store.settings("wallet", "canonical", ["retired"]).minSpeed).toBe(456);
    expect(store.settings("wallet", "retired").minSpeed).toBe(123);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
