import type { ProviderLimitState } from "../types";
export function providerQuotaAvailable(provider: ProviderLimitState, now = Date.now() / 1000) {
  if (!provider.providerLimits) return true;
  const quota = provider.providerLimits.global?.quota;
  return quota === 0 || Number.isSafeInteger(quota) && quota > 0
    && Number.isSafeInteger(provider.quotaWindowEnd) && Number.isSafeInteger(provider.quotaUsed) && provider.quotaUsed! >= 0
    && (now >= provider.quotaWindowEnd! || provider.quotaUsed! < quota);
}
