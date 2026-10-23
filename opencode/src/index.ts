import { createHash, randomBytes, randomUUID } from "node:crypto";
import { bookingPending, readProviderFailure } from "./provider-response";
import { Credential, Integration, Model, Plugin, Provider } from "@opencode/plugin";
import type { RpcCallContext } from "@opencode/plugin/promise/rpc";
import { generate } from "random-words";
import { api, config, DEFAULT_API_URL, refreshAccount, safeUrl } from "./api";
import { importWallet, quickConnect } from "./auth";
import { FossaClient } from "./client";
import { Fossa } from "./rpc";
import { localStore } from "./store";
import { defaultSettings, eligible, rankOffers, validateSettings } from "./routing";
import { FossaError, type Account, type Catalog, type PublicConfig, type Settings, type Status } from "./types";

const drainKey = Symbol.for("fossa.opencode.transport-drain");
const lifecycle = globalThis as typeof globalThis & { [drainKey]?: Promise<void> };
const providerID = Provider.ID.make("fossa");
const methods = ["quick", "import"] as const;
const guarded = (run: (input: unknown) => Promise<unknown>) => async (input: unknown, context: RpcCallContext<typeof Fossa.methods.model>) => {
  try { return await run(input); }
  catch (error) { return context.error("fossa", error instanceof Error ? error.message : "Fossa unavailable.", { code: error instanceof FossaError ? error.code : "FOSSA_ERROR" }); }
};


function accountFrom(credential: Credential.OAuth): Account {
  const value = credential.metadata as Omit<Account, "access" | "refresh" | "expires"> | undefined;
  if (!value?.walletId || !value.wallet || !value.lane || !value.apiUrl) throw new FossaError("AUTH_INVALID", "Reconnect your Fossa wallet on this computer.");
  return { ...value, access: credential.access, refresh: credential.refresh, expires: credential.expires };
}
function credentialFor(account: Account, method: "quick" | "import") {
  const { access, refresh, expires, ...metadata } = account;
  return Credential.OAuth.make({ type: "oauth", methodID: Integration.MethodID.make(method), access, refresh, expires, metadata });
}
export default Plugin.define({
  id: "fossa",
  async setup(ctx) {
    if (!ctx.app.version.startsWith("2.")) throw Error("Fossa requires OpenCode v2.");
    await lifecycle[drainKey];
    const store = localStore();
    store.lockProtected();
    let apiUrl = safeUrl(await ctx.storage.get("apiUrl") ?? ctx.options.apiUrl ?? DEFAULT_API_URL), controller = new AbortController();
    let cfg: PublicConfig | undefined, catalog: Catalog | undefined, client: FossaClient | undefined, closing = false;
    let transport: Bun.Server<undefined> | undefined, problem: FossaError | undefined;
    let refreshRunning: Promise<void> | undefined, inventoryHash = "", capabilitiesHash = "", inventoryCatalog: Catalog | undefined, lastStatus = "", catalogAt = 0;
    let switching = false, endpointChange: Promise<{ apiUrl: string; defaultApiUrl: string }> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined, failures = 0;
    let rpc: Awaited<ReturnType<typeof ctx.rpc.register<typeof Fossa>>>;
    const setups = new Set<Awaited<ReturnType<typeof quickConnect>>>();
    const interfaces = new Set<string>();
    const status = (): Status => {
      const value: Status = problem || !cfg ? { ...client?.status, stage: problem && !["FOSSA_OFFLINE", "FOSSA_TIMEOUT"].includes(problem.code) ? "error" : "connecting", message: problem ? `${problem.message} Retrying automatically.` : "Connecting to Fossa backend…", paidAtomic: client?.status.paidAtomic ?? "0", connected: false } : client?.status ?? { stage: "connecting", message: "Connect a Fossa wallet with /connect.", paidAtomic: "0", connected: false };
      return { ...value, apiUrl, ...(cfg?.opencode.deviceConnect !== false && cfg ? { siteUrl: cfg.opencode.siteUrl } : {}), security: client ? store.security(client.account.walletId) : { protected: false, unlocked: false } };
    };
    const notify = () => {
      if (!rpc || closing) return;
      const next = status(), serialized = JSON.stringify(next);
      if (serialized === lastStatus) return;
      lastStatus = serialized; void rpc.events.emit("updated", { ...next }).catch(() => { if (lastStatus === serialized) lastStatus = ""; });
    };
    const backend = () => {
      if (switching) throw new FossaError("API_CHANGING", "Fossa API endpoint is changing. Wait for active requests to finish.");
      if (problem) throw problem;
      if (!cfg || !transport) throw new FossaError("FOSSA_CONNECTING", "Fossa backend is connecting. Wait a moment and try again.");
      return { cfg, transport };
    };
    let activating: Promise<FossaClient | undefined> | undefined;
    const active = () => activating ??= (async () => {
      backend();
      const connection = await ctx.integration.connection.active("fossa");
      const credential = connection ? await ctx.integration.connection.resolve(connection) : undefined;
      if (!credential || credential.type !== "oauth") { if (client) store.lock(client.account.walletId); client?.stop(); client = undefined; return; }
      const account = accountFrom(credential);
      if (account.apiUrl !== apiUrl) { if (client) store.lock(client.account.walletId); client?.stop(); client = undefined; return; }
      if (!client || client.account.walletId !== account.walletId || client.account.access !== account.access) {
        client?.stop(); client = undefined; const next = new FossaClient(store, account, notify);
        try { await next.start(); } catch (error) { next.stop(); throw error; }
        if (closing) { next.stop(); return; }
        client = next; inventoryHash = "";
      }
      return client;
    })().finally(() => { activating = undefined; });
    const requireClient = async () => { const value = await active(); if (!value) throw new FossaError("AUTH_REQUIRED", "Run /connect to connect your Fossa account."); return value; };
    const localToken = randomBytes(32).toString("hex");
    function startTransport(cfg: PublicConfig): Bun.Server<undefined> {
      const transport = Bun.serve<undefined>({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, maxRequestBodySize: cfg.opencode.maxRequestBytes, async fetch(request) {
        const url = new URL(request.url), call = request.headers.get("x-fossa-call-id"); let value: FossaClient | undefined;
        if (request.headers.get("host") !== `127.0.0.1:${transport.port}` || request.headers.get("x-fossa-local") !== localToken || request.method !== "POST" || url.pathname !== "/v1/chat/completions" || !call || !/^[0-9a-f-]{36}$/i.test(call)) return Response.json({ error: { message: "Invalid local Fossa transport authorization." } }, { status: 403 });
        const cancel = () => { void value?.cancel(call).catch(() => {}); };
        request.signal.addEventListener("abort", cancel, { once: true });
        try {
          const transportReceivedAt = Date.now(), hookAt = Number(request.headers.get("x-fossa-request-at"));
          const modelRequestAt = Number.isSafeInteger(hookAt) && hookAt > 0 && hookAt <= transportReceivedAt ? hookAt : undefined;
          value = await requireClient();
          if (!store.unlocked(value.account.walletId)) throw new FossaError("WALLET_LOCKED", "Enter your passphrase to unlock your Fossa wallet, then send your message again.");
          const parsed = await request.json() as Record<string, unknown>, model = catalog?.models.find(model => model.id === parsed.model);
          if (!model) throw new FossaError("MODEL_UNAVAILABLE", "Fossa model is no longer available.");
          if (Array.isArray(parsed.tools) && parsed.tools.length && !model.capabilities?.tools) throw new FossaError("TOOLS_UNAVAILABLE", "Selected provider does not support coding tools.");
          const requested = parsed.max_tokens ?? parsed.max_completion_tokens;
          if (requested !== undefined && (!Number.isSafeInteger(requested) || Number(requested) < 1)) throw new FossaError("TOKEN_LIMIT", "Invalid output token limit.");
          delete parsed.max_completion_tokens;
          parsed.max_tokens = Math.min(typeof requested === "number" ? requested : model.settings?.maxTokens ?? model.outputTokens ?? 0, model.outputTokens ?? 0);
          const body = JSON.stringify(parsed);
          const routed = await value.request(call, model.id, body, request.headers.get("x-fossa-session") ?? "", request.headers.get("x-fossa-kind") ?? "primary", request.signal, { modelRequestAt, transportReceivedAt });
          const outbound = new Request(routed.url, { method: "POST", headers: routed.headers, body: routed.body, signal: AbortSignal.any([request.signal, AbortSignal.timeout(Math.max(1, routed.deadline - Date.now()))]), redirect: "error" });
          let response: Response;
          for (let attempt = 0; ; attempt++) {
            const dispatchedAt = Date.now();
            if (!attempt) value.dispatched(call, dispatchedAt);
            const headers = new AbortController(), timeout = setTimeout(() => headers.abort(new Error("Provider response headers timed out.")), 60_000);
            try { response = await fetch(new Request(outbound.clone(), { signal: AbortSignal.any([outbound.signal, headers.signal]) })); }
            finally { clearTimeout(timeout); }
            if (response.ok) break;
            const failure = await readProviderFailure(response, outbound.signal);
            if (attempt >= 9 || !bookingPending(response.status, failure.error)) { response = failure.response; break; }
            await Bun.sleep(cfg.opencode.pollIntervalMs / 20);
          }
          return value.response(outbound, response);
        } catch (error) {
          if (request.signal.aborted) cancel();
          value?.failed(call);
          const message = error instanceof Error ? error.message : "Fossa request failed.", code = error instanceof FossaError ? error.code : "FOSSA_TRANSPORT";
          if (value && code === "WALLET_LOCKED" && request.headers.get("x-fossa-kind") === "primary") void rpc.events.emit("unlockRequired", { requestId: call, sessionID: request.headers.get("x-fossa-session") ?? "", wallet: value.account.wallet }).catch(() => {});
          if (value && request.headers.get("x-fossa-kind") === "primary" && (!value.status.requestId || value.status.requestId === call)) value.publish({ requestId: call, sessionID: request.headers.get("x-fossa-session") ?? "", stage: code === "USDC_REQUIRED" || code === "SOL_REQUIRED" ? "funding" : code === "WALLET_LOCKED" ? "locked" : ["SUBMISSION_UNCERTAIN", "RECOVERY_PENDING"].includes(code) ? "uncertain" : "error", message });
          return Response.json({ error: { message, type: code, code, ...(error instanceof FossaError && error.data ? { data: error.data } : {}) } }, { status: code === "AUTH_REQUIRED" ? 401 : code === "USDC_REQUIRED" || code === "SOL_REQUIRED" || code === "BUDGET_EXCEEDED" ? 402 : 409, headers: { "cache-control": "no-store" } });
        } finally { request.signal.removeEventListener("abort", cancel); }
      } });
      return transport;
    }
    const models = () => cfg ? (catalog?.models ?? []).filter(model => model.contextTokens && model.outputTokens && model.offers.some(offer => offer.active && offer.approved && offer.provider.approved)).map(model => {
      const settings = client?.settings(model.id) ?? defaultSettings;
      const price = rankOffers(eligible(model, settings, 0, 0), settings)[0];
      return Model.Info.make({ ...Model.Info.default(providerID, Model.ID.make(model.id)), name: model.name,
        package: Provider.Package.make("@opencode/ai/providers/openai-compatible"),
        capabilities: { tools: model.capabilities?.tools === true, input: model.modalities.input, output: model.modalities.output },
        compatibility: { reasoningField: "reasoning_content", maxTokensField: "max_tokens", requireFinishReason: true },
        limit: { context: model.contextTokens!, output: model.outputTokens! },
        variants: (model.variants ?? (model.effort ?? []).map(id => ({ id, body: { reasoning_effort: id } }))).map(variant => ({ ...variant, id: Model.VariantID.make(variant.id) })),
        settings: { ...model.settings, maxTokens: Math.min(model.settings?.maxTokens ?? model.outputTokens!, model.outputTokens!) },
        body: model.variants?.at(-1)?.body ?? {},
        cost: price ? [{ input: Model.Cost.fields.input.make(price.inputRate / 1_000_000), output: Model.Cost.fields.input.make(price.outputRate / 1_000_000), cache: { read: Model.Cost.fields.input.make(price.cachedRate / 1_000_000), write: Model.Cost.fields.input.make(price.inputRate / 1_000_000) } }] : [],
      });
    }) : [];
    await ctx.provider.transform(editor => editor.add({ info: { ...Provider.Info.empty(providerID), name: "Fossa", integrationID: Integration.ID.make("fossa"), activation: "enabled", package: Provider.Package.make("@opencode/ai/providers/openai-compatible"), settings: { ...(transport ? { baseURL: `${transport.url.origin}/v1` } : {}), transport: "http" } }, models: models() }));
    await ctx.integration.transform(editor => {
      editor.update("fossa", integration => { integration.name = "Fossa"; });
      editor.method.remove("fossa", { type: "key" });
      for (const method of methods) {
        const enabled = method === "quick" ? cfg?.opencode.deviceConnect !== false : cfg?.opencode.manualImport !== false;
        if (!enabled) { editor.method.remove("fossa", { id: method, type: "oauth", label: "" }); continue; }
        editor.method.update({ integrationID: "fossa", method: { id: method, type: "oauth", label: method === "quick" ? "Quick connect with Fossa website" : "Import a private key", form: method === "import" ? [{ type: "string", key: "key", title: "Solana private key", placeholder: "Base58 private key or keypair JSON array", required: true }] : undefined },
          authorize: async answer => {
            const { cfg } = backend();
            if ((method === "quick" ? cfg.opencode.deviceConnect : cfg.opencode.manualImport) === false) throw new FossaError("AUTH_UNSUPPORTED", "This connection method is unavailable on the selected API.");
            if (method === "import") { const account = await importWallet(store, apiUrl, typeof answer.key === "string" ? answer.key : ""); return { mode: "auto", url: "", instructions: "Wallet encrypted on this computer. Optional passphrase protection is in /fossa → Security.", callback: Promise.resolve(credentialFor(account, method)) }; }
            const setup = await quickConnect(store, apiUrl); setups.add(setup); void setup.completed.then(() => setups.delete(setup), () => setups.delete(setup));
            return { mode: "auto", url: setup.url, instructions: `Approve on Fossa, then return to OpenCode. Wallet installation completes automatically.\nDevice: ${setup.label}\nConnection code: ${setup.code}\nDevice fingerprint: ${setup.fingerprint}`, expiresAt: setup.expires, callback: setup.completed.then(account => credentialFor(account, method)) };
          },
          refresh: async credential => credentialFor(await refreshAccount(accountFrom(credential)), method),
          label: credential => String(credential.metadata?.name ?? "Fossa wallet"),
        });
      }
    });
    rpc = await ctx.rpc.register(Fossa, {
      attach: guarded(async input => {
        const { instance } = input as { instance: string };
        if (!interfaces.has(instance)) { store.lockProtected(); interfaces.add(instance); notify(); }
        return { ok: true };
      }),
      status: async () => { try { await active(); } catch (error) { if (cfg && !problem && !switching) problem = error instanceof FossaError ? error : new FossaError("FOSSA_CONNECTION", error instanceof Error ? error.message : "Fossa unavailable."); } return { ...status() }; },
      endpoint: guarded(async input => {
        const requested = (input as { apiUrl?: string }).apiUrl;
        if (requested === undefined) return { apiUrl, defaultApiUrl: DEFAULT_API_URL };
        const next = safeUrl(requested.trim() || DEFAULT_API_URL);
        if (new URL(next).search || new URL(next).hash) throw Error("Use an API base URL without a query or fragment.");
        if (endpointChange) throw Error("Fossa API endpoint is already changing.");
        if (next === apiUrl) return { apiUrl, defaultApiUrl: DEFAULT_API_URL };
        let restart = false;
        return endpointChange = (async () => {
          const nextConfig = await config(next, controller.signal);
          await ctx.storage.set("apiUrl", next);
          switching = restart = true; controller.abort(); clearTimeout(timer); setups.forEach(setup => setup.stop());
          await transport?.stop(); await refreshRunning; await activating?.catch(() => {}); await client?.drain();
          if (client) store.lock(client.account.walletId);
          if (closing) return { apiUrl: next, defaultApiUrl: DEFAULT_API_URL };
          apiUrl = next; controller = new AbortController(); cfg = nextConfig; catalog = client = transport = problem = undefined;
          inventoryHash = lastStatus = ""; inventoryCatalog = undefined; failures = catalogAt = 0;
          await ctx.integration.reload(); await ctx.provider.reload(); notify();
          return { apiUrl, defaultApiUrl: DEFAULT_API_URL };
        })().finally(() => { endpointChange = undefined; switching = false; if (restart && !closing) void poll(); });
      }),
      wallets: guarded(async () => ({ wallets: store.wallets() })),
      routes: guarded(async input => {
        const session = (input as { session: string }).session;
        return { routes: store.pending().filter(row => row.session === session && row.kind === "inference" && row.flow === "primary" && row.provider).map(row => ({ id: row.id, model: row.model, startedAt: row.startedAt ?? row.created, provider: row.providerName ?? catalog?.models.find(model => model.id === row.model)?.offers.find(offer => offer.provider.wallet === row.provider)?.provider.name ?? row.provider! })) };
      }),
      unlock: guarded(async input => { const value = await requireClient(); await store.unlock(value.account.walletId, (input as { passphrase: string }).passphrase); value.publish({ stage: "idle", message: "Local wallet unlocked." }); return { ok: true }; }),
      lock: guarded(async () => { const value = await requireClient(); if (!store.security(value.account.walletId).protected) throw Error("Enable passphrase protection in Security first."); store.lock(value.account.walletId); value.publish({ stage: "locked", message: "Local wallet locked." }); return { ok: true }; }),
      security: guarded(async input => {
        const value = await requireClient(), { action, passphrase } = input as { action?: "enable" | "disable"; passphrase?: string };
        if (action) {
          if (action === "enable" && passphrase === undefined) throw Error("Enter a passphrase of at least 3 characters.");
          await store.exclusive(value.account.wallet, () => store.protect(value.account, action === "enable" ? passphrase : undefined));
          value.publish({ stage: "idle", message: action === "enable" ? "Passphrase protection enabled." : "Automatic local encryption enabled." });
        }
        return store.security(value.account.walletId);
      }),
      settings: guarded(async input => {
        const { model: modelId, ...patch } = input as Record<string, unknown>;
        if (typeof modelId !== "string" || !catalog?.models.some(model => model.id === modelId)) throw Error("Select a Fossa model first.");
        const value = await requireClient(), settings = validateSettings(patch, value.settings(modelId));
        store.setSettings(value.account.walletId, modelId, settings); notify(); await ctx.provider.reload(); return { settings };
      }),
      model: guarded(async input => {
        const modelId = (input as { model: string }).model, value = await requireClient(), model = value.catalog?.models.find(model => model.id === modelId);
        if (!model) throw Error("Fossa model unavailable.");
        const settings = value.settings(modelId);
        return { id: model.id, name: model.name, settings, outputTokens: model.outputTokens, offers: rankOffers(eligible(model, settings, 0, 0), settings).map(offer => ({ provider: offer.provider.name, wallet: offer.provider.wallet, url: cfg!.opencode.deviceConnect === false ? "" : new URL(`/?provider=${encodeURIComponent(offer.provider.wallet)}`, cfg!.opencode.siteUrl).href, input: offer.inputRate / 1_000_000, cached: offer.cachedRate / 1_000_000, output: offer.outputRate / 1_000_000, speed: offer.speed, zdr: offer.private })) };
      }),
      recover: guarded(async () => {
        const value = await requireClient(); return value.rakeback();
      }),
      rakeback: guarded(async input => {
        const value = await requireClient(), patch = (input as { settings?: unknown }).settings;
        if (patch !== undefined) { store.setRakeback(value.account.walletId, patch); void value.automaticRakeback(); }
        return value.rakebackState();
      }),
    });
    await ctx.session.hook("title", event => { event.result = generate({ exactly: 1, minLength: 4, maxLength: 7, seed: event.sessionID, join: "" }).toLowerCase(); }, { providerID: "fossa" });
    await ctx.session.hook("model.request", event => { event.baseURL = `${backend().transport.url.origin}/v1`; event.headers["x-fossa-call-id"] = randomUUID(); event.headers["x-fossa-request-at"] = String(Date.now()); event.headers["x-fossa-local"] = localToken; event.headers["x-fossa-session"] = event.sessionID; event.headers["x-fossa-kind"] = event.kind; }, { providerID: "fossa" });
    await ctx.session.hook("retry", event => { event.decision = { retry: false }; notify(); }, { providerID: "fossa" });
    function update(): Promise<void> { return refreshRunning ??= (async () => {
      try {
        const cached = (client?.status.connected ? client.catalog : undefined) ?? (catalog && Date.now() - catalogAt < (cfg?.opencode.catalogMaxAgeMs ?? 5000) ? catalog : undefined);
        const [nextConfig, next] = await Promise.all([cfg ? Promise.resolve(cfg) : config(apiUrl, controller.signal), cached ? Promise.resolve(cached) : api<Catalog>(apiUrl, "/market/catalog", { signal: controller.signal }).then(value => { catalogAt = Date.now(); return value; })]);
        if (closing || switching) return;
        if (!Array.isArray(next?.models) || next.programId !== nextConfig.programId || next.market !== nextConfig.market) throw new FossaError("CONFIGURATION", "Fossa catalog does not match its protocol configuration.");
        cfg = nextConfig; catalog = next; transport ??= startTransport(cfg); problem = undefined;
        const capabilities = JSON.stringify([cfg.opencode.deviceConnect, cfg.opencode.manualImport]);
        if (capabilities !== capabilitiesHash) { await ctx.integration.reload(); capabilitiesHash = capabilities; }
        await active();
        if (next !== inventoryCatalog || !inventoryHash) {
          const hash = createHash("sha256").update(JSON.stringify(next.models)).digest("hex");
          if (hash !== inventoryHash) { await ctx.provider.reload(); inventoryHash = hash; }
          inventoryCatalog = next;
        }
        notify();
      } catch (error) { if (!closing && !switching) { problem = error instanceof FossaError ? error : new FossaError("FOSSA_CONNECTION", error instanceof Error ? error.message : "Fossa unavailable."); notify(); } }
      finally { refreshRunning = undefined; }
    })(); }
    async function poll() { if (closing || switching) return; await update(); if (!closing && !switching) { const delay = problem ? Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)) : cfg!.opencode.pollIntervalMs; if (!problem) failures = 0; clearTimeout(timer); timer = setTimeout(() => void poll(), delay); } }
    void poll();
    return () => {
      if (closing) return lifecycle[drainKey];
      closing = true; controller.abort(); clearTimeout(timer); setups.forEach(setup => setup.stop());
      const drain = (async () => {
        try { await endpointChange?.catch(() => {}); await transport?.stop(); }
        finally { await activating?.catch(() => {}); await client?.drain(); store.lockProtected(); }
      })();
      return lifecycle[drainKey] = Promise.allSettled([lifecycle[drainKey], drain]).then(() => {});
    };
  },
});
