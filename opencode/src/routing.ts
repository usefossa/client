import type { MarketModel, Offer, Settings } from "./types";

export const defaultSettings: Settings = { mode: "balanced", minSpeed: 0, zdrOnly: false, advancedRouting: false, modelCheckpoint: "", inputModalities: 1, outputModalities: 1, minContextTokens: null, maxInputTokens: null, maxOutputTokens: null };
export const priceFields = ["maxInputPrice", "maxCachedPrice", "maxOutputPrice"] as const;
export function validateSettings(value: unknown, previous = defaultSettings): Settings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid routing settings.");
  if (Object.keys(value).some(key => !["mode", "minSpeed", "zdrOnly", "advancedRouting", "modelCheckpoint", "inputModalities", "outputModalities", "minContextTokens", "maxInputTokens", "maxOutputTokens", ...priceFields].includes(key))) throw Error("Unknown routing setting.");
  const settings = { ...defaultSettings, ...previous, ...value } as Settings;
  if (!["balanced", "cheapest", "fastest"].includes(settings.mode) || !Number.isSafeInteger(settings.minSpeed) || settings.minSpeed < 0 || settings.minSpeed > 65535 || typeof settings.zdrOnly !== "boolean") throw Error("Invalid routing, speed, or ZDR setting.");
  for (const key of priceFields) { if (settings[key] === null) delete settings[key]; if (settings[key] !== undefined && (!Number.isFinite(settings[key]) || settings[key]! < 0 || settings[key]! > 4294)) throw Error("Enter a price between 0 and 4,294 USDC per million tokens."); }
  if (typeof settings.advancedRouting !== "boolean" || typeof settings.modelCheckpoint !== "string" || settings.modelCheckpoint !== "" && !/^(?!0{64})[a-f0-9]{64}$/.test(settings.modelCheckpoint)) throw Error("Invalid advanced routing or checkpoint.");
  for (const key of ["inputModalities", "outputModalities"] as const) if (!Number.isInteger(settings[key]) || settings[key]! < 1 || settings[key]! > 15) throw Error("Choose at least one supported modality.");
  for (const key of ["minContextTokens", "maxInputTokens", "maxOutputTokens"] as const) if (settings[key] !== null && (!Number.isSafeInteger(settings[key]) || settings[key]! < 1 || settings[key]! > 0xffffffff)) throw Error("Token limits must be positive whole numbers, or Auto.");
  return settings;
}
export const modalityOptions = [{ label: "Text", bit: 1 }, { label: "Image", bit: 2 }, { label: "Audio", bit: 4 }, { label: "Video", bit: 8 }] as const;
export const modalityMask = (values: string[] = []) => modalityOptions.reduce((mask, option) => mask | (values.includes(option.label.toLowerCase()) ? option.bit : 0), 0);
export function modelCheckpoints(model: MarketModel) {
  const checkpoints = new Map<string, { hash: string; name: string; order: number | null }>();
  for (const offer of model.offers) if (offer.active && /^(?!0{64})[a-f0-9]{64}$/.test(offer.checkpoint) && offer.checkpointName && (offer.checkpointOrder === null || Number.isSafeInteger(offer.checkpointOrder) && offer.checkpointOrder >= 0)) checkpoints.set(offer.checkpoint, { hash: offer.checkpoint, name: offer.checkpointName, order: offer.checkpointOrder });
  return [...checkpoints.values()].sort((a, b) => a.order === null ? Number(b.order !== null) : b.order === null ? -1 : a.order - b.order);
}
export function routingRequirements(model: MarketModel, settings: Settings) {
  const versions = modelCheckpoints(model), advanced = settings.advancedRouting;
  return {
    checkpoint: (advanced && versions.find(version => version.hash === settings.modelCheckpoint) || versions.findLast(version => version.order !== null) || versions[0])?.hash,
    inputModalities: advanced ? settings.inputModalities ?? 1 : 1,
    outputModalities: advanced ? settings.outputModalities ?? 1 : 1,
    minContext: advanced ? settings.minContextTokens ?? 0 : 0,
    limitsConfigured: Boolean(advanced && [settings.minContextTokens, settings.maxInputTokens, settings.maxOutputTokens].some(value => value != null)),
  };
}
export function modelLimits(model: MarketModel, settings: Settings) {
  const checkpoint = routingRequirements(model, settings).checkpoint;
  const offers = model.offers.filter(offer => offer.active && offer.checkpoint === checkpoint);
  return {
    context: Math.max(0, ...offers.map(offer => offer.contextTokens)),
    input: Math.max(0, ...offers.map(offer => offer.inputBoundTokens)),
    output: Math.min(settings.advancedRouting && settings.maxOutputTokens != null ? settings.maxOutputTokens : Infinity, Math.max(0, ...offers.map(offer => offer.outputTokens))),
    modalities: { input: [...new Set(offers.flatMap(offer => offer.modalities.input))], output: [...new Set(offers.flatMap(offer => offer.modalities.output))] },
  };
}
export function offerFits(offer: Offer, requirements: ReturnType<typeof routingRequirements>, input = 0, output = 0) {
  return offer.checkpoint === requirements.checkpoint
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
  return model.offers.filter(offer => offer.available && offer.activeBookings < offer.capacity && matches(offer, settings) && offerFits(offer, requirements, maxInput, maxOutput));
}

export function settling(model: MarketModel, settings: Settings, input = 0, output = 0, requirements = routingRequirements(model, settings)) {
  return model.offers.some(offer => matches(offer, settings) && offerFits(offer, requirements, input, output) && offer.activeBookings > 0);
}

export function unavailable(model: MarketModel, settings: Settings, input: number, output: number) {
  const requirements = routingRequirements(model, settings);
  const offers = model.offers.filter(offer => matches(offer, settings) && offerFits(offer, requirements, input, output)).map(offer => ({ provider: offer.provider.name, activeBookings: offer.activeBookings, capacity: offer.capacity, reserve: (fee(input, offer.inputRate) + fee(output, offer.outputRate) + 1n).toString() }));
  const message = !offers.length ? "No provider matches this model’s version, modalities, token, price, speed, and data retention filters."
    : offers.every(offer => offer.activeBookings >= offer.capacity) ? "Matching providers are busy. Try again when a current request finishes."
    : "Matching providers are unavailable. Try again shortly.";
  return { message, data: { input, output, settings, offers } };
}
