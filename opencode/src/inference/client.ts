import { bookingLookupTables, compileBookingTransaction } from "./booking-transaction";
import { createHash, randomUUID } from "node:crypto";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction, type AccountInfo } from "@solana/web3.js";
import { cachedProviderWallet, listRoutingAddresses, prepareProviderWallet, providerWalletAddress, providerLimitPages, providerLimitPageAddress } from "./provider-wallet";
import { sizeCompute, transactionPriority, simulationMiddleware, type BookingComputeState } from "./compute-budget";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "../account/token";
import bs58 from "bs58";
import { bookingPending, readProviderFailure } from "./provider-response";
import { providerFetch } from "./provider-fetch";
import { api, config, safeUrl } from "../api";
import { signMessage } from "../account/signing";
import { Store, type Pending } from "../account/store";
import { inputBound, validateBody } from "../protocol";
import { recoverable, rakebackDollars } from "./rakeback";
import { FossaError, type Account, type Catalog, type Chain, type MarketModel, type Offer, type PublicConfig, type RakebackFunds, type RakebackState, type Settings, type Status, type TransactionFees, type WalletState } from "../types";

export { inputBound } from "../protocol";
import { eligible, fee, priceFields, rankOffers, settling, unavailable, routingRequirements, offerFits } from "./routing";
export { eligible, fee } from "./routing";
const atomic = (value: bigint, decimals = 6) => `${value / 10n ** BigInt(decimals)}.${(value % 10n ** BigInt(decimals)).toString().padStart(decimals, "0")}`;
const digest = (body: string) => createHash("sha256").update(body).digest("hex");
const meta = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
const discriminator = (name: string) => createHash("sha256").update(name).digest().subarray(0, 8);
const ix = (programId: PublicKey, name: string, data: Buffer, keys: ReturnType<typeof meta>[]) => new TransactionInstruction({ programId, data: Buffer.concat([discriminator(`global:${name}`), data]), keys });
const terminal = new Set(["settled", "released", "failed", "expired"]);
const validSlot = (value: unknown) => typeof value === "bigint" ? value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) : typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const LiveSocket = WebSocket as typeof WebSocket & { new(url: URL, options: Bun.WebSocketOptions): WebSocket };

export class FossaClient {
  private cancellations = new Map<string, Promise<void>>();
  cfg!: PublicConfig; catalog?: Catalog; wallet?: WalletState; chain?: Chain;
  status: Status = { stage: "connecting", message: "Connecting to Fossa…", paidAtomic: "0", connected: false };
  private rpc!: Connection; private socket?: WebSocket; private retry?: ReturnType<typeof setTimeout>; private timer?: ReturnType<typeof setInterval>;
  private chainUntil = 0; private catalogAt = 0; private walletAt = 0; private stopped = false; private refreshing?: Promise<void>;
  private transactionFees?: TransactionFees;
  private walletAddresses?: Promise<{ source: string; vault: string }>;
  private feeVersion = 0;
  private catalogWaiters = new Set<() => void>();
  private walletWaiters = new Set<() => void>();
  private catalogVersion = 0;
  private watchers = new Map<string, (info: AccountInfo<Uint8Array> | null, slot: number, source?: "stream" | "rpc") => void>();
  private broadcasts = new Set<string>();
  private rakebackTimer?: ReturnType<typeof setInterval>;
  private recovering?: Promise<void>;
  private rakebackRunning?: Promise<{ kind: string; amountAtomic: string; signatures: string[] }>;
  private raking = false; private rakebackMessage = "";
  constructor(readonly store: Store, public account: Account, readonly changed: () => void) {}
  publish(patch: Partial<Status>) { this.status = { ...this.status, ...patch }; this.changed(); }
  private progress(id: string, patch: Partial<Status>) { if (this.status.requestId === id) this.publish(patch); }
  settings(model = "") { const canonical = this.catalog?.aliases?.[model] ?? model; return this.store.settings(this.account.walletId, canonical, Object.entries(this.catalog?.aliases ?? {}).filter(([, target]) => target === canonical).map(([alias]) => alias)); }
  async start() {
    await this.store.autoUnlock(this.account.walletId);
    this.cfg = await config(this.account.apiUrl);
    const endpoint = this.account.rpcUrl || `${this.account.apiUrl}/v1/opencode/rpc`;
    this.rpc = new Connection(endpoint, { commitment: "processed", disableRetryOnRateLimit: true, fetchMiddleware: simulationMiddleware, ...(this.account.rpcUrl ? { wsEndpoint: this.account.rpcWsUrl } : { httpHeaders: { authorization: `Bearer ${this.account.access}` } }) });
    await Promise.all([this.refresh(), this.rpc.getGenesisHash().then(hash => { if (hash !== this.cfg.opencode.mainnetGenesisHash) throw new FossaError("WRONG_NETWORK", "Selected RPC does not match the configured Solana network."); })]); this.connect();
    this.timer = setInterval(() => void this.refresh().catch(error => this.publish({ connected: false, stage: "error", message: error instanceof Error ? error.message : "Fossa unavailable." })), this.cfg.opencode.catalogMaxAgeMs / 2);
    this.rakebackTimer = setInterval(() => { void this.recoverPending(); void this.automaticRakeback(); }, 60_000);
    void this.recoverPending();
    this.publish({ wallet: this.account.wallet, name: this.account.name, rpc: new URL(endpoint).host, stage: this.store.unlocked(this.account.walletId) ? "idle" : "locked", message: this.store.unlocked(this.account.walletId) ? "Ready" : "Unlock your Fossa wallet from the command palette." });
  }
  private connect() {
    if (this.stopped) return;
    const url = new URL(`${this.account.apiUrl}/v1/opencode/live`); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new LiveSocket(url, { headers: { authorization: `Bearer ${this.account.access}` } }); this.socket = socket;
    socket.onopen = () => { for (const address of this.watchers.keys()) socket.send(JSON.stringify({ watch: address })); };
    socket.onmessage = async event => {
      try {
        const update = JSON.parse(String(event.data));
        if (update.type === "catalog") this.updateCatalog(update.data);
        if (update.type === "chain") { this.chain = update.data ?? undefined; this.chainUntil = Date.now() + (this.chain?.maxAgeMs ?? 0) - 1000; }
        if (update.type === "fees") { this.acceptFees(update.data); return; }
        if (update.type === "wallet") {
          const wallet = await this.validateSnapshot(update.data);
          if (this.stopped || socket !== this.socket) return;
          if (wallet.slot >= (this.wallet?.slot ?? 0)) { this.wallet = wallet; this.acceptFees(wallet.transactionFees); this.walletAt = Date.now(); this.wakeWallet(); }
        }
        if (update.type === "receipt" && update.commitment === "confirmed") this.receipt(update.data);
        if (update.type === "resync") void this.refresh().catch(() => {});
        if (update.type === "booking") {
          const info = update.data.data === null ? null : { owner: new PublicKey(update.data.owner), data: Buffer.from(update.data.data, "base64"), executable: false, lamports: 0n, rentEpoch: 0n };
          if (!info && this.wallet) this.wallet.bookings = this.wallet.bookings.filter(item => item.address !== update.address);
          this.watchers.get(update.address)?.(info, update.data.slot);
        }
        this.publish({ connected: true, balanceAtomic: this.wallet ? (BigInt(this.wallet.usdcAtomic) + BigInt(this.wallet.freeAtomic)).toString() : undefined });
      } catch { socket.close(); }
    };
    socket.onclose = () => { if (!this.stopped && socket === this.socket) { this.publish({ connected: false }); this.retry = setTimeout(() => this.connect(), this.cfg.opencode.pollIntervalMs); } };
    socket.onerror = () => socket.close();
  }
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.refreshing ??= (async () => {
      const version = this.catalogVersion;
      const [catalog, wallet, history] = await Promise.all([api<Catalog>(this.account.apiUrl, "/market/catalog"), this.snapshot(), api<{ receipts: { booking: string; generation: string; charge: string }[] }>(this.account.apiUrl, "/opencode/receipts", { token: this.account.access })]);
      if (catalog.programId !== this.cfg.programId || catalog.market !== this.cfg.market || catalog.providerList !== this.cfg.providerList) throw new FossaError("MARKET_CHANGED", "Fossa protocol configuration changed. Reconnect before signing.");
      this.updateCatalog(catalog, version);
      if (wallet.slot >= (this.wallet?.slot ?? 0)) { this.wallet = wallet; this.walletAt = Date.now(); }
      const rows = this.store.history(this.account.wallet, this.scope), byBooking = new Map(rows.map(row => [`${row.booking}:${row.generation}`, row]));
      for (const receipt of history.receipts) {
        const summary = byBooking.get(`${receipt.booking}:${receipt.generation}`);
        if (!summary || summary.stage === "settled" && summary.charge === receipt.charge || !/^\d{1,20}$/.test(receipt.charge)) continue;
        const row = this.localRequest(summary.id);
        if (!row || BigInt(receipt.charge) > BigInt(row.reserve)) continue;
        row.charge = receipt.charge; row.stage = "settled"; row.settledAt ??= Date.now(); this.store.put(row);
        summary.charge = row.charge; summary.stage = row.stage;
      }
      this.publish({ connected: true, balanceAtomic: (BigInt(wallet.usdcAtomic) + BigInt(wallet.freeAtomic)).toString(), reservedAtomic: this.rows(true).reduce((sum, row) => sum + BigInt(row.reserve), 0n).toString(), paidAtomic: rows.reduce((sum, row) => sum + BigInt(row.charge ?? "0"), 0n).toString() });
      this.wakeWallet();
      if (["settling", "uncertain"].includes(this.status.stage) && rows.some(row => row.id === this.status.requestId && ["settled", "released"].includes(row.stage))) this.publish({ stage: "idle", message: "Payment settled." });
    })().finally(() => { this.refreshing = undefined; });
  }
  private updateCatalog(catalog: Catalog, version = this.catalogVersion) {
    if (catalog.programId !== this.cfg.programId || catalog.market !== this.cfg.market || catalog.providerList !== this.cfg.providerList) throw new FossaError("MARKET_CHANGED", "Fossa protocol configuration changed. Reconnect before signing.");
    if (this.catalog && (catalog.slot < this.catalog.slot || version !== this.catalogVersion && catalog.slot === this.catalog.slot)) return;
    this.catalog = catalog; this.catalogAt = Date.now();
    this.catalogVersion++;
    for (const wake of this.catalogWaiters) wake();
  }
  private wakeWallet() { for (const wake of this.walletWaiters) wake(); }
  private receipt(value: unknown) {
    const receipt = value as { owner?: string; provider?: string; booking?: string; generation?: string; charge?: string; slot?: number } | null;
    if (!receipt || receipt.owner !== this.account.wallet || typeof receipt.charge !== "string" || !/^\d{1,20}$/.test(receipt.charge) || !Number.isSafeInteger(receipt.slot) || receipt.slot! < 0) return;
    if (typeof receipt.booking !== "string" || typeof receipt.generation !== "string") return;
    const row = this.store.booking(this.account.wallet, receipt.booking, receipt.generation, this.scope);
    if (!row || receipt.slot! < (row.processedSlot ?? 0) || BigInt(receipt.charge) > BigInt(row.reserve) || row.provider && receipt.provider !== row.provider) return;
    row.charge = receipt.charge; row.stage = "settled"; row.settlementSlot = receipt.slot; row.settledAt ??= Date.now(); this.store.put(row);
    this.wakeWallet(); this.changed();
  }
  private waitForCatalog(signal: AbortSignal, deadline: number) {
    return this.waitForUpdate(this.catalogWaiters, signal, deadline, Math.min(1000, this.cfg.opencode.pollIntervalMs / 4));
  }
  private waitForUpdate(waiters: Set<() => void>, signal: AbortSignal, deadline: number, interval: number) {
    signal.throwIfAborted();
    return new Promise<boolean>((resolve, reject) => {
      const finish = (changed: boolean, error?: unknown) => { clearTimeout(timer); waiters.delete(wake); signal.removeEventListener("abort", abort); if (error !== undefined) reject(error); else resolve(changed); };
      const wake = () => finish(true), abort = () => finish(false, signal.reason);
      const timer = setTimeout(() => finish(false), Math.max(0, Math.min(interval, deadline - Date.now())));
      waiters.add(wake); signal.addEventListener("abort", abort, { once: true });
    });
  }
  async snapshot(minSlot = 0, forceRpc = false): Promise<WalletState> {
    const pool = new Set([...(this.wallet?.bookings ?? []).map(item => item.address), ...Object.keys(this.store.unlocked(this.account.walletId) ? this.store.secrets(this.account.walletId).bookings : {})]);
    if (!this.account.rpcUrl && !forceRpc) {
      const snapshot = await this.validateSnapshot(await api<WalletState>(this.account.apiUrl, "/opencode/wallet", { token: this.account.access }));
      this.acceptFees(snapshot.transactionFees);
      if (snapshot.slot >= minSlot && [...pool].every(address => snapshot.bookings.some(item => item.address === address))) return snapshot;
    }
    const program = new PublicKey(this.cfg.programId), owner = new PublicKey(this.account.wallet), lane = new PublicKey(this.account.lane), mint = new PublicKey(this.cfg.usdcMint);
    const [source, [authority]] = await Promise.all([getAssociatedTokenAddress(mint, owner), PublicKey.findProgramAddress([Buffer.from("vault"), lane.toBytes()], program)]), vault = await getAssociatedTokenAddress(mint, authority, true);
    const addresses = [owner, source, lane, ...[...pool].map(value => new PublicKey(value))];
    const result = await this.rpc.getMultipleAccountsInfoAndContext(addresses, { commitment: "processed", ...(minSlot ? { minContextSlot: minSlot } : {}) });
    const values = result.value.map(info => info && ({ ...info, data: Buffer.from(info.data) })), [balance, token, user] = values;
    const ready = Boolean(user && user.owner.equals(program) && user.data.length === 128 && user.data.subarray(0, 8).equals(discriminator("account:User")) && user.data.subarray(8, 40).equals(owner.toBytes()) && user.data.subarray(40, 72).equals(new PublicKey(this.cfg.market).toBytes()) && user.data.subarray(80, 112).equals(vault.toBytes()));
    if (user && !ready) throw new FossaError("ACCOUNT_INVALID", "Fossa user account identity is invalid.");
    const counter = Buffer.alloc(8); if (ready) user!.data.copy(counter, 0, 112, 120);
    const validToken = token && token.owner.equals(TOKEN_PROGRAM_ID) && token.data.length === 165 && token.data.subarray(0, 32).equals(mint.toBytes()) && token.data.subarray(32, 64).equals(owner.toBytes());
    return { wallet: this.account.wallet, lane: this.account.lane, source: source.toBase58(), vault: vault.toBase58(), ready, lamports: String(balance?.lamports ?? 0), usdcAtomic: validToken ? token.data.readBigUInt64LE(64).toString() : "0", freeAtomic: ready ? user!.data.readBigUInt64LE(72).toString() : "0", generation: counter.readBigUInt64LE().toString(), slot: Number(result.context.slot), bookings: [...pool].flatMap((address, index) => { const value = values[index + 3]; if (!value || !value.lamports && !value.data.length) return []; if (!value.owner.equals(program) || value.data.length !== 520 || !value.data.subarray(0, 8).equals(discriminator("account:FilteredBooking")) || !value.data.subarray(8, 40).equals(owner.toBytes()) || !value.data.subarray(192, 224).equals(lane.toBytes())) throw new FossaError("ACCOUNT_INVALID", "Booking pool identity is invalid."); return [{ address, status: value.data[148], generation: value.data.readBigUInt64LE(152).toString(), rentPayer: new PublicKey(value.data.subarray(256, 288)).toBase58() }]; }) };
  }
  private async validateSnapshot(snapshot: WalletState) {
    const unsigned = (value: unknown) => typeof value === "string" && /^(0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
    if (!snapshot || snapshot.wallet !== this.account.wallet || snapshot.lane !== this.account.lane || !Number.isSafeInteger(snapshot.slot) || snapshot.slot < 0 || typeof snapshot.ready !== "boolean"
      || ![snapshot.lamports, snapshot.usdcAtomic, snapshot.freeAtomic, snapshot.generation].every(unsigned) || !Array.isArray(snapshot.bookings)
      || snapshot.bookings.some(booking => !booking || !Number.isInteger(booking.status) || booking.status < 0 || booking.status > 5 || !unsigned(booking.generation))) throw new FossaError("ACCOUNT_INVALID", "Fossa wallet snapshot is invalid or belongs to another account.");
    const addresses = await (this.walletAddresses ??= (async () => {
      const mint = new PublicKey(this.cfg.usdcMint), lane = new PublicKey(this.account.lane), owner = new PublicKey(this.account.wallet);
      const [authority] = await PublicKey.findProgramAddress([Buffer.from("vault"), lane.toBytes()], new PublicKey(this.cfg.programId));
      const [source, vault] = await Promise.all([getAssociatedTokenAddress(mint, owner), getAssociatedTokenAddress(mint, authority, true)]);
      return { source: source.toString(), vault: vault.toString() };
    })());
    if (snapshot.source !== addresses.source || snapshot.vault !== addresses.vault) throw new FossaError("ACCOUNT_INVALID", "Fossa wallet token accounts do not match the local signing identity.");
    const bookings = new Set<string>();
    for (const booking of snapshot.bookings) {
      new PublicKey(booking.address); new PublicKey(booking.rentPayer);
      if (bookings.has(booking.address)) throw new FossaError("ACCOUNT_INVALID", "Fossa wallet contains duplicate booking accounts.");
      bookings.add(booking.address);
    }
    return snapshot;
  }
  private get scope() { return this.cfg ? { program: this.cfg.programId, market: this.cfg.market, lane: this.account.lane, genesis: this.cfg.opencode.mainnetGenesisHash, mint: this.cfg.usdcMint } : undefined; }
  private rows(active = false) { return this.store.pending(this.account.wallet, this.scope, active); }
  private localRequest(id: string) { return this.store.request(id, this.account.wallet, this.scope); }
  private quote() {
    if (this.chain && Date.now() < this.chainUntil) return this.chain;
    throw new FossaError("CHAIN_SYNCING", "Fossa chain data is synchronizing. Try again shortly.");
  }
  private acceptFees(fees?: TransactionFees) {
    if (fees) { this.transactionFees = fees; this.feeVersion++; }
  }
  private async priority(units: number, signal?: AbortSignal) {
    try { return transactionPriority(units, this.transactionFees ?? this.wallet?.transactionFees!); } catch { /* refresh missing or invalid fee data before signing */ }
    const version = this.feeVersion;
    const snapshot = await api<WalletState>(this.account.apiUrl, "/opencode/wallet", { token: this.account.access, signal });
    if (snapshot.wallet !== this.account.wallet || snapshot.lane !== this.account.lane) throw new FossaError("ACCOUNT_INVALID", "Transaction fee snapshot belongs to another wallet.");
    if (version === this.feeVersion) this.acceptFees(snapshot.transactionFees);
    return transactionPriority(units, this.transactionFees!);
  }
  private availableWallet(): WalletState {
    if (!this.wallet) throw new FossaError("WALLET_SYNCING", "Wallet is synchronizing. Try again shortly.");
    const wallet = this.wallet, rows = this.store.accounting(this.account.wallet, wallet.slot, this.scope?.genesis), scope = this.scope;
    const sameLane = (row: Pending) => !scope || row.scope?.program === scope.program && row.scope.market === scope.market && row.scope.lane === scope.lane && row.scope.genesis === scope.genesis && row.scope.mint === scope.mint;
    let usdc = BigInt(wallet.usdcAtomic), free = BigInt(wallet.freeAtomic), lamports = BigInt(wallet.lamports), generation = BigInt(wallet.generation);
    if (scope) { const saved = this.store.generation(this.account.wallet, scope); if (saved > generation) generation = saved; }
    for (const row of rows) {
      if (row.processedSlot !== undefined && row.processedSlot <= wallet.slot) continue;
      lamports -= BigInt(row.feeLamports ?? "0") + BigInt(row.rentLamports ?? "0");
      const source = row.scope?.mint === scope?.mint && (!row.source || row.source === wallet.source);
      if (row.kind === "rakeback") {
        if (sameLane(row)) free += BigInt(row.refund ?? "0") - BigInt(row.withdrawal ?? "0");
        // an unobserved credit cannot fund another lane's new transaction.
        if (source && sameLane(row)) usdc += BigInt(row.withdrawal ?? "0");
      } else if (row.kind === "inference") {
        const deposit = BigInt(row.deposit ?? row.reserve);
        if (source) usdc -= deposit;
        if (sameLane(row)) free += deposit - BigInt(row.reserve);
      }
      if (!scope && BigInt(row.generation) > generation) generation = BigInt(row.generation);
    }
    const occupied = new Set([...this.rows(true), ...rows.filter(sameLane)].filter(row => row.kind === "inference").map(row => row.booking));
    return { ...wallet, usdcAtomic: String(usdc > 0n ? usdc : 0n), freeAtomic: String(free > 0n ? free : 0n), lamports: String(lamports > 0n ? lamports : 0n), generation: String(generation), bookings: wallet.bookings.filter(booking => !occupied.has(booking.address)) };
  }
  private broadcast(row: Pending) {
    if (this.broadcasts.has(row.id) || this.stopped) return;
    this.broadcasts.add(row.id);
    const started = performance.now();
    void this.rpc.sendRawTransaction(Buffer.from(row.transaction, "base64"), { skipPreflight: true, maxRetries: 0n }).then(() => {
      // rpc acknowledgement is timing data; it never gates inference or changes payment state.
      if (row.broadcastMs !== undefined) return;
      row.broadcastMs = Math.round(performance.now() - started);
      const current = this.store.request(row.id, row.wallet);
      if (current) this.store.put({ ...current, broadcastMs: row.broadcastMs });
    }).catch(() => { /* chain updates resolve uncertain transport outcomes */ }).finally(() => this.broadcasts.delete(row.id));
  }
  private submit(row: Pending) {
    this.store.put(row);
    this.progress(row.id, { stage: "broadcasting", signature: row.signature, message: "Broadcasting transaction…" });
    row.submittedAt = Date.now(); row.gapToSubmitMs = row.previousResponseFinishedAt === undefined ? undefined : row.submittedAt - row.previousResponseFinishedAt; row.stage = "sent"; this.store.put(row);
    this.broadcast(row);
    this.progress(row.id, { stage: "confirming", message: "Waiting for booking update…" });
  }
  private async signatureStatuses(signatures: string[], minimumSlot: number | bigint = 0) {
    const result = await this.rpc.getSignatureStatuses(signatures, { searchTransactionHistory: true });
    if (!validSlot(result?.context?.slot) || !validSlot(minimumSlot) || result.context.slot < minimumSlot || !Array.isArray(result?.value) || result.value.length !== signatures.length || result.value.some(status => status !== null && (!status || typeof status !== "object" || !("err" in status) || status.err !== null && (typeof status.err === "string" ? !status.err.length : typeof status.err !== "object" || Array.isArray(status.err) || !Object.keys(status.err).length) || !validSlot(status.slot) || status.slot > result.context.slot || !["processed", "confirmed", "finalized"].includes(status.confirmationStatus ?? "")))) throw Error("Invalid signature status response.");
    return result.value;
  }
  private async processed(row: Pending, signal?: AbortSignal, wake?: Promise<number>, confirmed = false) {
    let done = false, timeout: ReturnType<typeof setTimeout> | undefined;
    const cancelled = () => new FossaError("SUBMISSION_UNCERTAIN", `Request cancelled after signing. Transaction ${row.signature} must be reconciled before replacement.`);
    let abort = () => {};
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => reject(cancelled());
      if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
      timeout = setTimeout(() => reject(new FossaError("SUBMISSION_UNCERTAIN", `Transaction ${row.signature} is unresolved. Fossa will reuse its signed bytes, not create another payment.`)), this.cfg.opencode.requestTimeoutMs);
    });
    const poll = async (): Promise<number> => {
      // allow the indexed booking to arrive before any recovery rpc calls.
      if (wake) await Bun.sleep(Math.min(500, this.cfg.opencode.pollIntervalMs / 2));
      while (!done) {
        try {
          const [statuses, account] = await Promise.all([
            this.signatureStatuses([row.signature]),
            wake && row.kind === "inference" ? this.rpc.getAccountInfoAndContext(new PublicKey(row.booking), "processed").then(account => {
              if (!done && account.value?.owner.equals(new PublicKey(this.cfg.programId)) && account.value.data.length === 520 && account.value.data[148] === 0 && Buffer.from(account.value.data).readBigUInt64LE(152).toString() === row.generation) this.watchers.get(row.booking)?.(account.value, Number(account.context.slot), "rpc");
              return account;
            }) : undefined,
          ]);
          const [status] = statuses;
          if (done) return 0;
          if (status?.err && status.confirmationStatus === "finalized") { row.stage = "failed"; row.error = JSON.stringify(status.err, (_key, value) => typeof value === "bigint" ? value.toString() : value); this.store.put(row); throw new FossaError("TRANSACTION_FAILED", row.kind === "rakeback" ? `Rakeback transaction failed: ${row.signature}. No funds were moved.` : `Fossa transaction failed: ${row.signature}. No booking USDC was charged.`); }
          if (account?.value?.owner.equals(new PublicKey(this.cfg.programId)) && account.value.data.length === 520 && account.value.data[148] === 0 && Buffer.from(account.value.data).readBigUInt64LE(152).toString() === row.generation) {
            this.watchers.get(row.booking)?.(account.value, Number(account.context.slot), "rpc");
            return Number(account.context.slot);
          }
          if (!wake && status && !status.err && (!confirmed || status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) return Number(status.slot);
          if (!status) {
            const height = await this.rpc.getBlockHeight("finalized");
            if (done) return 0;
            if (!validSlot(height)) throw Error("Invalid finalized block height.");
            if (height > row.expiry + 5) {
              const blockhash = VersionedTransaction.deserialize(Buffer.from(row.transaction, "base64")).message.recentBlockhash;
              const validity = await this.rpc.isBlockhashValid(blockhash, { commitment: "finalized", minContextSlot: row.processedSlot });
              if (done) return 0;
              if (!validSlot(validity?.context?.slot) || validity.value !== false) throw Error("Signed transaction blockhash has not expired.");
              const currentValidity = await this.rpc.isBlockhashValid(blockhash, { commitment: "confirmed", minContextSlot: validity.context.slot });
              if (done) return 0;
              if (!validSlot(currentValidity?.context?.slot) || currentValidity.context.slot < validity.context.slot || currentValidity.value !== false) throw Error("Signed transaction blockhash is still usable.");
              const [current] = await this.signatureStatuses([row.signature], currentValidity.context.slot);
              if (done) return 0;
              if (current) {
                if (current.err && current.confirmationStatus === "finalized") { row.stage = "failed"; row.error = String(current.err); this.store.put(row); throw new FossaError("TRANSACTION_FAILED", `Fossa transaction failed: ${row.signature}.`); }
                if (!wake && !current.err && (!confirmed || current.confirmationStatus === "confirmed" || current.confirmationStatus === "finalized")) return Number(current.slot);
                continue;
              }
              row.stage = "expired"; this.store.put(row); throw new FossaError("TRANSACTION_EXPIRED", "Booking transaction expired without confirmation.");
            }
            this.broadcast(row);
          }
        } catch (error) { if (error instanceof FossaError) throw error; }
        if (!done) await Bun.sleep(this.cfg.opencode.pollIntervalMs / 4);
      }
      return 0;
    };
    try {
      const slot = await Promise.race([interrupted, ...(wake && !confirmed ? [wake] : []), poll()]);
      if (confirmed) row.confirmationMs = Date.now() - (row.submittedAt ?? row.created);
      else { row.processedMs ??= Date.now() - (row.submittedAt ?? row.created); row.bookingObservedAt ??= Date.now(); }
      return slot;
    } catch (error) {
      if (!terminal.has(row.stage)) { row.stage = "uncertain"; this.store.put(row); }
      throw error;
    } finally { done = true; clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
  }
  private assertJournalScope() {
    if (this.store.legacy(this.account.wallet).length) throw new FossaError("RECOVERY_PENDING", "An older transaction has unknown network or protocol bindings. Keep its journal and reconnect to its original network to confirm recovery before spending.");
  }
  private async adoptLegacy() {
    const scope = this.scope!;
    const rows = this.store.legacy(this.account.wallet).filter(row => row.scope?.program === scope.program && row.scope.market === scope.market && row.scope.lane === scope.lane && (!row.scope.genesis || row.scope.genesis === scope.genesis) && (!row.scope.mint || row.scope.mint === scope.mint));
    for (let offset = 0; offset < rows.length; offset += 256) {
      const batch = rows.slice(offset, offset + 256), statuses = await this.signatureStatuses(batch.map(row => row.signature));
      for (let index = 0; index < batch.length; index++) {
        const status = statuses[index];
        if (!status || !["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) continue;
        const row = batch[index]; row.scope = scope; row.processedSlot = Number(status.slot);
        if (status.err && status.confirmationStatus === "finalized") { row.stage = "failed"; row.error = String(status.err); }
        this.store.put(row);
      }
    }
  }
  private async journal(tx: Transaction, signers: Keypair[], fields: Omit<Pending, "signature" | "transaction" | "expiry" | "stage" | "created">, rent: number | bigint = 0, signal?: AbortSignal, compute?: BookingComputeState) {
    this.assertJournalScope();
    const quote = this.quote(); tx.feePayer = signers[0].publicKey; tx.recentBlockhash = quote.blockhash as NonNullable<Transaction["recentBlockhash"]>;
    signal?.throwIfAborted();
    const tables = fields.kind === "inference" ? await bookingLookupTables(this.rpc, this.cfg.providerLimitLookupTables) : [];
    const units = await sizeCompute(tx, this.rpc, this.wallet?.slot ?? 0, tables, compute);
    signal?.throwIfAborted();
    if (this.stopped) throw new FossaError("FOSSA_STOPPED", "Fossa connection closed.");
    const priority = await this.priority(units, signal);
    tx.instructions = tx.instructions.filter(ix => !ix.programId.equals(ComputeBudgetProgram.programId) || ix.data[0] !== 3);
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority.microLamports }));
    const cost = BigInt(quote.signatureFee) * BigInt(tx.compileMessage().header.numRequiredSignatures) + priority.lamports;
    const required = cost + BigInt(rent), balance = BigInt(this.availableWallet().lamports);
    if (balance < required) throw new FossaError("SOL_REQUIRED", `Add ${atomic(required - balance, 9)} SOL for ${rent ? "account rent and " : ""}transaction fees.`, { requiredLamports: required.toString() });
    signal?.throwIfAborted();
    if (this.stopped) throw new FossaError("FOSSA_STOPPED", "Fossa connection closed.");
    const transaction = compileBookingTransaction(tx, tables);
    await transaction.sign(signers);
    signal?.throwIfAborted();
    if (this.stopped) throw new FossaError("FOSSA_STOPPED", "Fossa connection closed.");
    const row: Pending = { ...fields, scope: this.scope, source: this.wallet?.source, rentLamports: String(rent), ...(fields.kind === "inference" ? { dispatchStarted: false } : {}), feeLamports: cost.toString(), prepareMs: fields.startedAt === undefined ? undefined : Date.now() - fields.startedAt, signature: bs58.encode(transaction.signatures[0]), transaction: Buffer.from(transaction.serialize()).toString("base64"), expiry: quote.lastValidBlockHeight, stage: "prepared", created: Date.now() };
    this.submit(row); return row;
  }
  private async setup(owner: Keypair, signal?: AbortSignal) {
    if (!this.wallet) throw Error("Wallet unavailable.");
    if (this.wallet.ready && this.wallet.bookings.length) return;
    const secrets = this.store.secrets(this.account.walletId), program = new PublicKey(this.cfg.programId), market = new PublicKey(this.cfg.market), lane = new PublicKey(this.account.lane), mint = new PublicKey(this.cfg.usdcMint);
    const authority = (await PublicKey.findProgramAddress([Buffer.from("vault"), lane.toBytes()], program))[0], vault = await getAssociatedTokenAddress(mint, authority, true);
    if (!this.wallet.ready) {
      if (!secrets.lane) throw new FossaError("ACCOUNT_PREPARING", "Fossa is preparing your website wallet accounts. Wait briefly, then try again.");
      const laneSigner = await Keypair.fromSecretKey(Uint8Array.from(secrets.lane));
      const [rent, tokenRent] = await Promise.all([this.rpc.getMinimumBalanceForRentExemption(128), this.rpc.getMinimumBalanceForRentExemption(165)]);
      const tx = new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, vault, authority, mint), ix(program, "initialize_user", Buffer.alloc(0), [meta(owner.publicKey, true, true), meta(market), meta(lane, true, true), meta(authority), meta(vault), meta(SystemProgram.programId)]));
      try { const row = await this.journal(tx, [owner, laneSigner], { id: randomUUID(), wallet: this.account.wallet, model: "", bodyHash: "", session: "", kind: "setup", booking: "", generation: "0", reserve: "0" }, rent + tokenRent, signal); const slot = await this.processed(row); row.processedSlot = slot; row.stage = "settled"; this.store.put(row); this.wallet = await this.snapshot(slot); } finally { laneSigner.secretKey.fill(0); }
    }
    for (const [address, bytes] of Object.entries(secrets.bookings)) {
      if (this.wallet.bookings.some(value => value.address === address)) continue;
      const quote = this.quote(), rent = BigInt(quote.bookingRent), booking = await Keypair.fromSecretKey(Uint8Array.from(bytes));
      const tx = new Transaction().add(ix(program, "initialize_receipt", Buffer.alloc(0), [meta(market), meta(lane), meta(owner.publicKey, false, true), meta(owner.publicKey, true, true), meta(booking.publicKey, true, true), meta(SystemProgram.programId)]));
      try { const row = await this.journal(tx, [owner, booking], { id: randomUUID(), wallet: this.account.wallet, model: "", bodyHash: "", session: "", kind: "setup", booking: address, generation: "0", reserve: "0" }, rent, signal); const slot = await this.processed(row); row.processedSlot = slot; row.stage = "settled"; this.store.put(row); this.wallet = await this.snapshot(slot); } finally { booking.secretKey.fill(0); }
    }
  }
  private inspect(info: AccountInfo<Uint8Array>, row: Pending, model: Pick<MarketModel, "address">) {
    const data = Buffer.from(info.data);
    if (!info.owner.equals(new PublicKey(this.cfg.programId)) || data.length !== 520 || !data.subarray(0, 8).equals(discriminator("account:FilteredBooking")) || !data.subarray(8, 40).equals(new PublicKey(this.account.wallet).toBytes()) || !data.subarray(72, 104).equals(new PublicKey(this.cfg.market).toBytes()) || !data.subarray(192, 224).equals(new PublicKey(this.account.lane).toBytes()) || !data.subarray(224, 256).equals(new PublicKey(model.address).toBytes()) || data.readBigUInt64LE(152).toString() !== row.generation || row.providerList && !data.subarray(320, 352).equals(new PublicKey(row.providerList).toBytes())) throw new FossaError("BOOKING_CHANGED", "Booking identity or generation changed. Reconcile before retrying.");
    return data;
  }
  private async rakebackFunds(): Promise<RakebackFunds> {
    const funds = await api<RakebackFunds>(this.account.apiUrl, "/opencode/funds", { token: this.account.access });
    if (this.account.rpcUrl) funds.free = (await this.snapshot()).freeAtomic;
    recoverable(funds); return funds;
  }
  async rakebackState(): Promise<RakebackState> {
    const funds = await this.rakebackFunds();
    return { ...this.store.rakeback(this.account.walletId).settings, availableAtomic: recoverable(funds).toString(), processing: this.raking, needsRecovery: this.store.legacy(this.account.wallet).length > 0 || this.rows(true).some(row => ["prepared", "sent", "uncertain"].includes(row.stage)), message: this.rakebackMessage };
  }
  async automaticRakeback() {
    if (this.stopped) return;
    const { settings, lastRun } = this.store.rakeback(this.account.walletId);
    if (this.stopped || this.raking || !settings.autoRakeback || !this.store.unlocked(this.account.walletId) || settings.rakebackMode === "interval" && Date.now() - lastRun < settings.rakebackIntervalMinutes * 60_000) return;
    if (this.rows(true).some(row => row.kind === "inference" && ["matched", "inference"].includes(row.stage) && Date.now() < (row.claimEnd ? row.claimEnd * 1000 : row.created + this.cfg.opencode.requestTimeoutMs))) return;
    try { await this.rakeback(true); } catch { /* rakeback state retains the actionable error for settings */ }
  }
  private recoverPending(): Promise<void> {
    if (this.stopped || !this.store.legacy(this.account.wallet).length && !this.rows(true).some(row => ["prepared", "sent", "uncertain", "reserved"].includes(row.stage))) return Promise.resolve();
    return this.recovering ??= this.store.exclusive(this.account.wallet, async () => {
      await this.reconcile(true);
      await this.refresh();
    }).catch(() => { /* retry pending recovery before the next request and on the maintenance timer */ }).finally(() => { this.recovering = undefined; });
  }
  private async reconcile(unresolvedOnly = false) {
    await this.adoptLegacy();
    await this.refresh();
    let amount = 0n; const signatures: string[] = [];
    for (const row of this.rows(true)) {
      if (terminal.has(row.stage) || unresolvedOnly && !["prepared", "sent", "uncertain", "reserved"].includes(row.stage)) continue;
      let slot: number;
      try { slot = await this.processed(row, undefined, undefined, true); }
      catch (error) { if (error instanceof FossaError && ["TRANSACTION_FAILED", "TRANSACTION_EXPIRED"].includes(error.code)) continue; throw error; }
      row.processedSlot = slot;
      if (row.kind !== "inference") {
        row.stage = "settled"; this.store.put(row);
        if (row.kind === "rakeback") { amount += BigInt(row.withdrawal ?? "0"); signatures.push(row.signature); }
        this.wallet = await this.snapshot(slot); continue;
      }
      const info = await this.rpc.getAccountInfo(new PublicKey(row.booking), { commitment: "confirmed", minContextSlot: slot });
      if (!info) throw new FossaError("RECOVERY_PENDING", "Booking recovery is waiting for chain state.");
      const data = this.bookingData(info);
      const current = this.localRequest(row.id);
      if (!current || current.stage !== row.stage || current.dispatchStarted !== row.dispatchStarted || current.providerRequestMs !== row.providerRequestMs) continue;
      const generation = data.readBigUInt64LE(152);
      if (generation < BigInt(row.generation)) throw new FossaError("RECOVERY_PENDING", "Booking state is still synchronizing.");
      if (generation > BigInt(row.generation)) row.stage = "released";
      else if (data[148] !== 0) { row.charge = data.readBigUInt64LE(160).toString(); row.stage = BigInt(row.charge) ? "settled" : "released"; }
      // confirmed, undispatched reservations occupy storage and funds without blocking other chats.
      else if (row.dispatchStarted === false || row.dispatchStarted === undefined && !row.provider && !row.endpoint && row.providerRequestMs === undefined) row.stage = "reserved";
      this.store.put(row);
      if (row.cancelRequested && data[148] === 0 && generation === BigInt(row.generation)) {
        const provider = new PublicKey(data.subarray(40, 72)).toString();
        const model = this.catalog?.models.find(model => model.id === row.model);
        const offer = model?.offers.find(offer => offer.provider.wallet === provider && (data[356] === 3 ? offer.providerLimitId === data.readUInt32LE(352) : data[356] === 2 || offer.slot === data.readUInt32LE(352)));
        const endpoint = row.provider === provider && row.endpoint ? row.endpoint : offer?.provider.endpoint;
        if (endpoint) {
          const address = model?.address ?? (await PublicKey.findProgramAddress([Buffer.from("model"), new PublicKey(this.cfg.market).toBytes(), createHash("sha256").update(row.model).digest()], new PublicKey(this.cfg.programId)))[0].toString();
          this.inspect(info, row, { address });
          this.store.put({ ...row, provider, endpoint: safeUrl(endpoint) });
          await this.cancel(row.id).catch(() => {});
        }
      }
    }
    return { amount, signatures };
  }
  private bookingData(info: AccountInfo<Uint8Array>) {
    const data = Buffer.from(info.data);
    if (!info.owner.equals(new PublicKey(this.cfg.programId)) || data.length !== 520 || !data.subarray(0, 8).equals(discriminator("account:FilteredBooking")) || !data.subarray(8, 40).equals(new PublicKey(this.account.wallet).toBytes()) || !data.subarray(72, 104).equals(new PublicKey(this.cfg.market).toBytes()) || !data.subarray(192, 224).equals(new PublicKey(this.account.lane).toBytes())) throw new FossaError("ACCOUNT_INVALID", "Rakeback booking does not belong to this wallet and market.");
    if (data[356] !== 0 && data[356] !== 2 && data[356] !== 3) throw new FossaError("ACCOUNT_INVALID", "Unsupported booking quota marker.");
    return data;
  }
  rakeback(automatic = false) {
    if (this.raking) return Promise.resolve({ kind: "busy", amountAtomic: "0", signatures: [] as string[] });
    return this.rakebackRunning = this.runRakeback(automatic).finally(() => { this.rakebackRunning = undefined; });
  }
  private async runRakeback(automatic: boolean) {
    this.raking = true; this.rakebackMessage = "Processing rakeback…"; this.changed();
    try {
      return await this.store.exclusive(this.account.wallet, async () => {
        if (this.stopped) throw new FossaError("RAKEBACK_STOPPED", "Fossa connection closed. Reopen Rakeback after reconnecting.");
        const { settings, lastRun } = this.store.rakeback(this.account.walletId);
        if (automatic && (!settings.autoRakeback || settings.rakebackMode === "interval" && Date.now() - lastRun < settings.rakebackIntervalMinutes * 60_000)) { this.rakebackMessage = ""; return { kind: "inactive", amountAtomic: "0", signatures: [] }; }
        const previous = await this.reconcile(), funds = await this.rakebackFunds();
        const threshold = automatic && settings.rakebackMode === "amount" ? BigInt(settings.rakebackThresholdAtomic) : 1n;
        const finish = (amount: bigint, signatures: string[]) => {
          this.store.rakebackRan(this.account.walletId);
          this.rakebackMessage = amount ? `Recovered ${rakebackDollars(amount.toString())}.` : automatic && threshold > 1n ? `Waiting for ${rakebackDollars(threshold.toString())}.` : "No funds available yet.";
          return { kind: amount ? "complete" : "empty", amountAtomic: amount.toString(), signatures };
        };
        if (recoverable(funds) < threshold) return finish(previous.amount, previous.signatures);
        this.wallet = await this.snapshot();
        const program = new PublicKey(this.cfg.programId), market = new PublicKey(this.cfg.market), lane = new PublicKey(this.account.lane), mint = new PublicKey(this.cfg.usdcMint);
        const owner = await Keypair.fromSecretKey(Uint8Array.from(this.store.secrets(this.account.walletId).owner));
        try {
          const tx = new Transaction();
          let refunded = 0n, released = 0;
          const bookings: { address: string; generation: string }[] = [];
          for (const candidate of funds.bookings) {
            if (released === 2) break;
            const address = new PublicKey(candidate.address), info = await this.rpc.getAccountInfo(address, "confirmed");
            if (!info) continue;
            const data = this.bookingData(info), generation = data.readBigUInt64LE(152);
            if (data[148] !== 0 || generation.toString() !== candidate.generation || Number(data.readBigInt64LE(132)) + 15 >= Date.now() / 1000) continue;
            const model = new PublicKey(data.subarray(224, 256)), record = await this.rpc.getAccountInfo(model, "confirmed");
            if (!record || !record.owner.equals(program) || record.data.length !== 176 || !Buffer.from(record.data).subarray(0, 8).equals(discriminator("account:Model")) || !Buffer.from(record.data).subarray(8, 40).equals(market.toBytes())) throw new FossaError("ACCOUNT_INVALID", "Rakeback model is unavailable or invalid.");
            const marker = data[356];
            const capacity = marker === 3 ? await providerLimitPageAddress(program, market, data.readUInt32LE(352) & 31) : marker === 2 ? (await listRoutingAddresses(program, new PublicKey(data.subarray(320, 352)), model)).capacity : new PublicKey(record.data.subarray(104, 136));
            const wallet = marker >= 2 ? await providerWalletAddress(program, market, owner.publicKey) : program;
            tx.add(ix(program, marker >= 2 ? "expire_list_booking" : "expire_booking", Buffer.concat([Buffer.from([1]), data.subarray(152, 160)]), [meta(market), meta(model), meta(capacity, true), meta(lane, true), meta(address, true), ...(marker >= 2 ? [meta(wallet, true)] : [])]));
            refunded += data.readBigUInt64LE(104); released++; bookings.push({ address: candidate.address, generation: candidate.generation });
          }
          const laneInfo = await this.rpc.getAccountInfo(lane, "confirmed"), vault = new PublicKey(this.wallet.vault);
          if (!laneInfo || !laneInfo.owner.equals(program) || laneInfo.data.length !== 128 || !Buffer.from(laneInfo.data).subarray(0, 8).equals(discriminator("account:User")) || !Buffer.from(laneInfo.data).subarray(8, 40).equals(owner.publicKey.toBytes()) || !Buffer.from(laneInfo.data).subarray(40, 72).equals(market.toBytes()) || !Buffer.from(laneInfo.data).subarray(80, 112).equals(vault.toBytes())) throw new FossaError("ACCOUNT_INVALID", "Rakeback wallet account is invalid.");
          const amount = Buffer.from(laneInfo.data).readBigUInt64LE(72) + refunded;
          if (!amount) return finish(previous.amount, previous.signatures);
          const source = await getAssociatedTokenAddress(mint, owner.publicKey), authority = (await PublicKey.findProgramAddress([Buffer.from("vault"), lane.toBytes()], program))[0];
          let rent = 0n;
          if (!await this.rpc.getAccountInfo(source, "confirmed")) { rent = await this.rpc.getMinimumBalanceForRentExemption(165); tx.add(createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, source, owner.publicKey, mint)); }
          const payload = Buffer.alloc(8); payload.writeBigUInt64LE(amount);
          tx.add(ix(program, "withdraw", payload, [meta(market), meta(lane, true), meta(owner.publicKey, false, true), meta(vault, true), meta(source, true), meta(mint), meta(authority), meta(TOKEN_PROGRAM_ID)]));
          if (this.stopped || automatic && !this.store.rakeback(this.account.walletId).settings.autoRakeback) throw new FossaError("RAKEBACK_STOPPED", "Automatic rakeback stopped before signing.");
          const row = await this.journal(tx, [owner], { id: randomUUID(), wallet: this.account.wallet, model: "", bodyHash: "", session: "", kind: "rakeback", booking: "", generation: "0", reserve: "0", withdrawal: amount.toString(), refund: refunded.toString() }, rent);
          row.processedSlot = await this.processed(row, undefined, undefined, true); row.stage = "settled"; this.store.put(row);
          for (const pending of this.rows(true)) if (pending.kind === "inference" && bookings.some(booking => booking.address === pending.booking && booking.generation === pending.generation)) { pending.stage = "released"; this.store.put(pending); }
          try { this.wallet = await this.snapshot(row.processedSlot); this.walletAt = Date.now(); } catch { /* journal overlays protect balances until live state catches up */ }
          void this.refresh().catch(() => {});
          return finish(previous.amount + amount, [...previous.signatures, row.signature]);
        } finally { owner.secretKey.fill(0); }
      });
    } catch (error) { this.rakebackMessage = error instanceof Error ? error.message : "Rakeback failed."; throw error; }
    finally { this.raking = false; this.changed(); }
  }
  async request(callId: string, modelId: string, body: string, session: string, kind: string, signal: AbortSignal, timing: { modelRequestAt?: number; transportReceivedAt?: number } = {}) {
    signal.throwIfAborted();
    const canonical = this.catalog?.aliases?.[modelId], savedRequest = this.localRequest(callId);
    if (canonical && (!savedRequest || savedRequest.model === canonical)) { const parsed = JSON.parse(body); if (parsed.model === modelId) { parsed.model = canonical; body = JSON.stringify(parsed); } modelId = canonical; }
    const startedAt = Date.now();
    const previousRequest = this.store.previousInference(callId, this.account.wallet, session, kind, this.scope);
    const previousResponseFinishedAt = previousRequest?.responseFinishedAt;
    const gap = (timing.modelRequestAt ?? startedAt) - (previousResponseFinishedAt ?? Infinity);
    const requestTiming = { ...timing, previousRequestId: previousRequest?.id, ...(gap >= 0 ? { previousResponseFinishedAt, requestGapMs: gap } : {}) };
    let recoveryWaitMs = 0, admissionWaitMs = 0, bookingPoolWaitMs = 0;
    if (kind === "primary") this.publish({ requestId: callId, sessionID: session, model: modelId, provider: undefined, signature: undefined, booking: undefined, stage: "synchronizing", message: "Checking wallet and providers…" });
    if (Buffer.byteLength(body) > this.cfg.opencode.maxRequestBytes) throw new FossaError("REQUEST_TOO_LARGE", "Request exceeds Fossa payload limit.");
    const hash = digest(body);
    const previous = this.localRequest(callId);
    if (previous) {
      if (previous.cancelRequested) throw new FossaError("REQUEST_CANCELLED", "This request was cancelled. Payment is recovering automatically.");
      if (previous.bodyHash !== hash || previous.model !== modelId) throw new FossaError("REQUEST_CHANGED", "A retry changed the signed request body.");
      if (terminal.has(previous.stage)) throw new FossaError("REQUEST_COMPLETED", "This Fossa request already completed. Its payment will not be repeated.");
      if (previous.provider && previous.endpoint) return this.authorize(previous, body);
      throw new FossaError("SUBMISSION_UNCERTAIN", "Existing booking is unresolved. Use /fossa to recover it.");
    }
    return this.store.exclusive(this.account.wallet, async () => {
      const walletLockMs = Date.now() - startedAt;
      await this.adoptLegacy(); this.assertJournalScope();
      signal.throwIfAborted();
      const existing = this.localRequest(callId);
      if (existing) {
        if (existing.cancelRequested) throw new FossaError("REQUEST_CANCELLED", "This request was cancelled. Payment is recovering automatically.");
        if (existing.bodyHash !== hash || existing.model !== modelId) throw new FossaError("REQUEST_CHANGED", "A concurrent retry changed the request body.");
        if (terminal.has(existing.stage)) throw new FossaError("REQUEST_COMPLETED", "This request already completed.");
        if (existing.provider && existing.endpoint) return this.authorize(existing, body);
        throw new FossaError("SUBMISSION_UNCERTAIN", "Existing booking is unresolved. Use /fossa to recover it.");
      }
      if (this.socket?.readyState !== WebSocket.OPEN || Date.now() - this.walletAt > this.cfg.opencode.catalogMaxAgeMs) throw new FossaError("WALLET_SYNCING", "Live wallet data is synchronizing. Try again shortly.");
      this.quote();
      if (!this.catalog?.ready || Date.now() - this.catalogAt > this.cfg.opencode.catalogMaxAgeMs) throw new FossaError("CATALOG_STALE", "Fossa catalog is synchronizing. No payment submitted.");
      let model = this.catalog.models.find(model => model.id === modelId);
      if (!model) throw new FossaError("MODEL_UNAVAILABLE", "Selected Fossa model is unavailable.");
      const parsed = JSON.parse(body) as { messages: unknown[]; tools?: unknown[]; response_format?: unknown; max_tokens?: number; max_completion_tokens?: number };
      const settings = this.settings(modelId), requirements = routingRequirements(model, settings);
      if (!requirements.checkpoint) throw new FossaError("NO_PROVIDER", "No provider matches this model’s published version.");
      if (Array.isArray(parsed.messages) && parsed.messages.some((message: any) => Array.isArray(message?.content) && message.content.some((part: any) => part?.type === "image_url"))) requirements.inputModalities |= 2;
      const candidates = model.offers.filter(offer => offer.active && offerFits(offer, requirements));
      const context = Math.max(0, ...candidates.map(offer => offer.contextTokens)), inputCap = Math.max(0, ...candidates.map(offer => offer.inputBoundTokens)), outputCap = Math.max(0, ...candidates.map(offer => offer.outputTokens));
      const requiredInput = inputBound(parsed, context), maxInput = settings.advancedRouting && settings.maxInputTokens != null ? settings.maxInputTokens : requiredInput;
      const requestedOutput = parsed.max_tokens ?? parsed.max_completion_tokens, maxOutput = settings.advancedRouting && settings.maxOutputTokens != null ? settings.maxOutputTokens : requestedOutput;
      if (!Array.isArray(parsed.messages) || !Number.isSafeInteger(maxOutput) || !maxOutput || maxOutput < 1 || maxOutput > outputCap || requiredInput > maxInput || maxInput > Math.min(inputCap, this.cfg.opencode.maxInputTokens) || maxInput + maxOutput > context || !Number.isSafeInteger(requestedOutput) || !requestedOutput || requestedOutput > maxOutput) throw new FossaError("TOKEN_LIMIT", "Request exceeds eligible provider token bounds. Reduce context or output limit before retrying.");
      validateBody(parsed, { maxInput, maxOutput, claimEnd: Number.MAX_SAFE_INTEGER }, { model: model.id, speed_tps: 1, context_tokens: context, max_input_bound: inputCap, output_tokens: outputCap, tools: model.capabilities?.tools === true, input: candidates.flatMap(offer => offer.modalities.input), effort: model.variants?.map(variant => variant.body.reasoning_effort) ?? model.effort });
      if (this.rows(true).some(row => ["prepared", "sent", "uncertain"].includes(row.stage))) {
        const recoveryAt = Date.now();
        await this.reconcile(true);
        recoveryWaitMs += Date.now() - recoveryAt;
        if (this.rows(true).some(row => ["prepared", "sent", "uncertain"].includes(row.stage))) throw new FossaError("RECOVERY_PENDING", "Previous payment is recovering automatically. Try again once its release is confirmed.");
      }
      const estimatedInput = Math.min(maxInput, Math.ceil(Buffer.byteLength(body) / 4)), estimatedOutput = Math.min(requestedOutput, 256);
      const prefix = (messages: number) => digest(JSON.stringify({ ...parsed, checkpoint: requirements.checkpoint, messages: parsed.messages.slice(0, messages) }));
      let prior: Pending | undefined;
      const prefixes = new Map<number, string>();
      for (const saved of this.store.cacheHistory(this.account.wallet, session, kind, modelId, this.scope)) {
        const row = JSON.parse((saved as { state: string }).state) as Pending;
        if (row.checkpoint !== requirements.checkpoint || !row.provider || !row.usage || !row.cache || row.cache.messages > parsed.messages.length) continue;
        if (!prefixes.has(row.cache.messages)) prefixes.set(row.cache.messages, prefix(row.cache.messages));
        if (row.cache.prefix === prefixes.get(row.cache.messages)) { prior = row; break; }
      }
      const continued = prior && parsed.messages.slice(prior.cache!.messages).some(message => message && typeof message === "object" && "role" in message && message.role === "assistant");
      const cached = prior ? Math.min(estimatedInput, prior.usage!.input + (continued ? prior.usage!.output : 0), Math.ceil(Buffer.byteLength(JSON.stringify(parsed.messages.slice(0, Math.max(prior.cache!.messages, parsed.messages.length - 1)))) / 4)) : 0;
      const estimate = { input: estimatedInput, cached, output: estimatedOutput, provider: prior?.provider };
      let ranked = rankOffers(eligible(model, settings, maxInput, maxOutput, requirements), settings, estimate);
      const admissionAt = Date.now(), admissionDeadline = admissionAt + this.cfg.opencode.requestTimeoutMs;
      let refresh = true;
      while (!ranked.length && settling(model, settings, maxInput, maxOutput, requirements) && Date.now() < admissionDeadline) {
        signal.throwIfAborted();
        if (this.stopped) throw new FossaError("FOSSA_STOPPED", "Fossa connection closed.");
        this.progress(callId, { stage: "settling", message: "Waiting for provider capacity…" });
        if (refresh) { const version = this.catalogVersion; this.updateCatalog(await api<Catalog>(this.account.apiUrl, "/market/catalog", { signal }), version); }
        model = this.catalog.models.find(value => value.id === modelId);
        if (!model) throw new FossaError("MODEL_UNAVAILABLE", "Selected Fossa model is unavailable.");
        ranked = rankOffers(eligible(model, settings, maxInput, maxOutput, requirements), settings, estimate);
        if (!ranked.length && settling(model, settings, maxInput, maxOutput, requirements)) refresh = !await this.waitForCatalog(signal, admissionDeadline);
      }
      signal.throwIfAborted();
      if (this.stopped) throw new FossaError("FOSSA_STOPPED", "Fossa connection closed.");
      this.quote();
      admissionWaitMs = Date.now() - admissionAt;
      const best = ranked[0];
      if (best) { requirements.checkpoint = best.checkpoint; requirements.allowUnversioned = false; }
      const minSpeed = settings.mode === "cheapest" ? settings.minSpeed : Math.max(settings.minSpeed, best?.speed ?? 0);
      const listFeeBps = this.catalog.providerListFeeBps;
      if (!Number.isInteger(listFeeBps) || listFeeBps! < 10 || listFeeBps! > 300 || model.group === undefined) throw new FossaError("CONFIGURATION", "Refresh Fossa protocol configuration before signing.");
      const withListFee = (base: bigint) => base + (base * BigInt(listFeeBps!) + 9999n) / 10000n;
      const maxSpend = best ? withListFee(fee(maxInput, best.inputRate) + fee(maxOutput, best.outputRate) + 1n) : 0n;
      const offers = ranked.filter(offer => offer.checkpoint === requirements.checkpoint && offer.speed >= minSpeed && withListFee(fee(maxInput, offer.inputRate) + fee(maxOutput, offer.outputRate) + 1n) <= maxSpend);
      if (!offers.length) { const reason = unavailable(model, settings, maxInput, maxOutput); throw new FossaError("NO_PROVIDER", reason.message, { ...reason.data, catalogSlot: this.catalog.slot }); }
      const reserve = offers.reduce((max, offer) => { const value = withListFee(fee(maxInput, offer.inputRate) + fee(maxOutput, offer.outputRate) + 1n); return value > max ? value : max; }, 0n);
      let wallet = this.availableWallet();
      const total = BigInt(wallet.usdcAtomic) + BigInt(wallet.freeAtomic);
      if (total < reserve) throw new FossaError("USDC_REQUIRED", `Add ${atomic(reserve - total)} USDC to ${this.account.wallet} to cover this request's maximum reservation.`, { shortfallAtomic: (reserve - total).toString(), wallet: this.account.wallet });
      const owner = await Keypair.fromSecretKey(Uint8Array.from(this.store.secrets(this.account.walletId).owner));
      try {
        this.progress(callId, { stage: "synchronizing", message: "Preparing wallet accounts…", model: modelId });
        await this.setup(owner, signal);
        for (let attempt = 0; attempt < 2; attempt++) {
          wallet = this.availableWallet();
          let free = wallet.bookings.find(value => value.status === 5);
          const poolAt = Date.now(), poolDeadline = poolAt + this.cfg.opencode.requestTimeoutMs;
          while (!free && Date.now() < poolDeadline) {
            signal.throwIfAborted(); this.progress(callId, { stage: "settling", message: "Waiting for a provider to release reusable booking storage…" });
            if (this.stopped) throw new FossaError("FOSSA_STOPPED", "Fossa connection closed.");
            if (!await this.waitForUpdate(this.walletWaiters, signal, poolDeadline, Math.min(1000, this.cfg.opencode.pollIntervalMs))) await this.refresh();
            wallet = this.availableWallet(); free = wallet.bookings.find(value => value.status === 5);
          }
          bookingPoolWaitMs += Date.now() - poolAt;
          signal.throwIfAborted();
          if (this.stopped) throw new FossaError("FOSSA_STOPPED", "Fossa connection closed.");
          if (!free) throw new FossaError("BOOKING_POOL_BUSY", "Providers have not released booking storage yet. Open /fossa → Rakeback to recover expired reservations.");
          const remaining = BigInt(wallet.usdcAtomic) + BigInt(wallet.freeAtomic);
          if (remaining < reserve) throw new FossaError("USDC_REQUIRED", `Add ${atomic(reserve - remaining)} USDC to cover this request's maximum reservation.`);
          const generation = (BigInt(wallet.generation) > BigInt(free.generation) ? BigInt(wallet.generation) : BigInt(free.generation)) + 1n;
          const deposit = reserve > BigInt(wallet.freeAtomic) ? reserve - BigInt(wallet.freeAtomic) : 0n;
          const program = new PublicKey(this.cfg.programId), market = new PublicKey(this.cfg.market), lane = new PublicKey(this.account.lane), mint = new PublicKey(this.cfg.usdcMint);
          if (!Number.isSafeInteger(model.offerCount) || model.offerCount < model.offers.length || model.offerCount > 4096) throw new FossaError("CONFIGURATION", "Fossa model book size is invalid.");
          const tx = new Transaction();
          if (deposit) { const amount = Buffer.alloc(8); amount.writeBigUInt64LE(deposit); tx.add(ix(program, "deposit", amount, [meta(market), meta(lane, true), meta(owner.publicKey, false, true), meta(new PublicKey(wallet.source), true), meta((await PublicKey.findProgramAddress([Buffer.from("vault"), lane.toBytes()], program))[0]), meta(new PublicKey(wallet.vault), true), meta(mint), meta(TOKEN_PROGRAM_ID)])); }
          const scoped = this.catalog.listRoutingEnabled === true;
          const limitsPages = this.catalog.providerLimitsEnabled ? await providerLimitPages(program, market, model.offers) : [];
          if (!scoped && requirements.requiredConcurrency !== 1) throw new FossaError("CONFIGURATION", "Concurrency routing is not enabled for this market.");
          const list = new PublicKey(this.cfg.providerList), scopedKeys = scoped ? await listRoutingAddresses(program, list, new PublicKey(model.address)) : undefined;
          if (scopedKeys && (model.terms !== scopedKeys.terms.toString() || model.capacity !== scopedKeys.capacity.toString() || this.catalog.listRouting !== undefined && this.catalog.listRouting !== scopedKeys.routing.toString())) throw new FossaError("CONFIGURATION", "Invalid list routing accounts.");
          const ledger = scoped ? await prepareProviderWallet(program, market, owner.publicKey, async address => (this.account.rpcUrl ? undefined : cachedProviderWallet(wallet.providerWallet, address, wallet.slot)) ?? await this.rpc.getAccountInfo(address, "processed")) : undefined;
          let ledgerRent = 0n;
          if (ledger?.rentSize) {
            const rent = BigInt(await this.rpc.getMinimumBalanceForRentExemption(ledger.rentSize));
            const previous = ledger.previousSize ? BigInt(await this.rpc.getMinimumBalanceForRentExemption(ledger.previousSize)) : 0n;
            ledgerRent = rent > previous ? rent - previous : 0n;
          }
          if (ledger?.instructions.length) tx.add(...ledger.instructions);
          const compute = limitsPages.length && ledger ? { offers: model.offerCount, pages: limitsPages.length, walletEntries: ledger.entries, walletBump: ledger.bump, initializeWallet: Boolean(ledger.rentSize && !ledger.previousSize), growWallet: Boolean(ledger.previousSize), deposit: deposit > 0n } : undefined;
          const payload = Buffer.alloc(scoped ? requirements.requiredConcurrency === 1 ? 156 : 160 : 155); createHash("sha256").update(modelId).digest().copy(payload);
          priceFields.forEach((field, index) => payload.writeUInt32LE(settings[field] === undefined ? 0xffffffff : Math.floor(settings[field]! * 1_000_000), 32 + index * 4));
          payload.writeUInt16LE(minSpeed, 44); payload.writeUInt32LE(maxInput, 46); payload.writeUInt32LE(maxOutput, 50); payload[54] = settings.zdrOnly ? 1 : 0;
          payload.writeBigUInt64LE(reserve, 55); payload.writeUInt32LE(estimatedInput, 63); payload.writeUInt32LE(cached, 67); payload.writeUInt32LE(estimatedOutput, 71);
          Buffer.from(requirements.checkpoint, "hex").copy(payload, 107); payload[139] = requirements.inputModalities; payload[140] = requirements.outputModalities;
          payload.writeUInt32LE(requirements.minContext, 141); payload[145] = Number(requirements.limitsConfigured); payload[146] = 1; payload.writeBigUInt64LE(generation, 147);
          if (prior) Buffer.from(new PublicKey(prior.provider!).toBytes()).copy(payload, 75);
          if (scoped && requirements.requiredConcurrency !== 1) { payload[155] = 1; payload.writeUInt32LE(requirements.requiredConcurrency, 156); }
          tx.add(ix(program, scoped ? "reserve_list_booking" : "reserve_booking", payload, [meta(market), meta(new PublicKey(model.address)), meta(new PublicKey(model.terms)), meta(limitsPages[0] ?? new PublicKey(model.capacity), true), meta(lane, true), meta(owner.publicKey, false, true), meta(new PublicKey(free.address), true), meta(new PublicKey(free.rentPayer)), meta(list), ...(scopedKeys && ledger ? [meta(scopedKeys.routing), meta(ledger.address, true)] : []), meta(model.group ? new PublicKey(model.group) : program), ...limitsPages.slice(1).map(page => meta(page, true))]));
          this.progress(callId, { stage: "booking", message: `Preparing transaction · reserving up to ${atomic(reserve)} USDC…`, booking: free.address }); signal.throwIfAborted();
          let observed: { info: AccountInfo<Uint8Array>; slot: number; source: "stream" | "rpc" } | undefined, wake!: (slot: number) => void;
          const changed = new Promise<number>(resolve => { wake = resolve; });
          const watch = (info: AccountInfo<Uint8Array> | null, slot: number, source: "stream" | "rpc" = "stream") => { if (info?.owner.equals(program) && info.data.length === 520 && info.data[148] === 0 && Buffer.from(info.data).readBigUInt64LE(152) === generation) { observed = { info, slot, source }; wake(slot); } };
          this.watchers.set(free.address, watch);
          if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ watch: free.address }));
          let row: Pending, slot: number, info: AccountInfo<Uint8Array> | null;
          try {
            row = await this.journal(tx, [owner], { id: callId, wallet: this.account.wallet, model: modelId, checkpoint: requirements.checkpoint, bodyHash: hash, providerList: this.cfg.providerList, cache: { messages: parsed.messages.length, prefix: prefix(parsed.messages.length) }, session, kind: "inference", flow: kind, booking: free.address, generation: generation.toString(), reserve: reserve.toString(), deposit: deposit.toString(), startedAt, ...requestTiming, walletLockMs, recoveryWaitMs, admissionWaitMs, bookingPoolWaitMs }, ledgerRent, signal, compute);
            slot = await this.processed(row, signal, changed);
            row.processedSlot = slot; this.store.put(row);
            this.progress(callId, { stage: "matched", message: "Transaction confirmed · matching provider…" });
            row.bookingSource = observed && observed.slot >= slot ? observed.source : "rpc";
            info = observed && observed.slot >= slot ? observed.info : await this.rpc.getAccountInfo(new PublicKey(row.booking), { commitment: "processed", minContextSlot: slot });
          } catch (error) {
            const failed = this.localRequest(callId);
            if (attempt === 0 && error instanceof FossaError && error.code === "TRANSACTION_FAILED" && failed?.stage === "failed" && /"Custom":(?:2|"2")(?=[,}])/.test(failed.error ?? "")) {
              const fresh = await this.snapshot(0, true);
              if (!fresh.bookings.some(item => item.address === free.address)) {
                this.store.archiveFailed(failed);
                this.wallet = fresh; this.walletAt = Date.now();
                this.progress(callId, { stage: "synchronizing", message: "Refreshing reusable booking storage…" });
                continue;
              }
            }
            throw error;
          } finally {
            this.watchers.delete(free.address);
            if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ unwatch: free.address }));
          }
          if (!info) throw new FossaError("SUBMISSION_UNCERTAIN", "Booking processed but account view is unavailable.");
          const data = this.inspect(info, row, model);
          if (data[148] !== 0 || data[356] !== (this.catalog.providerLimitsEnabled ? 3 : scoped ? 2 : 0)) throw new FossaError("BOOKING_CHANGED", "Booking is no longer available for inference.");
          const provider = new PublicKey(data.subarray(40, 72)).toBase58(), offer = offers.find(offer => offer.provider.wallet === provider && (data[356] === 3 ? offer.providerLimitId === data.readUInt32LE(352) : data[356] === 2 || offer.slot === data.readUInt32LE(352)));
          if (!offer?.provider.endpoint || data.readBigUInt64LE(104) > reserve
            || !data.subarray(472, 504).equals(Buffer.from(requirements.checkpoint, "hex")) || data.readUInt32LE(504) < Math.max(requirements.minContext, maxInput + maxOutput)
            || data.readUInt32LE(508) < maxInput || data.readUInt32LE(512) < maxOutput
            || (data[516] & requirements.inputModalities) !== requirements.inputModalities || (data[517] & requirements.outputModalities) !== requirements.outputModalities
            || data[518] !== requirements.inputModalities || data[519] !== requirements.outputModalities) throw new FossaError("BOOKING_CHANGED", "Matched provider does not satisfy the authorized request.");
          row.provider = provider; row.providerName = offer.provider.name; row.endpoint = safeUrl(offer.provider.endpoint, "provider endpoint"); row.reserve = data.readBigUInt64LE(104).toString(); row.claimEnd = Number(data.readBigInt64LE(132)); row.stage = "matched"; this.store.put(row);
          this.progress(callId, { stage: "matched", provider: offer.provider.name, message: `Matched ${offer.provider.name}` });
          void this.refresh().catch(() => {});
          signal.throwIfAborted();
          return this.authorize(row, body);
        }
        throw new FossaError("BOOKING_POOL_BUSY", "Reusable booking storage is synchronizing.");
      } finally { owner.secretKey.fill(0); }
    });
  }
  private signedHeaders(row: Pending, hash: string) {
    const secrets = this.store.secrets(this.account.walletId), secret = Uint8Array.from(secrets.owner);
    const message = Buffer.from(`fossa-infer-v2:${this.cfg.programId}:${this.cfg.market}:${row.booking}:${row.generation}:${row.provider}:${hash}`);
    try { return new Headers({ "content-type": "application/json", "x-fossa-booking": row.booking, "x-fossa-user": this.account.wallet, "x-fossa-signature": signMessage(message, secret).toString("base64"), "x-fossa-body-sha256": hash, "x-fossa-generation": row.generation, "x-fossa-call-id": row.id }); }
    finally { secret.fill(0); }
  }
  private authorize(row: Pending, body: string) {
    const headers = this.signedHeaders(row, row.bodyHash);
    row.stage = "inference"; this.store.put(row); this.progress(row.id, { stage: "streaming", message: `Waiting for ${this.status.provider ?? "provider"}…` });
    return { url: row.endpoint!, headers, body, deadline: row.claimEnd ? row.claimEnd * 1000 : row.created + this.cfg.opencode.requestTimeoutMs };
  }
  cancel(id: string) {
    const running = this.cancellations.get(id); if (running) return running;
    const work = this.cancelRequest(id).finally(() => this.cancellations.delete(id));
    this.cancellations.set(id, work); return work;
  }
  private async cancelRequest(id: string) {
    const row = this.localRequest(id);
    if (!row || terminal.has(row.stage) || row.responseCompleted) return;
    row.cancelRequested = true; row.stage = "uncertain"; this.store.put(row);
    if (!row.cancelSent && row.provider && row.endpoint) {
      const body = '{"cancel":true}', headers = this.signedHeaders(row, digest(body));
      const response = await providerFetch(new Request(row.endpoint.replace(/\/$/, "") + "/cancel", { method: "POST", headers, body, signal: AbortSignal.timeout(5000), redirect: "error" }), this.account.apiUrl);
      if (response.ok || [404, 405].includes(response.status)) {
        const current = this.localRequest(id);
        if (current && !terminal.has(current.stage)) this.store.put({ ...current, cancelSent: true });
        void response.body?.cancel().catch(() => {});
      } else if (!bookingPending(response.status, (await readProviderFailure(response, AbortSignal.timeout(5000))).error)) throw new FossaError("CANCEL_PENDING", "Cancellation is waiting for booking recovery.");
    }
    void this.recoverPending();
  }
  dispatched(id: string, at: number) {
    const row = this.localRequest(id);
    if (!row || row.submittedAt === undefined) return;
    row.dispatchStarted = true; row.providerDispatchedAt ??= at;
    row.gapToProviderMs ??= row.previousResponseFinishedAt === undefined ? undefined : at - row.previousResponseFinishedAt;
    if (row.stage === "reserved") row.stage = "inference";
    row.providerRequestMs ??= at - (row.startedAt ?? row.created); row.sendToProviderMs ??= at - row.submittedAt;
    this.store.put(row);
  }
  response(request: Request, response: Response) {
    const id = request.headers.get("x-fossa-call-id"), row = id ? this.localRequest(id) : undefined;
    if (!row) return response;
    row.responseHeadersAt ??= Date.now();
    if (row.dispatchStarted !== true) { row.dispatchStarted = true; this.store.put(row); }
    if (!response.ok) { row.stage = "uncertain"; this.store.put(row); this.progress(row.id, { stage: "error", message: `Provider returned ${response.status}. Payment is recovering automatically.` }); void this.recoverPending(); return response; }
    if (!response.body) { row.stage = "uncertain"; this.store.put(row); this.progress(row.id, { stage: "uncertain", message: "Empty provider response · reconciling payment…" }); void this.recoverPending(); return response; }
    const reader = response.body.getReader(), decoder = new TextDecoder(), eventStream = response.headers.get("content-type")?.includes("text/event-stream");
    let pending = "", pendingBytes = 0, data: string[] = [], eventBytes = 0, bytes = 0, completed = false, started = false, failed = false, finished = false;
    const dispatch = () => {
      const text = data.join("\n"); data = []; eventBytes = 0;
      if (text === "[DONE]") { completed = true; row.responseDoneAt ??= Date.now(); return; }
      if (!text) return;
      try { const event = JSON.parse(text); if (event.error) failed = true; const usage = event.usage; if (usage && Number.isSafeInteger(usage.prompt_tokens) && usage.prompt_tokens >= 0 && Number.isSafeInteger(usage.completion_tokens) && usage.completion_tokens >= 0) row.usage = { input: usage.prompt_tokens, output: usage.completion_tokens, cached: Math.min(usage.prompt_tokens, Math.max(0, Number.isSafeInteger(usage.prompt_tokens_details?.cached_tokens) ? usage.prompt_tokens_details.cached_tokens : 0)) }; } catch { /* preserve upstream bytes for the host decoder. */ }
    };
    const parseLine = (line: string) => {
      if (!line) { dispatch(); return; }
      if (!line.startsWith("data:")) return;
      const part = line.slice(5).replace(/^ /, "");
      eventBytes += Buffer.byteLength(part);
      if (eventBytes > 16 * 1024 * 1024) throw new FossaError("RESPONSE_TOO_LARGE", "Provider stream event exceeds the byte limit.");
      data.push(part);
    };
    let abort = () => {};
    const finish = () => {
      if (finished) return;
      finished = true; request.signal.removeEventListener("abort", abort); completed &&= !failed;
      row.responseFinishedAt ??= Date.now(); row.responseCompleted = completed; row.stage = completed ? "settling" : "uncertain"; this.store.put(row);
      const settled = row.stage === "settled" || row.stage === "released";
      this.progress(row.id, { stage: settled ? "idle" : completed ? "settling" : "uncertain", message: settled ? "Payment settled." : completed ? "Inference complete · settling payment…" : "Stream interrupted · reconciling payment…" });
      if (completed || settled) void this.refresh().catch(() => {}); else void this.recoverPending();
    };
    const closeReader = (reason?: unknown) => { void reader.cancel(reason).catch(() => {}); reader.releaseLock(); };
    abort = () => { if (!completed) { failed = true; void this.cancel(row.id).catch(() => {}); } finish(); closeReader(request.signal.reason); };
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const body = new ReadableStream<Uint8Array>({
      pull: async controller => {
        try {
          request.signal.throwIfAborted();
          let timer: ReturnType<typeof setTimeout> | undefined;
          const result = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new FossaError("RESPONSE_TIMEOUT", "Provider stream timed out.")), 120_000); })]).finally(() => clearTimeout(timer));
          request.signal.throwIfAborted();
          if (result.done) { if (!eventStream) completed = true; pending += decoder.decode(); if (pending) parseLine(pending.replace(/\r$/, "")); dispatch(); finish(); reader.releaseLock(); controller.close(); return; }
          bytes += result.value.byteLength;
          if (bytes > 256 * 1024 * 1024) throw new FossaError("RESPONSE_TOO_LARGE", "Provider response exceeds the byte limit.");
          if (!started) { started = true; row.firstByteAt ??= Date.now(); this.progress(row.id, { stage: "streaming", message: `${this.status.provider ?? "Provider"} generating…` }); }
          if (eventStream) {
            const decoded = decoder.decode(result.value, { stream: true });
            pending += decoded; pendingBytes += Buffer.byteLength(decoded);
            let end: number;
            while (!completed && (end = pending.indexOf("\n")) >= 0) {
              const line = pending.slice(0, end); pending = pending.slice(end + 1); pendingBytes -= Buffer.byteLength(line) + 1;
              parseLine(line.replace(/\r$/, ""));
            }
            if (!completed && pendingBytes + eventBytes > 16 * 1024 * 1024) throw new FossaError("RESPONSE_TOO_LARGE", "Provider stream event exceeds the byte limit.");
          }
          controller.enqueue(result.value);
          if (completed && eventStream) { finish(); closeReader(); controller.close(); }
        } catch (error) { failed = true; finish(); closeReader(error); void this.cancel(row.id).catch(() => {}); controller.error(error); }
      },
      cancel: reason => { if (!completed) { failed = true; void this.cancel(row.id).catch(() => {}); } finish(); closeReader(reason); },
    });
    const headers = new Headers(response.headers);
    for (const name of ["content-length", "content-encoding", "transfer-encoding"]) headers.delete(name);
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
  }
  failed(id: string) { const row = this.localRequest(id); if (row && ["prepared", "sent", "matched", "inference"].includes(row.stage)) { row.stage = "uncertain"; this.store.put(row); void this.recoverPending(); } }
  stop() { this.stopped = true; clearTimeout(this.retry); clearInterval(this.timer); clearInterval(this.rakebackTimer); this.socket?.close(); for (const wake of this.catalogWaiters) wake(); this.wakeWallet(); }
  async drain() { this.stop(); await Promise.allSettled([this.refreshing, this.recovering, this.rakebackRunning, ...this.cancellations.values()]); }
}
