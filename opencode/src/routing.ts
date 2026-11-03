import { providerQuotaAvailable } from "./provider-limits";
import type { BookingRate, MarketModel, Offer, Settings } from "./types";

export const defaultSettings: Settings = { mode: "balanced", minSpeed: 0, zdrOnly: false, advancedRouting: false, desiredConcurrency: null, minimumBookingRate: null, modelCheckpoint: "", inputModalities: 1, outputModalities: 1, minContextTokens: null, maxInputTokens: null, maxOutputTokens: null };
export const priceFields = ["maxInputPrice", "maxCachedPrice", "maxOutputPrice"] as const;
export function validateSettings(value: unknown, previous = defaultSettings): Settings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid routing settings.");
  if (Object.keys(value).some(key => !["mode", "minSpeed", "zdrOnly", "advancedRouting", "desiredConcurrency", "minimumBookingRate", "modelCheckpoint", "inputModalities", "outputModalities", "minContextTokens", "maxInputTokens", "maxOutputTokens", ...priceFields].includes(key))) throw Error("Unknown routing setting.");
  const settings = { ...defaultSettings, ...previous, ...value } as Settings;
  if (!["balanced", "cheapest", "fastest"].includes(settings.mode) || !Number.isSafeInteger(settings.minSpeed) || settings.minSpeed < 0 || settings.minSpeed > 65535 || typeof settings.zdrOnly !== "boolean") throw Error("Invalid routing, speed, or ZDR setting.");
  for (const key of priceFields) { if (settings[key] === null) delete settings[key]; if (settings[key] !== undefined && (!Number.isFinite(settings[key]) || settings[key]! < 0 || settings[key]! > 4294)) throw Error("Enter a price between 0 and 4,294 USDC per million tokens."); }
  if (typeof settings.advancedRouting !== "boolean" || typeof settings.modelCheckpoint !== "string" || settings.modelCheckpoint !== "" && !/^(?!0{64})[a-f0-9]{64}$/.test(settings.modelCheckpoint)) throw Error("Invalid advanced routing or checkpoint.");
  for (const key of ["inputModalities", "outputModalities"] as const) if (!Number.isInteger(settings[key]) || settings[key]! < 1 || settings[key]! > 15) throw Error("Choose at least one supported modality.");
  for (const key of ["minContextTokens", "maxInputTokens", "maxOutputTokens"] as const) if (settings[key] !== null && (!Number.isSafeInteger(settings[key]) || settings[key]! < 1 || settings[key]! > 0xffffffff)) throw Error("Token limits must be positive whole numbers, or Auto.");
  if (settings.desiredConcurrency !== null && (!Number.isSafeInteger(settings.desiredConcurrency) || settings.desiredConcurrency! < 1 || settings.desiredConcurrency! > 0xffffffff)) throw Error("Concurrency must be a positive whole number, or Auto.");
  const quota = settings.minimumBookingRate;
  if (quota !== null && quota !== "unlimited" && (typeof quota !== "number" || !Number.isFinite(quota) || quota <= 0)) throw Error('Minimum quota must be a positive REQ/M value, "unlimited" for uncapped wallet quotas, or Auto.');
  if (!settings.advancedRouting) Object.assign(settings, { desiredConcurrency: null, minimumBookingRate: null, modelCheckpoint: "", inputModalities: 1, outputModalities: 1, minContextTokens: null, maxInputTokens: null, maxOutputTokens: null });
  return settings;
}
export const modalityOptions = [{ label: "Text", bit: 1 }, { label: "Image", bit: 2 }, { label: "Audio", bit: 4 }, { label: "Video", bit: 8 }] as const;
export const modalityMask = (values: string[] = []) => modalityOptions.reduce((mask, option) => mask | (values.includes(option.label.toLowerCase()) ? option.bit : 0), 0);
export function modelCheckpoints(model: MarketModel) {
  const checkpoints = new Map<string, { hash: string; name: string; order: number | null }>();
  for (const offer of model.offers) if (offer.active && /^(?!0{64})[a-f0-9]{64}$/.test(offer.checkpoint) && offer.checkpointName && (offer.checkpointOrder === null || Number.isSafeInteger(offer.checkpointOrder) && offer.checkpointOrder >= 0)) checkpoints.set(offer.checkpoint, { hash: offer.checkpoint, name: offer.checkpointName, order: offer.checkpointOrder });
  const versions = [...checkpoints.values()].filter(version => version.order !== null).sort((a, b) => a.order! - b.order!);
  return versions.length ? versions.map(version => ({ ...version, name: /^(release|unspecified|unknown)$/i.test(version.name) ? "Latest" : version.name })) : [...checkpoints.values()].slice(0, 1).map(version => ({ ...version, name: "Latest", order: 0 }));
}
export function routingRequirements(model: MarketModel, settings: Settings) {
  const versions = modelCheckpoints(model), advanced = settings.advancedRouting;
  const checkpoint = (advanced && settings.modelCheckpoint ? versions.find(version => version.hash === settings.modelCheckpoint) ?? versions[0] : versions.at(-1))?.hash;
  return {
    checkpoint,
    allowUnversioned: Boolean(checkpoint && checkpoint === versions[0]?.hash),
    inputModalities: advanced ? settings.inputModalities ?? 1 : 1,
    outputModalities: advanced ? settings.outputModalities ?? 1 : 1,
    minContext: advanced ? settings.minContextTokens ?? 0 : 0,
    requiredConcurrency: advanced ? settings.desiredConcurrency ?? 1 : 1,
    minimumBookingRate: advanced ? settings.minimumBookingRate : null,
    limitsConfigured: Boolean(advanced && [settings.minContextTokens, settings.maxInputTokens, settings.maxOutputTokens].some(value => value != null)),
  };
}
export function modelLimits(model: MarketModel, settings: Settings) {
  const requirements = routingRequirements(model, settings);
  const offers = model.offers.filter(offer => offer.active && offerFits(offer, requirements));
  return {
    context: Math.max(0, ...offers.map(offer => offer.contextTokens)),
    input: Math.max(0, ...offers.map(offer => offer.inputBoundTokens)),
    output: Math.min(settings.advancedRouting && settings.maxOutputTokens != null ? settings.maxOutputTokens : Infinity, Math.max(0, ...offers.map(offer => offer.outputTokens))),
    modalities: { input: [...new Set(offers.flatMap(offer => offer.modalities.input))], output: [...new Set(offers.flatMap(offer => offer.modalities.output))] },
  };
}
export function offerFits(offer: Offer, requirements: ReturnType<typeof routingRequirements>, input = 0, output = 0) {
  return supportsConcurrency(offer, requirements.requiredConcurrency ?? 1) && supportsBookingRate(offer, requirements.minimumBookingRate) && (offer.checkpoint === requirements.checkpoint || requirements.allowUnversioned && offer.checkpointOrder === null && /^(?!0{64})[a-f0-9]{64}$/.test(offer.checkpoint))
    && (modalityMask(offer.modalities?.input) & requirements.inputModalities) === requirements.inputModalities
    && (modalityMask(offer.modalities?.output) & requirements.outputModalities) === requirements.outputModalities
    && offer.inputBoundTokens >= input && offer.outputTokens >= output && offer.contextTokens >= Math.max(requirements.minContext, input + output);
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
export function eligible(model: MarketModel, settings: Settings, input = 0, output = 0, requirements = routingRequirements(model, settings)) {
  const maxInput = Math.max(input, settings.advancedRouting ? settings.maxInputTokens ?? 0 : 0), maxOutput = Math.max(output, settings.advancedRouting ? settings.maxOutputTokens ?? 0 : 0);
  return model.offers.filter(offer => offer.available && providerQuotaAvailable(offer.provider) && offer.activeBookings < offer.capacity && matches(offer, settings) && offerFits(offer, requirements, maxInput, maxOutput));
}

export function settling(model: MarketModel, settings: Settings, input = 0, output = 0, requirements = routingRequirements(model, settings)) {
  return model.offers.some(offer => matches(offer, settings) && offerFits(offer, requirements, input, output) && offer.activeBookings > 0);
}

export function unavailable(model: MarketModel, settings: Settings, input: number, output: number) {
  const requirements = routingRequirements(model, settings);
  const offers = model.offers.filter(offer => matches(offer, settings) && offerFits(offer, requirements, input, output)).map(offer => ({ provider: offer.provider.name, activeBookings: offer.activeBookings, capacity: offer.capacity, reserve: (fee(input, offer.inputRate) + fee(output, offer.outputRate) + 1n).toString() }));
  const message = !offers.length ? settings.advancedRouting && settings.minimumBookingRate === "unlimited"
    ? "No provider offers an uncapped wallet quota and matches your other filters. Choose Auto or a numeric quota."
    : "No provider matches this model’s version, modalities, token, concurrency, quota, price, speed, and data retention filters."
    : offers.every(offer => offer.activeBookings >= offer.capacity) ? "Matching providers are busy. Try again when a current request finishes."
    : "Matching providers are unavailable. Try again shortly.";
  return { message, data: { input, output, settings, offers } };
}

export function supportsConcurrency(offer: Offer, required = 1) {
  const limit = offer.provider?.bookingLimits;
  return Number.isSafeInteger(required) && required >= 1 && required <= 0xffffffff && (required === 1 || offer.capacity >= required)
    && !limit?.updating && (required === 1 || limit !== undefined && limit !== null)
    && (!limit || limit.walletBookingCapacity === 0 || limit.walletBookingCapacity >= required);
}

export function bookingRate(offer: Offer) {
  const wallet = offer.provider.providerLimits?.wallet, legacy = offer.provider.bookingLimits;
  const quota = wallet?.quota ?? legacy?.walletBookingsPerWindow, seconds = wallet?.quotaWindowSeconds ?? legacy?.walletWindowSeconds;
  return quota === 0 ? Infinity : quota !== undefined && seconds !== undefined && seconds > 0 ? quota * 60 / seconds : undefined;
}

export function supportsBookingRate(offer: Offer, minimum?: BookingRate) {
  if (minimum == null) return true;
  const rate = bookingRate(offer);
  return rate !== undefined && (minimum === "unlimited" ? rate === Infinity : Number.isFinite(minimum) && minimum > 0 && rate >= minimum);
}

export const quotaText = (value?: BookingRate) => value == null ? "Auto" : value === "unlimited" ? "Uncapped only" : `${value.toLocaleString(undefined, { maximumSignificantDigits: 6 })} REQ/M`;
