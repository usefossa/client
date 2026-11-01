export interface PublicConfig {
  programId: string; market: string; providerList: string; usdcMint: string; solanaRpc: string;
  opencode: { deviceConnect?: boolean; manualImport?: boolean; siteUrl: string; deviceTtlSecs: number; maxInputTokens: number; maxRequestBytes: number; catalogMaxAgeMs: number; requestTimeoutMs: number; pollIntervalMs: number; mainnetGenesisHash: string; localBookingPoolSize: number };
}
export interface Offer {
  checkpoint: string; checkpointId: string; checkpointName: string; checkpointOrder: number | null; modalities: { input: string[]; output: string[] }; contextTokens: number; inputBoundTokens: number; outputTokens: number;
  slot: number; provider: { wallet: string; name: string; endpoint?: string }; inputRate: number; cachedRate: number; outputRate: number;
  speed: number; available: boolean; active: boolean; private: boolean; capacity: number; activeBookings: number;
}
export interface MarketModel {
  id: string; address: string; group?: string | null; name: string; terms: string; capacity: string; effort?: string[]; variants?: { id: string; body: { reasoning_effort: string } }[]; settings?: { maxTokens: number; temperature: number; topP: number }; offerCount: number; offers: Offer[];
  modalities: { input: string[]; output: string[] }; capabilities?: { tools: boolean; reasoning: boolean }; contextTokens?: number; outputTokens?: number; inputBoundTokens?: number;
}
export interface Catalog { aliases?: Record<string, string>; providerListFeeBps?: number; providerListProtocolShareBps?: number; ready: boolean; slot: number; programId: string; market: string; providerList: string; models: MarketModel[] }
export interface Chain { blockhash: string; lastValidBlockHeight: number; bookingRent: string; signatureFee: string; maxAgeMs: number }
export interface WalletState { wallet: string; lane: string; vault: string; source: string; ready: boolean; lamports: string; usdcAtomic: string; freeAtomic: string; generation: string; bookings: { address: string; status: number; generation: string; rentPayer: string }[]; slot: number }
export interface Account { walletId: string; wallet: string; lane: string; apiUrl: string; name: string; rpcUrl?: string; rpcWsUrl?: string; access: string; refresh: string; expires: number }
export interface WalletSecrets { owner: number[]; lane?: number[]; bookings: Record<string, number[]> }
export interface Settings { mode: "balanced" | "cheapest" | "fastest"; maxInputPrice?: number; maxCachedPrice?: number; maxOutputPrice?: number; minSpeed: number; zdrOnly: boolean; advancedRouting?: boolean; modelCheckpoint?: string; inputModalities?: number; outputModalities?: number; minContextTokens?: number | null; maxInputTokens?: number | null; maxOutputTokens?: number | null }
export interface RakebackSettings { autoRakeback: boolean; rakebackMode: "interval" | "amount"; rakebackIntervalMinutes: number; rakebackThresholdAtomic: string }
export interface RakebackFunds { free: string; expired: string; expiredBookings: number; bookings: { address: string; model: string; generation: string; reserve: string; claimEnd: number }[] }
export interface RakebackState extends RakebackSettings { availableAtomic: string; processing: boolean; needsRecovery: boolean; message: string }
export type FilterField = "minSpeed" | "maxInputPrice" | "maxCachedPrice" | "maxOutputPrice";
export interface ModelDetails { id: string; name: string; settings: Settings; checkpoint?: string; checkpoints?: { hash: string; name: string; order: number | null }[]; offers: { provider: string; wallet: string; url: string; input: number; cached: number; output: number; speed: number; zdr: boolean }[] }
export interface RoutedRequest { id: string; model: string; startedAt: number; provider: string }
export type Stage = "idle" | "connecting" | "locked" | "funding" | "synchronizing" | "booking" | "broadcasting" | "confirming" | "matched" | "streaming" | "settling" | "uncertain" | "error";
export interface UnlockRequest { requestId: string; sessionID: string; wallet: string }
export interface Status { stage: Stage; message: string; apiUrl?: string; sessionID?: string; requestId?: string; wallet?: string; siteUrl?: string; name?: string; provider?: string; model?: string; booking?: string; signature?: string; balanceAtomic?: string; reservedAtomic?: string; paidAtomic: string; rpc?: string; connected: boolean; security?: { protected: boolean; unlocked: boolean } }
export class FossaError extends Error {
  constructor(public code: string, message: string, public data?: Record<string, unknown>) { super(message); this.name = "FossaError"; }
}

export const errorMessage = (error: unknown) => error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : "Fossa unavailable.";
