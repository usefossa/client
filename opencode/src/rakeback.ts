import { FossaError, type RakebackSettings } from "./types";

export const defaultRakeback: RakebackSettings = { autoRakeback: false, rakebackMode: "interval", rakebackIntervalMinutes: 60, rakebackThresholdAtomic: "1000000" };
export const rakebackIntervals = [15, 60, 360] as const;
export const rakebackAmounts = ["1000000", "5000000", "10000000"] as const;
export function validateRakeback(patch: unknown, current = defaultRakeback): RakebackSettings {
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).some(key => !Object.hasOwn(defaultRakeback, key))) throw new FossaError("RAKEBACK_SETTINGS", "Invalid rakeback settings.");
  const value = { ...current, ...patch };
  if (typeof value.autoRakeback !== "boolean" || !["interval", "amount"].includes(value.rakebackMode) || !rakebackIntervals.some(item => item === value.rakebackIntervalMinutes) || !rakebackAmounts.some(item => item === value.rakebackThresholdAtomic)) throw new FossaError("RAKEBACK_SETTINGS", "Choose one of the available rakeback options.");
  return value;
}
export const recoverable = (funds: { free: string; expired: string }) => {
  if (!/^\d+$/.test(funds.free) || !/^\d+$/.test(funds.expired)) throw new FossaError("RAKEBACK_BALANCE", "Rakeback balance unavailable.");
  return BigInt(funds.free) + BigInt(funds.expired);
};
export const rakebackDollars = (amount: string) => {
  const cents = (BigInt(amount) + 5_000n) / 10_000n;
  return `$${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
};
