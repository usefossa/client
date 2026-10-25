import type { MarketModel, Offer, Settings } from "./types";

export const defaultSettings: Settings = { mode: "balanced", minSpeed: 0, zdrOnly: false };
export const priceFields = ["maxInputPrice", "maxCachedPrice", "maxOutputPrice"] as const;
export function validateSettings(value: unknown, previous = defaultSettings): Settings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid routing settings.");
  if (Object.keys(value).some(key => !["mode", "minSpeed", "zdrOnly", ...priceFields].includes(key))) throw Error("Unknown routing setting.");
  const settings = { ...previous, ...value } as Settings;
  if (!["balanced", "cheapest", "fastest"].includes(settings.mode) || !Number.isSafeInteger(settings.minSpeed) || settings.minSpeed < 0 || settings.minSpeed > 65535 || typeof settings.zdrOnly !== "boolean") throw Error("Invalid routing, speed, or ZDR setting.");
  for (const key of priceFields) { if (settings[key] === null) delete settings[key]; if (settings[key] !== undefined && (!Number.isFinite(settings[key]) || settings[key]! < 0 || settings[key]! > 4294)) throw Error("Enter a price between 0 and 4,294 USDC per million tokens."); }
  return settings;
}
export interface RoutingEstimate { input: number; cached: number; output: number; provider?: string }
export function rankOffers(offers: Offer[], settings: Settings, estimate?: RoutingEstimate) {
  const computeCost = (offer: Offer) => {
    if (!estimate) return offer.inputRate + offer.cachedRate + offer.outputRate;
    const cached = offer.provider.wallet === estimate.provider ? estimate.cached : 0;
    return Number(fee(estimate.input - cached, offer.inputRate) + fee(cached, offer.cachedRate) + fee(estimate.output, offer.outputRate));
  };
  const prices = new Map(offers.map(offer => [offer, computeCost(offer)]));
  const cost = (offer: Offer) => prices.get(offer)!;
  const costs = offers.map(cost), speeds = offers.map(offer => offer.speed);
  const lowCost = Math.min(...costs), costRange = Math.max(...costs) - lowCost || 1, highSpeed = Math.max(...speeds), speedRange = highSpeed - Math.min(...speeds) || 1;
  const score = (offer: Offer) => ((cost(offer) - lowCost) / costRange) ** 2 + ((highSpeed - offer.speed) / speedRange) ** 2;
  return [...offers].sort((a, b) => (settings.mode === "fastest" ? b.speed - a.speed : settings.mode === "balanced" ? score(a) - score(b) : 0) || cost(a) - cost(b) || b.speed - a.speed || a.slot - b.slot);
}
export const fee = (tokens: number, rate: number) => (BigInt(tokens) * BigInt(rate) + 999999n) / 1000000n;
const matches = (offer: Offer, settings: Settings) => offer.active && offer.speed >= settings.minSpeed && (!settings.zdrOnly || offer.private) && !!offer.provider.endpoint
  && [offer.inputRate, offer.cachedRate, offer.outputRate].every((rate, index) => settings[priceFields[index]] === undefined || rate <= Math.floor(settings[priceFields[index]]! * 1_000_000));
export function eligible(model: MarketModel, settings: Settings) {
  return model.offers.filter(offer => offer.available && offer.activeBookings < offer.capacity && matches(offer, settings));
}

export function settling(model: MarketModel, settings: Settings) {
  return model.offers.some(offer => matches(offer, settings) && offer.activeBookings > 0);
}

export function unavailable(model: MarketModel, settings: Settings, input: number, output: number) {
  const offers = model.offers.filter(offer => matches(offer, settings)).map(offer => ({ provider: offer.provider.name, activeBookings: offer.activeBookings, capacity: offer.capacity, reserve: (fee(input, offer.inputRate) + fee(output, offer.outputRate) + 1n).toString() }));
  const message = !offers.length ? "No provider matches this model’s price, speed, and data retention filters."
    : offers.every(offer => offer.activeBookings >= offer.capacity) ? "Matching providers are busy. Try again when a current request finishes."
    : "Matching providers are unavailable. Try again shortly.";
  return { message, data: { input, output, settings, offers } };
}
