import { createHash, randomUUID } from "node:crypto";
import { Connection, ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, type AccountInfo } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "./token";
import bs58 from "bs58";
import { providerError, bookingPending } from "./provider-response";
import { api, config, safeUrl } from "./api";
import { signMessage } from "./signing";
import { Store, type Pending } from "./store";
import { inputBound, validateBody } from "./protocol";
import { recoverable, rakebackDollars } from "./rakeback";
import { FossaError, type Account, type Catalog, type Chain, type MarketModel, type Offer, type PublicConfig, type RakebackFunds, type RakebackState, type Settings, type Status, type WalletState } from "./types";

export { inputBound } from "./protocol";
import { eligible, fee, priceFields, rankOffers, settling, unavailable } from "./routing";
export { eligible, fee } from "./routing";
const atomic = (value: bigint, decimals = 6) => `${value / 10n ** BigInt(decimals)}.${(value % 10n ** BigInt(decimals)).toString().padStart(decimals, "0")}`;
const digest = (body: string) => createHash("sha256").update(body).digest("hex");
const meta = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
const ix = (programId: PublicKey, opcode: number, data: Buffer, keys: ReturnType<typeof meta>[]) => new TransactionInstruction({ programId, data: Buffer.concat([Buffer.from([opcode]), data]), keys });
const terminal = new Set(["settled", "released", "failed", "expired"]);
const LiveSocket = WebSocket as typeof WebSocket & { new(url: URL, options: Bun.WebSocketOptions): WebSocket };

export class FossaClient {
  private cancellations = new Map<string, Promise<void>>();
  cfg!: PublicConfig; catalog?: Catalog; wallet?: WalletState; chain?: Chain;
  status: Status = { stage: "connecting", message: "Connecting to Fossa…", paidAtomic: "0", connected: false };
  private rpc!: Connection; private socket?: WebSocket; private retry?: ReturnType<typeof setTimeout>; private timer?: ReturnType<typeof setInterval>;
  private chainUntil = 0; private catalogAt = 0; private walletAt = 0; private stopped = false; private refreshing?: Promise<void>;
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
  settings(model = "") { return this.store.settings(this.account.walletId, model); }
  async start() {
    await this.store.autoUnlock(this.account.walletId);
    this.cfg = await config(this.account.apiUrl);
    const endpoint = this.account.rpcUrl || `${this.account.apiUrl}/v1/opencode/rpc`;
    this.rpc = new Connection(endpoint, { commitment: "processed", disableRetryOnRateLimit: true, ...(this.account.rpcUrl ? { wsEndpoint: this.account.rpcWsUrl } : { httpHeaders: { authorization: `Bearer ${this.account.access}` } }) });
    await Promise.all([this.refresh(), this.rpc.getGenesisHash().then(hash => { if (hash !== this.cfg.opencode.mainnetGenesisHash) throw new FossaError("WRONG_NETWORK", "Selected RPC is not Solana mainnet."); })]); this.connect();
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
    socket.onmessage = event => {
      try {
        const update = JSON.parse(String(event.data));
        if (update.type === "catalog") this.updateCatalog(update.data);
        if (update.type === "chain") { this.chain = update.data ?? undefined; this.chainUntil = Date.now() + (this.chain?.maxAgeMs ?? 0) - 1000; }
        if (update.type === "wallet" && update.data.wallet === this.account.wallet && update.data.lane === this.account.lane && update.data.slot >= (this.wallet?.slot ?? 0)) { this.wallet = update.data; this.walletAt = Date.now(); this.wakeWallet(); }
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
      if (catalog.programId !== this.cfg.programId || catalog.market !== this.cfg.market) throw new FossaError("MARKET_CHANGED", "Fossa protocol configuration changed. Reconnect before signing.");
      this.updateCatalog(catalog, version);
      if (wallet.slot >= (this.wallet?.slot ?? 0)) { this.wallet = wallet; this.walletAt = Date.now(); }
      const rows = this.store.pending(this.account.wallet);
      for (const receipt of history.receipts) { const row = rows.find(row => row.kind === "inference" && row.booking === receipt.booking && row.generation === receipt.generation); if (row) { row.charge = receipt.charge; row.stage = "settled"; row.settledAt ??= Date.now(); this.store.put(row); } }
      this.publish({ connected: true, balanceAtomic: (BigInt(wallet.usdcAtomic) + BigInt(wallet.freeAtomic)).toString(), reservedAtomic: rows.filter(row => !terminal.has(row.stage)).reduce((sum, row) => sum + BigInt(row.reserve), 0n).toString(), paidAtomic: rows.reduce((sum, row) => sum + BigInt(row.charge ?? "0"), 0n).toString() });
      this.wakeWallet();
      if (["settling", "uncertain"].includes(this.status.stage) && rows.some(row => row.id === this.status.requestId && ["settled", "released"].includes(row.stage))) this.publish({ stage: "idle", message: "Payment settled." });
    })().finally(() => { this.refreshing = undefined; });
  }
  private updateCatalog(catalog: Catalog, version = this.catalogVersion) {
    if (catalog.programId !== this.cfg.programId || catalog.market !== this.cfg.market) throw new FossaError("MARKET_CHANGED", "Fossa protocol configuration changed. Reconnect before signing.");
    if (this.catalog && (catalog.slot < this.catalog.slot || version !== this.catalogVersion && catalog.slot === this.catalog.slot)) return;
    this.catalog = catalog; this.catalogAt = Date.now();
    this.catalogVersion++;
    for (const wake of this.catalogWaiters) wake();
  }
  private wakeWallet() { for (const wake of this.walletWaiters) wake(); }
  private receipt(value: unknown) {
    const receipt = value as { owner?: string; provider?: string; booking?: string; generation?: string; charge?: string; slot?: number } | null;
    if (!receipt || receipt.owner !== this.account.wallet || typeof receipt.charge !== "string" || !/^\d{1,20}$/.test(receipt.charge) || !Number.isSafeInteger(receipt.slot) || receipt.slot! < 0) return;
    const row = this.store.pending(this.account.wallet).find(row => row.kind === "inference" && row.booking === receipt.booking && row.generation === receipt.generation);
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
      const snapshot = await api<WalletState>(this.account.apiUrl, "/opencode/wallet", { token: this.account.access });
      if (snapshot.slot >= minSlot && [...pool].every(address => snapshot.bookings.some(item => item.address === address))) return snapshot;
    }
    const program = new PublicKey(this.cfg.programId), owner = new PublicKey(this.account.wallet), lane = new PublicKey(this.account.lane), mint = new PublicKey(this.cfg.usdcMint);
    const [source, [authority]] = await Promise.all([getAssociatedTokenAddress(mint, owner), PublicKey.findProgramAddress([Buffer.from("vault"), lane.toBytes()], program)]), vault = await getAssociatedTokenAddress(mint, authority, true);
    const addresses = [owner, source, lane, ...[...pool].map(value => new PublicKey(value))];
    const result = await this.rpc.getMultipleAccountsInfoAndContext(addresses, { commitment: "processed", ...(minSlot ? { minContextSlot: minSlot } : {}) });
    const values = result.value.map(info => info && ({ ...info, data: Buffer.from(info.data) })), [balance, token, user] = values;
    const ready = Boolean(user && user.owner.equals(program) && user.data.length === 120 && user.data.subarray(0, 8).toString() === "USER0V20" && user.data.subarray(8, 40).equals(owner.toBytes()) && user.data.subarray(40, 72).equals(new PublicKey(this.cfg.market).toBytes()) && user.data.subarray(80, 112).equals(vault.toBytes()));
    if (user && !ready) throw new FossaError("ACCOUNT_INVALID", "Fossa user account identity is invalid.");
    const counter = Buffer.alloc(8); if (ready) user!.data.copy(counter, 0, 113, 120);
    const validToken = token && token.owner.equals(TOKEN_PROGRAM_ID) && token.data.length === 165 && token.data.subarray(0, 32).equals(mint.toBytes()) && token.data.subarray(32, 64).equals(owner.toBytes());
    return { wallet: this.account.wallet, lane: this.account.lane, source: source.toBase58(), vault: vault.toBase58(), ready, lamports: String(balance?.lamports ?? 0), usdcAtomic: validToken ? token.data.readBigUInt64LE(64).toString() : "0", freeAtomic: ready ? user!.data.readBigUInt64LE(72).toString() : "0", generation: counter.readBigUInt64LE().toString(), slot: Number(result.context.slot), bookings: [...pool].flatMap((address, index) => { const value = values[index + 3]; if (!value || !value.lamports && !value.data.length) return []; if (!value.owner.equals(program) || value.data.length !== 368 || value.data.subarray(0, 8).toString() !== "BOOK0V20" || !value.data.subarray(8, 40).equals(owner.toBytes()) || !value.data.subarray(192, 224).equals(lane.toBytes())) throw new FossaError("ACCOUNT_INVALID", "Booking pool identity is invalid."); return [{ address, status: value.data[148], generation: value.data.readBigUInt64LE(152).toString(), rentPayer: new PublicKey(value.data.subarray(256, 288)).toBase58() }]; }) };
  }
  private quote() {
    if (this.chain && Date.now() < this.chainUntil) return this.chain;
    throw new FossaError("CHAIN_SYNCING", "Fossa chain data is synchronizing. Try again shortly.");
  }
  private availableWallet(): WalletState {
    if (!this.wallet) throw new FossaError("WALLET_SYNCING", "Wallet is synchronizing. Try again shortly.");
    const wallet = this.wallet, rows = this.store.pending(this.account.wallet).filter(row => row.kind === "inference" || row.kind === "rakeback");
    let usdc = BigInt(wallet.usdcAtomic), free = BigInt(wallet.freeAtomic), lamports = BigInt(wallet.lamports), generation = BigInt(wallet.generation);
    for (const row of rows) {
      if (["failed", "expired"].includes(row.stage)) continue;
      if (BigInt(row.generation) > generation) generation = BigInt(row.generation);
      if (row.processedSlot !== undefined ? row.processedSlot <= wallet.slot : terminal.has(row.stage)) continue;
      if (row.kind === "rakeback") { free += BigInt(row.refund ?? "0") - BigInt(row.withdrawal ?? "0"); usdc += BigInt(row.withdrawal ?? "0"); lamports -= BigInt(row.feeLamports ?? "0"); continue; }
      const reserve = BigInt(row.reserve), deposit = BigInt(row.deposit ?? row.reserve);
      usdc -= deposit; free += deposit - reserve; lamports -= BigInt(row.feeLamports ?? "0");
    }
    const occupied = new Set(rows.filter(row => row.kind === "inference" && (!terminal.has(row.stage) || !["failed", "expired"].includes(row.stage) && Math.max(row.processedSlot ?? 0, row.settlementSlot ?? 0) > wallet.slot)).map(row => row.booking));
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
            this.rpc.getSignatureStatuses([row.signature], { searchTransactionHistory: true }),
            wake && row.kind === "inference" ? this.rpc.getAccountInfoAndContext(new PublicKey(row.booking), "processed").then(account => {
              if (!done && account.value?.owner.equals(new PublicKey(this.cfg.programId)) && account.value.data.length === 368 && account.value.data[148] === 0 && Buffer.from(account.value.data).readBigUInt64LE(152).toString() === row.generation) this.watchers.get(row.booking)?.(account.value, Number(account.context.slot), "rpc");
              return account;
            }) : undefined,
          ]);
          const [status] = statuses.value;
          if (done) return 0;
          if (status?.err && status.confirmationStatus !== "processed") { row.stage = "failed"; row.error = JSON.stringify(status.err, (_key, value) => typeof value === "bigint" ? value.toString() : value); this.store.put(row); throw new FossaError("TRANSACTION_FAILED", row.kind === "rakeback" ? `Rakeback transaction failed: ${row.signature}. No funds were moved.` : `Fossa transaction failed: ${row.signature}. No booking USDC was charged.`); }
          if (account?.value?.owner.equals(new PublicKey(this.cfg.programId)) && account.value.data.length === 368 && account.value.data[148] === 0 && Buffer.from(account.value.data).readBigUInt64LE(152).toString() === row.generation) {
            this.watchers.get(row.booking)?.(account.value, Number(account.context.slot), "rpc");
            return Number(account.context.slot);
          }
          if (!wake && status && !status.err && (!confirmed || status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) return Number(status.slot);
          if (!status) {
            const height = await this.rpc.getBlockHeight("finalized");
            if (done) return 0;
            if (height > row.expiry + 5) { row.stage = "expired"; this.store.put(row); throw new FossaError("TRANSACTION_EXPIRED", "Booking transaction expired without confirmation."); }
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
  private async journal(tx: Transaction, signers: Keypair[], fields: Omit<Pending, "signature" | "transaction" | "expiry" | "stage" | "created">, rent: number | bigint = 0, signal?: AbortSignal) {
    const quote = this.quote(); tx.feePayer = signers[0].publicKey; tx.recentBlockhash = quote.blockhash as NonNullable<Transaction["recentBlockhash"]>;
    const cost = BigInt(quote.signatureFee) * BigInt(tx.compileMessage().header.numRequiredSignatures), required = cost + BigInt(rent), balance = BigInt(this.availableWallet().lamports);
    if (balance < required) throw new FossaError("SOL_REQUIRED", `Add ${atomic(required - balance, 9)} SOL for ${rent ? "account rent and " : ""}transaction fees.`, { requiredLamports: required.toString() });
    signal?.throwIfAborted();
    await tx.sign(...signers);
    signal?.throwIfAborted();
    const row: Pending = { ...fields, ...(fields.kind === "inference" ? { dispatchStarted: false } : {}), feeLamports: cost.toString(), prepareMs: fields.startedAt === undefined ? undefined : Date.now() - fields.startedAt, signature: bs58.encode(tx.signatures[0].signature!), transaction: Buffer.from(await tx.serialize()).toString("base64"), expiry: quote.lastValidBlockHeight, stage: "prepared", created: Date.now() };
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
      const [rent, tokenRent] = await Promise.all([this.rpc.getMinimumBalanceForRentExemption(120), this.rpc.getMinimumBalanceForRentExemption(165)]);
      const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 }), SystemProgram.createAccount({ fromPubkey: owner.publicKey, newAccountPubkey: lane, lamports: rent, space: 120, programId: program }), createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, vault, authority, mint), ix(program, 1, Buffer.alloc(0), [meta(lane, true, true), meta(owner.publicKey, false, true), meta(market), meta(vault)]));
      try { const row = await this.journal(tx, [owner, laneSigner], { id: randomUUID(), wallet: this.account.wallet, model: "", bodyHash: "", session: "", kind: "setup", booking: "", generation: "0", reserve: "0" }, rent + tokenRent, signal); const slot = await this.processed(row); row.stage = "settled"; this.store.put(row); this.wallet = await this.snapshot(slot); } finally { laneSigner.secretKey.fill(0); }
    }
    for (const [address, bytes] of Object.entries(secrets.bookings)) {
      if (this.wallet.bookings.some(value => value.address === address)) continue;
      const quote = this.quote(), rent = BigInt(quote.bookingRent), booking = await Keypair.fromSecretKey(Uint8Array.from(bytes));
      const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 25_000 }), SystemProgram.createAccount({ fromPubkey: owner.publicKey, newAccountPubkey: booking.publicKey, lamports: rent, space: 368, programId: program }), ix(program, 26, Buffer.alloc(0), [meta(market), meta(lane), meta(owner.publicKey, false, true), meta(booking.publicKey, true, true), meta(owner.publicKey, false, true)]));
      try { const row = await this.journal(tx, [owner, booking], { id: randomUUID(), wallet: this.account.wallet, model: "", bodyHash: "", session: "", kind: "setup", booking: address, generation: "0", reserve: "0" }, rent, signal); const slot = await this.processed(row); row.stage = "settled"; this.store.put(row); this.wallet = await this.snapshot(slot); } finally { booking.secretKey.fill(0); }
    }
  }
  private inspect(info: AccountInfo<Uint8Array>, row: Pending, model: MarketModel) {
    const data = Buffer.from(info.data);
    if (!info.owner.equals(new PublicKey(this.cfg.programId)) || data.length !== 368 || data.subarray(0, 8).toString() !== "BOOK0V20" || !data.subarray(8, 40).equals(new PublicKey(this.account.wallet).toBytes()) || !data.subarray(72, 104).equals(new PublicKey(this.cfg.market).toBytes()) || !data.subarray(192, 224).equals(new PublicKey(this.account.lane).toBytes()) || !data.subarray(224, 256).equals(new PublicKey(model.address).toBytes()) || data.readBigUInt64LE(152).toString() !== row.generation) throw new FossaError("BOOKING_CHANGED", "Booking identity or generation changed. Reconcile before retrying.");
    return data;
  }
  private async rakebackFunds(): Promise<RakebackFunds> {
    const funds = await api<RakebackFunds>(this.account.apiUrl, "/opencode/funds", { token: this.account.access });
    if (this.account.rpcUrl) funds.free = (await this.snapshot()).freeAtomic;
    recoverable(funds); return funds;
  }
  async rakebackState(): Promise<RakebackState> {
    const funds = await this.rakebackFunds();
    return { ...this.store.rakeback(this.account.walletId).settings, availableAtomic: recoverable(funds).toString(), processing: this.raking, needsRecovery: this.store.pending(this.account.wallet).some(row => ["prepared", "sent", "uncertain"].includes(row.stage)), message: this.rakebackMessage };
  }
  async automaticRakeback() {
    if (this.stopped) return;
    const { settings, lastRun } = this.store.rakeback(this.account.walletId);
    if (this.stopped || this.raking || !settings.autoRakeback || !this.store.unlocked(this.account.walletId) || settings.rakebackMode === "interval" && Date.now() - lastRun < settings.rakebackIntervalMinutes * 60_000) return;
    if (this.store.pending(this.account.wallet).some(row => row.kind === "inference" && ["matched", "inference"].includes(row.stage) && Date.now() < (row.claimEnd ? row.claimEnd * 1000 : row.created + this.cfg.opencode.requestTimeoutMs))) return;
    try { await this.rakeback(true); } catch { /* rakeback state retains the actionable error for settings */ }
  }
  private recoverPending(): Promise<void> {
    if (this.stopped || !this.store.pending(this.account.wallet).some(row => ["prepared", "sent", "uncertain", "reserved"].includes(row.stage))) return Promise.resolve();
    return this.recovering ??= this.store.exclusive(this.account.wallet, async () => {
      await this.reconcile(true);
      await this.refresh();
    }).catch(() => { /* retry pending recovery before the next request and on the maintenance timer */ }).finally(() => { this.recovering = undefined; });
  }
  private async reconcile(unresolvedOnly = false) {
    await this.refresh();
    let amount = 0n; const signatures: string[] = [];
    for (const row of this.store.pending(this.account.wallet)) {
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
      const current = this.store.request(row.id, this.account.wallet);
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
        const offer = model?.offers.find(offer => offer.provider.wallet === provider && offer.slot === data.readUInt32LE(352));
        if (model && offer?.provider.endpoint) {
          this.inspect(info, row, model);
          this.store.put({ ...row, provider, endpoint: safeUrl(offer.provider.endpoint) });
          await this.cancel(row.id).catch(() => {});
        }
      }
    }
    return { amount, signatures };
  }
  private bookingData(info: AccountInfo<Uint8Array>) {
    const data = Buffer.from(info.data);
    if (!info.owner.equals(new PublicKey(this.cfg.programId)) || data.length !== 368 || data.subarray(0, 8).toString() !== "BOOK0V20" || !data.subarray(8, 40).equals(new PublicKey(this.account.wallet).toBytes()) || !data.subarray(72, 104).equals(new PublicKey(this.cfg.market).toBytes()) || !data.subarray(192, 224).equals(new PublicKey(this.account.lane).toBytes())) throw new FossaError("ACCOUNT_INVALID", "Rakeback booking does not belong to this wallet and market.");
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
          const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 80_000 }));
          let refunded = 0n, released = 0;
          const bookings: { address: string; generation: string }[] = [];
          for (const candidate of funds.bookings) {
            if (released === 2) break;
            const address = new PublicKey(candidate.address), info = await this.rpc.getAccountInfo(address, "confirmed");
            if (!info) continue;
            const data = this.bookingData(info), generation = data.readBigUInt64LE(152);
            if (data[148] !== 0 || generation.toString() !== candidate.generation || Number(data.readBigInt64LE(132)) + 15 >= Date.now() / 1000) continue;
            const model = new PublicKey(data.subarray(224, 256)), record = await this.rpc.getAccountInfo(model, "confirmed");
            if (!record || !record.owner.equals(program) || record.data.length !== 144 || Buffer.from(record.data).subarray(0, 8).toString() !== "MODELV20" || !Buffer.from(record.data).subarray(8, 40).equals(market.toBytes())) throw new FossaError("ACCOUNT_INVALID", "Rakeback model is unavailable or invalid.");
            tx.add(ix(program, 8, generation ? Buffer.from(data.subarray(152, 160)) : Buffer.alloc(0), [meta(market), meta(model), meta(new PublicKey(record.data.subarray(104, 136)), true), meta(lane, true), meta(address, true)]));
            refunded += data.readBigUInt64LE(104); released++; bookings.push({ address: candidate.address, generation: candidate.generation });
          }
          const laneInfo = await this.rpc.getAccountInfo(lane, "confirmed"), vault = new PublicKey(this.wallet.vault);
          if (!laneInfo || !laneInfo.owner.equals(program) || laneInfo.data.length !== 120 || Buffer.from(laneInfo.data).subarray(0, 8).toString() !== "USER0V20" || !Buffer.from(laneInfo.data).subarray(8, 40).equals(owner.publicKey.toBytes()) || !Buffer.from(laneInfo.data).subarray(40, 72).equals(market.toBytes()) || !Buffer.from(laneInfo.data).subarray(80, 112).equals(vault.toBytes())) throw new FossaError("ACCOUNT_INVALID", "Rakeback wallet account is invalid.");
          const amount = Buffer.from(laneInfo.data).readBigUInt64LE(72) + refunded;
          if (!amount) return finish(previous.amount, previous.signatures);
          const source = await getAssociatedTokenAddress(mint, owner.publicKey), authority = (await PublicKey.findProgramAddress([Buffer.from("vault"), lane.toBytes()], program))[0];
          let rent = 0n;
          if (!await this.rpc.getAccountInfo(source, "confirmed")) { rent = await this.rpc.getMinimumBalanceForRentExemption(165); tx.add(createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, source, owner.publicKey, mint)); }
          const payload = Buffer.alloc(8); payload.writeBigUInt64LE(amount);
          tx.add(ix(program, 10, payload, [meta(market), meta(lane, true), meta(owner.publicKey, false, true), meta(vault, true), meta(source, true), meta(mint), meta(authority), meta(TOKEN_PROGRAM_ID)]));
          if (this.stopped || automatic && !this.store.rakeback(this.account.walletId).settings.autoRakeback) throw new FossaError("RAKEBACK_STOPPED", "Automatic rakeback stopped before signing.");
          const row = await this.journal(tx, [owner], { id: randomUUID(), wallet: this.account.wallet, model: "", bodyHash: "", session: "", kind: "rakeback", booking: "", generation: "0", reserve: "0", withdrawal: amount.toString(), refund: refunded.toString() }, rent);
          row.processedSlot = await this.processed(row, undefined, undefined, true); row.stage = "settled"; this.store.put(row);
          for (const pending of this.store.pending(this.account.wallet)) if (pending.kind === "inference" && bookings.some(booking => booking.address === pending.booking && booking.generation === pending.generation)) { pending.stage = "released"; this.store.put(pending); }
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
    const startedAt = Date.now();
    const previousRequest = this.store.pending(this.account.wallet).filter(row => row.kind === "inference" && row.session === session && row.flow === kind && row.id !== callId).at(-1);
    const previousResponseFinishedAt = previousRequest?.responseFinishedAt;
    const gap = (timing.modelRequestAt ?? startedAt) - (previousResponseFinishedAt ?? Infinity);
    const requestTiming = { ...timing, previousRequestId: previousRequest?.id, ...(gap >= 0 ? { previousResponseFinishedAt, requestGapMs: gap } : {}) };
    let recoveryWaitMs = 0, admissionWaitMs = 0, bookingPoolWaitMs = 0;
    if (kind === "primary") this.publish({ requestId: callId, sessionID: session, model: modelId, provider: undefined, signature: undefined, booking: undefined, stage: "synchronizing", message: "Checking wallet and providers…" });
    if (Buffer.byteLength(body) > this.cfg.opencode.maxRequestBytes) throw new FossaError("REQUEST_TOO_LARGE", "Request exceeds Fossa payload limit.");
    const hash = digest(body);
    const previous = this.store.request(callId, this.account.wallet);
    if (previous) {
      if (previous.cancelRequested) throw new FossaError("REQUEST_CANCELLED", "This request was cancelled. Payment is recovering automatically.");
      if (previous.bodyHash !== hash || previous.model !== modelId) throw new FossaError("REQUEST_CHANGED", "A retry changed the signed request body.");
      if (terminal.has(previous.stage)) throw new FossaError("REQUEST_COMPLETED", "This Fossa request already completed. Its payment will not be repeated.");
      if (previous.provider && previous.endpoint) return this.authorize(previous, body);
      throw new FossaError("SUBMISSION_UNCERTAIN", "Existing booking is unresolved. Use /fossa to recover it.");
    }
    return this.store.exclusive(this.account.wallet, async () => {
      const walletLockMs = Date.now() - startedAt;
      signal.throwIfAborted();
      const existing = this.store.request(callId, this.account.wallet);
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
      const parsed = JSON.parse(body) as { messages: unknown[]; tools?: unknown[]; max_tokens?: number; max_completion_tokens?: number };
      const maxInput = inputBound(parsed, model.contextTokens), maxOutput = parsed.max_tokens ?? parsed.max_completion_tokens;
      if (!Array.isArray(parsed.messages) || !Number.isSafeInteger(maxOutput) || !maxOutput || maxOutput < 1 || maxOutput > (model.outputTokens ?? 0) || maxInput > Math.min(model.inputBoundTokens ?? model.contextTokens ?? 0, this.cfg.opencode.maxInputTokens)) throw new FossaError("TOKEN_LIMIT", "Request exceeds model or Fossa token bounds. Reduce context or output limit before retrying.");
      validateBody(parsed, { maxInput, maxOutput, claimEnd: Number.MAX_SAFE_INTEGER }, { model: model.id, speed_tps: 1, context_tokens: model.contextTokens ?? 0, max_input_bound: model.inputBoundTokens ?? model.contextTokens, output_tokens: model.outputTokens ?? 0, tools: model.capabilities?.tools === true, input: model.modalities.input, effort: model.variants?.map(variant => variant.body.reasoning_effort) ?? model.effort });
      if (this.store.pending(this.account.wallet).some(row => ["prepared", "sent", "uncertain"].includes(row.stage))) {
        const recoveryAt = Date.now();
        await this.reconcile(true);
        recoveryWaitMs += Date.now() - recoveryAt;
        if (this.store.pending(this.account.wallet).some(row => ["prepared", "sent", "uncertain"].includes(row.stage))) throw new FossaError("RECOVERY_PENDING", "Previous payment is recovering automatically. Try again once its release is confirmed.");
      }
      const estimatedInput = Math.min(maxInput, Math.ceil(Buffer.byteLength(body) / 4)), estimatedOutput = Math.min(maxOutput, 256);
      const prefix = (messages: number) => digest(JSON.stringify({ ...parsed, messages: parsed.messages.slice(0, messages) }));
      const prior = this.store.pending(this.account.wallet).filter(row => row.kind === "inference" && row.session === session && row.flow === kind && row.model === modelId && row.provider && row.usage && row.cache
        && ["settling", "settled"].includes(row.stage) && row.cache.messages <= parsed.messages.length && row.cache.prefix === prefix(row.cache.messages)).at(-1);
      const continued = prior && parsed.messages.slice(prior.cache!.messages).some(message => message && typeof message === "object" && "role" in message && message.role === "assistant");
      const cached = prior ? Math.min(estimatedInput, prior.usage!.input + (continued ? prior.usage!.output : 0), Math.ceil(Buffer.byteLength(JSON.stringify(parsed.messages.slice(0, Math.max(prior.cache!.messages, parsed.messages.length - 1)))) / 4)) : 0;
      const estimate = { input: estimatedInput, cached, output: estimatedOutput, provider: prior?.provider };
      const settings = this.settings(modelId);
      let ranked = rankOffers(eligible(model, settings, maxInput, maxOutput), settings, estimate);
      const admissionAt = Date.now(), admissionDeadline = admissionAt + this.cfg.opencode.requestTimeoutMs;
      let refresh = true;
      while (!ranked.length && settling(model, settings, maxInput, maxOutput) && Date.now() < admissionDeadline) {
        signal.throwIfAborted();
        if (this.stopped) throw new FossaError("FOSSA_STOPPED", "Fossa connection closed.");
        this.progress(callId, { stage: "settling", message: "Waiting for provider settlement…" });
        if (refresh) { const version = this.catalogVersion; this.updateCatalog(await api<Catalog>(this.account.apiUrl, "/market/catalog", { signal }), version); }
        model = this.catalog.models.find(value => value.id === modelId);
        if (!model) throw new FossaError("MODEL_UNAVAILABLE", "Selected Fossa model is unavailable.");
        if (maxInput > Math.min(model.inputBoundTokens ?? model.contextTokens ?? 0, this.cfg.opencode.maxInputTokens) || maxOutput > (model.outputTokens ?? 0)) throw new FossaError("TOKEN_LIMIT", "Request exceeds updated model token bounds.");
        ranked = rankOffers(eligible(model, settings, maxInput, maxOutput), settings, estimate);
        if (!ranked.length && settling(model, settings, maxInput, maxOutput)) refresh = !await this.waitForCatalog(signal, admissionDeadline);
      }
      signal.throwIfAborted();
      if (this.stopped) throw new FossaError("FOSSA_STOPPED", "Fossa connection closed.");
      this.quote();
      admissionWaitMs = Date.now() - admissionAt;
      const best = ranked[0];
      const minSpeed = settings.mode === "cheapest" ? settings.minSpeed : Math.max(settings.minSpeed, best?.speed ?? 0);
      const maxSpend = best ? fee(maxInput, best.inputRate) + fee(maxOutput, best.outputRate) + 1n : 0n;
      const offers = ranked.filter(offer => offer.speed >= minSpeed && fee(maxInput, offer.inputRate) + fee(maxOutput, offer.outputRate) + 1n <= maxSpend);
      if (!offers.length) { const reason = unavailable(model, settings, maxInput, maxOutput); throw new FossaError("NO_PROVIDER", reason.message, { ...reason.data, catalogSlot: this.catalog.slot }); }
      const reserve = offers.reduce((max, offer) => { const value = fee(maxInput, offer.inputRate) + fee(maxOutput, offer.outputRate) + 1n; return value > max ? value : max; }, 0n);
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
          const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: Math.min(1_400_000, 10_000 + model.offers.length * 200) }));
          if (deposit) { const amount = Buffer.alloc(8); amount.writeBigUInt64LE(deposit); tx.add(ix(program, 3, amount, [meta(market), meta(lane, true), meta(owner.publicKey, false, true), meta(new PublicKey(wallet.source), true), meta(new PublicKey(wallet.vault), true), meta(mint), meta(TOKEN_PROGRAM_ID)])); }
          const payload = Buffer.alloc(115); createHash("sha256").update(modelId).digest().copy(payload);
          priceFields.forEach((field, index) => payload.writeUInt32LE(settings[field] === undefined ? 0xffffffff : Math.floor(settings[field]! * 1_000_000), 32 + index * 4));
          payload.writeUInt16LE(minSpeed, 44); payload.writeUInt32LE(maxInput, 46); payload.writeUInt32LE(maxOutput, 50); payload[54] = settings.zdrOnly ? 1 : 0;
          payload.writeBigUInt64LE(reserve, 55); payload.writeUInt32LE(estimatedInput, 63); payload.writeUInt32LE(cached, 67); payload.writeUInt32LE(estimatedOutput, 71); payload.writeBigUInt64LE(generation, 107);
          if (prior) Buffer.from(new PublicKey(prior.provider!).toBytes()).copy(payload, 75);
          tx.add(ix(program, 6, payload, [meta(market), meta(new PublicKey(model.address)), meta(new PublicKey(model.terms)), meta(new PublicKey(model.capacity), true), meta(lane, true), meta(owner.publicKey, false, true), meta(new PublicKey(free.address), true), meta(new PublicKey(free.rentPayer))]));
          this.progress(callId, { stage: "booking", message: `Preparing transaction · reserving up to ${atomic(reserve)} USDC…`, booking: free.address }); signal.throwIfAborted();
          let observed: { info: AccountInfo<Uint8Array>; slot: number; source: "stream" | "rpc" } | undefined, wake!: (slot: number) => void;
          const changed = new Promise<number>(resolve => { wake = resolve; });
          const watch = (info: AccountInfo<Uint8Array> | null, slot: number, source: "stream" | "rpc" = "stream") => { if (info?.owner.equals(program) && info.data.length === 368 && info.data[148] === 0 && Buffer.from(info.data).readBigUInt64LE(152) === generation) { observed = { info, slot, source }; wake(slot); } };
          this.watchers.set(free.address, watch);
          if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ watch: free.address }));
          let row: Pending, slot: number, info: AccountInfo<Uint8Array> | null;
          try {
            row = await this.journal(tx, [owner], { id: callId, wallet: this.account.wallet, model: modelId, bodyHash: hash, cache: { messages: parsed.messages.length, prefix: prefix(parsed.messages.length) }, session, kind: "inference", flow: kind, booking: free.address, generation: generation.toString(), reserve: reserve.toString(), deposit: deposit.toString(), startedAt, ...requestTiming, walletLockMs, recoveryWaitMs, admissionWaitMs, bookingPoolWaitMs }, 0, signal);
            slot = await this.processed(row, signal, changed);
            row.processedSlot = slot; this.store.put(row);
            this.progress(callId, { stage: "matched", message: "Transaction confirmed · matching provider…" });
            row.bookingSource = observed && observed.slot >= slot ? observed.source : "rpc";
            info = observed && observed.slot >= slot ? observed.info : await this.rpc.getAccountInfo(new PublicKey(row.booking), { commitment: "processed", minContextSlot: slot });
          } catch (error) {
            const failed = this.store.request(callId, this.account.wallet);
            if (attempt === 0 && error instanceof FossaError && error.code === "TRANSACTION_FAILED" && failed?.stage === "failed" && /"Custom":(?:2|"2")(?=[,}])/.test(failed.error ?? "")) {
              const fresh = await this.snapshot(0, true);
              if (!fresh.bookings.some(item => item.address === free.address)) {
                this.store.put({ ...failed, id: `${callId}:failed:${failed.signature}` });
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
          if (data[148] !== 0) throw new FossaError("BOOKING_CHANGED", "Booking is no longer available for inference.");
          const provider = new PublicKey(data.subarray(40, 72)).toBase58(), offer = offers.find(offer => offer.provider.wallet === provider && offer.slot === data.readUInt32LE(352));
          if (!offer?.provider.endpoint || data.readBigUInt64LE(104) > reserve) throw new FossaError("BOOKING_CHANGED", "Matched provider does not satisfy the authorized request.");
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
    const row = this.store.request(id, this.account.wallet);
    if (!row || terminal.has(row.stage)) return;
    row.cancelRequested = true; row.stage = "uncertain"; this.store.put(row);
    if (!row.cancelSent && row.provider && row.endpoint) {
      const body = '{"cancel":true}', headers = this.signedHeaders(row, digest(body));
      const response = await fetch(row.endpoint.replace(/\/$/, "") + "/cancel", { method: "POST", headers, body, signal: AbortSignal.timeout(5000), redirect: "error" });
      if (response.ok || [404, 405].includes(response.status)) {
        const current = this.store.request(id, this.account.wallet);
        if (current && !terminal.has(current.stage)) this.store.put({ ...current, cancelSent: true });
      } else if (!bookingPending(response.status, providerError(await response.json().catch(() => null)))) throw new FossaError("CANCEL_PENDING", "Cancellation is waiting for booking recovery.");
    }
    void this.recoverPending();
  }
  dispatched(id: string, at: number) {
    const row = this.store.request(id, this.account.wallet);
    if (!row || row.submittedAt === undefined) return;
    row.dispatchStarted = true; row.providerDispatchedAt ??= at;
    row.gapToProviderMs ??= row.previousResponseFinishedAt === undefined ? undefined : at - row.previousResponseFinishedAt;
    if (row.stage === "reserved") row.stage = "inference";
    row.providerRequestMs ??= at - (row.startedAt ?? row.created); row.sendToProviderMs ??= at - row.submittedAt;
    this.store.put(row);
  }
  response(request: Request, response: Response) {
    const id = request.headers.get("x-fossa-call-id"), row = id ? this.store.request(id, this.account.wallet) : undefined;
    if (!row) return response;
    row.responseHeadersAt ??= Date.now();
    if (row.dispatchStarted !== true) { row.dispatchStarted = true; this.store.put(row); }
    if (!response.ok) { row.stage = "uncertain"; this.store.put(row); this.progress(row.id, { stage: "error", message: `Provider returned ${response.status}. Payment is recovering automatically.` }); void this.recoverPending(); return response; }
    if (!response.body) { row.stage = "uncertain"; this.store.put(row); this.progress(row.id, { stage: "uncertain", message: "Empty provider response · reconciling payment…" }); void this.recoverPending(); return response; }
    const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = "", completed = false, started = false, failed = false, finished = false;
    const parseLine = (line: string) => {
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (data === "[DONE]") { completed = true; row.responseDoneAt ??= Date.now(); return; }
      try { const event = JSON.parse(data); if (event.error) failed = true; const usage = event.usage; if (usage && Number.isSafeInteger(usage.prompt_tokens) && usage.prompt_tokens >= 0 && Number.isSafeInteger(usage.completion_tokens) && usage.completion_tokens >= 0) row.usage = { input: usage.prompt_tokens, output: usage.completion_tokens, cached: Math.min(usage.prompt_tokens, Math.max(0, Number.isSafeInteger(usage.prompt_tokens_details?.cached_tokens) ? usage.prompt_tokens_details.cached_tokens : 0)) }; } catch { /* keep upstream bytes intact */ }
    };
    let abort = () => {};
    const finish = () => {
      if (finished) return;
      finished = true; request.signal.removeEventListener("abort", abort); completed &&= !failed;
      row.responseFinishedAt ??= Date.now(); row.responseCompleted = completed; row.stage = completed ? "settling" : "uncertain"; this.store.put(row);
      const settled = row.stage === "settled";
      this.progress(row.id, { stage: settled ? "idle" : completed ? "settling" : "uncertain", message: settled ? "Payment settled." : completed ? "Inference complete · settling payment…" : "Stream interrupted · reconciling payment…" });
      if (completed || settled) void this.refresh().catch(() => {}); else void this.recoverPending();
    };
    abort = () => { failed = true; finish(); void this.cancel(row.id).catch(() => {}); void reader.cancel(request.signal.reason).catch(() => {}); };
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const body = new ReadableStream<Uint8Array>({
      pull: async controller => {
        try {
          const result = await reader.read();
          if (result.done) { pending += decoder.decode(); if (pending.trim()) parseLine(pending.trim()); finish(); reader.releaseLock(); controller.close(); return; }
          if (!started) { started = true; row.firstByteAt ??= Date.now(); this.progress(row.id, { stage: "streaming", message: `${this.status.provider ?? "Provider"} generating…` }); }
          if (response.headers.get("content-type")?.includes("text/event-stream")) {
            pending += decoder.decode(result.value, { stream: true });
            let end: number;
            while ((end = pending.indexOf("\n")) >= 0) {
              const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1);
              parseLine(line);
            }
            if (pending.length > this.cfg.opencode.maxRequestBytes) pending = "";
          } else completed = true;
          controller.enqueue(result.value);
        } catch (error) { failed = true; finish(); controller.error(error); }
      },
      cancel: async reason => { failed = true; finish(); void this.cancel(row.id).catch(() => {}); await reader.cancel(reason).catch(() => {}); },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  failed(id: string) { const row = this.store.request(id, this.account.wallet); if (row && ["prepared", "sent", "matched", "inference"].includes(row.stage)) { row.stage = "uncertain"; this.store.put(row); void this.recoverPending(); } }
  stop() { this.stopped = true; clearTimeout(this.retry); clearInterval(this.timer); clearInterval(this.rakebackTimer); this.socket?.close(); for (const wake of this.catalogWaiters) wake(); this.wakeWallet(); }
  async drain() { this.stop(); await Promise.allSettled([this.refreshing, this.recovering, this.rakebackRunning, ...this.cancellations.values()]); }
}
