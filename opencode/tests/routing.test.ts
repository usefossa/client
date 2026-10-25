import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultSettings, eligible, rankOffers, validateSettings } from "../src/routing";
import { Store } from "../src/store";
import type { MarketModel, Offer } from "../src/types";

const offer = (slot: number, rate: number, speed: number, zdr = false): Offer => ({ slot, provider: { wallet: `provider-${slot}`, name: `Provider ${slot}`, endpoint: "https://provider.invalid/v1/chat/completions" }, inputRate: rate, cachedRate: rate, outputRate: rate, speed, available: true, active: true, private: zdr, capacity: 10, activeBookings: 0 });
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
