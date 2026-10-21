import { randomUUID } from "node:crypto";
import { Plugin } from "@opencode/plugin/tui";
import { createEffect, createMemo, createSignal, onCleanup, untrack } from "opentui:runtime-module:solid-js";
import { Fossa } from "./rpc";
import { installModelPicker } from "./model-picker";
import { createModelSource } from "./model-source";
import { installComposer } from "./composer";
import { installMessageFooters } from "./message-footer";
import { settingsDialog } from "./settings-dialog";
import { openProvider, price } from "./provider-row";
import { defaultRakeback, rakebackAmounts, rakebackDollars, rakebackIntervals } from "./rakeback";
import { errorMessage, type FilterField, type ModelDetails, type RakebackSettings, type RakebackState, type Settings, type Status, type UnlockRequest } from "./types";

const dollars = (value?: string) => value === undefined ? "$—" : `$${(Number(value) / 1_000_000).toFixed(2)}`;
const labels: Record<FilterField, string> = { minSpeed: "Min speed", maxInputPrice: "Input cap", maxCachedPrice: "Cache cap", maxOutputPrice: "Output cap" };

export default Plugin.define({
  id: "fossa.ui",
  setup(context) {
    const models = createModelSource(context), stopModels = installModelPicker(context, models), dialog = settingsDialog(context), rpc = context.client.rpc(Fossa);
    const [state, setState] = createSignal<Status>({ stage: "connecting", connected: false, paidAtomic: "0", message: "Connect Fossa with /connect." });
    const [details, setDetails] = createSignal<ModelDetails>();
    const [modelError, setModelError] = createSignal<string>();
    const [unlockRequest, setUnlockRequest] = createSignal<UnlockRequest>();
    const instance = randomUUID();
    let stopped = false, updating = false, loadingModel = false, attached = false, lastUnlockRequest = "";
    const sync = async () => {
      if (updating || stopped) return; updating = true;
      try {
        if (!attached) { await rpc.attach({ instance }); attached = true; }
        const value = await rpc.status({}) as Status; if (!stopped) setState(value);
      } catch { if (!stopped) setState(value => ({ ...value, connected: false })); }
      finally { updating = false; }
    };
    const refreshModel = async () => {
      const selected = context.ui.model.current(); if (selected?.providerID !== "fossa" || loadingModel || stopped) return;
      loadingModel = true;
      try { const value = await models.get(selected.modelID, true); if (!stopped && context.ui.model.current()?.modelID === selected.modelID) setDetails(value); }
      catch (error) { if (!stopped && context.ui.model.current()?.modelID === selected.modelID) setModelError(errorMessage(error)); }
      finally { loadingModel = false; }
    };
    const modelKey = createMemo(() => { const selected = context.ui.model.current(); return selected ? `${selected.providerID}/${selected.modelID}` : ""; });
    createEffect(() => {
      const key = modelKey(); setDetails(undefined); setModelError(undefined);
      if (key.startsWith("fossa/")) onCleanup(models.watch(context.ui.model.current()!.modelID, (value, error) => { if (!stopped) { setDetails(value); setModelError(error); } }));
    });
    const stopEvents = rpc.events.on("updated", event => { setState(value => ({ ...value, ...event.data })); });
    const stopUnlock = rpc.events.on("unlockRequired", event => {
      const request = event.data as unknown as UnlockRequest;
      if (request.requestId === lastUnlockRequest || stopped) return;
      lastUnlockRequest = request.requestId; setUnlockRequest(request);
    });
    const timer = setInterval(() => void sync(), 5000); void sync();
    const problem = (error: unknown) => context.ui.toast.show({ title: "Fossa", message: errorMessage(error), variant: "error", duration: 6000 });
    const currentModel = async () => {
      const selected = context.ui.model.current(); if (selected?.providerID !== "fossa") throw Error("Select a Fossa model first.");
      return await models.get(selected.modelID);
    };
    const save = async (model: string, patch: Partial<Omit<Settings, FilterField>> & Partial<Record<FilterField, number | null>>) => {
      await rpc.settings({ model, ...patch }); await refreshModel();
    };
    const editFilter = async (field: FilterField) => {
      const model = await currentModel();
      while (dialog.active() && !stopped) {
        const raw = await dialog.prompt({ title: labels[field], description: `${field === "minSpeed" ? "Tokens per second" : "Price per 1M tokens"}. Leave blank for Auto.`, value: String(field === "minSpeed" ? model.settings.minSpeed || "" : model.settings[field] ?? ""), placeholder: "Auto" });
        if (raw === undefined) return;
        const value = raw.trim() ? Number(raw) : field === "minSpeed" ? 0 : null;
        try {
          if (value !== null && (!Number.isFinite(value) || value < 0 || (field === "minSpeed" ? !Number.isSafeInteger(value) || value > 65535 : value > 4294))) throw Error(field === "minSpeed" ? "Enter a whole number from 0 to 65,535, or leave blank for Auto." : "Enter a price from $0 to $4,294, or leave blank for Auto.");
          await save(model.id, { [field]: value }); return;
        } catch (error) { problem(error); }
      }
    };
    const prices = async () => {
      while (dialog.active() && !stopped) {
        const model = await currentModel(), fields = ["maxInputPrice", "maxOutputPrice", "maxCachedPrice"] as const;
        const field = await dialog.select({ title: "Price", options: fields.map(field => ({ title: labels[field], footer: model.settings[field] === undefined ? "Auto" : price(model.settings[field]!), category: "Per 1M tokens", value: field })) });
        if (!field) return; await editFilter(field as FilterField);
      }
    };
    const external = (run: () => Promise<void>) => async () => {
      if (dialog.active()) return; dialog.begin();
      try { await run(); } catch (error) { problem(error); } finally { dialog.close(); }
    };
    const unlock = async () => {
      let message: string | undefined;
      while (dialog.active() && !stopped) {
        const passphrase = await dialog.prompt({ title: "Unlock Fossa wallet", description: message ?? "Enter your wallet passphrase." });
        if (passphrase === undefined) return false;
        try { await rpc.unlock({ passphrase }); await sync(); return true; }
        catch (error) { message = errorMessage(error); }
      }
      return false;
    };
    createEffect(() => {
      const request = unlockRequest(), route = context.ui.router.current();
      if (!request || stopped || dialog.active() || context.keymap.mode.current() === "modal" || route.type !== "session" || route.sessionID !== request.sessionID) return;
      untrack(() => {
        setUnlockRequest(undefined);
        void external(async () => {
          const value = await rpc.status({}) as Status;
          if (stopped || value.wallet !== request.wallet || value.security?.unlocked) return;
          if (await unlock()) context.ui.toast.show({ title: "Wallet unlocked", message: "Send your message again.", variant: "success" });
        })();
      });
    });
    const security = async () => {
      while (dialog.active() && !stopped) {
        const value = await rpc.security({}) as { protected: boolean; unlocked: boolean };
        const choice = await dialog.select({ title: "Security", options: value.protected ? [
          { title: value.unlocked ? "Lock wallet" : "Unlock wallet", value: value.unlocked ? "lock" : "unlock" },
          { title: "Change passphrase", value: "enable" }, { title: "Remove passphrase", value: "disable" },
        ] : [{ title: "Enable passphrase", value: "enable" }] });
        if (!choice) return;
        try {
          if (choice === "lock") await rpc.lock({});
          else if (choice === "unlock") await unlock();
          else {
            if (value.protected && !value.unlocked) { await unlock(); if (!(await rpc.security({}) as { unlocked: boolean }).unlocked) continue; }
            if (choice === "enable") {
              const passphrase = await dialog.prompt({ title: "Set passphrase", description: "At least 3 characters. Required to unlock after restarting OpenCode." });
              if (passphrase === undefined) continue; await rpc.security({ action: "enable", passphrase });
            } else await rpc.security({ action: "disable" });
          }
          await sync();
        } catch (error) { problem(error); }
      }
    };
    const endpoint = async () => {
      const current = await rpc.endpoint({}) as { apiUrl: string; defaultApiUrl: string };
      const apiUrl = await dialog.prompt({ title: "API endpoint", description: "Compatible Fossa API base URL. HTTPS required; localhost may use HTTP. Leave blank for default.", placeholder: current.defaultApiUrl, value: current.apiUrl });
      if (apiUrl === undefined) return;
      const selection = dialog.select({ title: "API endpoint", message: "Active requests finish before switching.", options: [{ title: "Connecting", value: "pending", loading: true, disabled: true }] });
      try {
        const updated = await rpc.endpoint({ apiUrl }) as { apiUrl: string };
        if (updated.apiUrl !== current.apiUrl) { models.invalidate(); setDetails(undefined); await sync(); }
        dialog.update("API endpoint", { message: updated.apiUrl === current.apiUrl ? "API endpoint unchanged." : "API endpoint saved. Connect a wallet for this endpoint with /connect." });
      } catch (error) { dialog.update("API endpoint", { message: errorMessage(error) }); }
      finally { dialog.update("API endpoint", { options: [{ title: "Back", value: "back" }] }); }
      await selection;
    };
    const methodology = async () => {
      const model = await currentModel(), modes = ["balanced", "cheapest", "fastest"] as const;
      const mode = await dialog.select({ title: "Methodology", current: model.settings.mode, options: modes.map(mode => ({ title: mode[0].toUpperCase() + mode.slice(1), value: mode })) });
      if (mode) await save(model.id, { mode: mode as Settings["mode"] });
    };
    const retention = async () => {
      const model = await currentModel();
      const value = await dialog.select({ title: "Data retention", current: model.settings.zdrOnly ? "on" : "off", options: [{ title: "Off", value: "off" }, { title: "Zero data retention only", value: "on" }] });
      if (value) await save(model.id, { zdrOnly: value === "on" });
    };
    const rakeback = async () => {
      let info: RakebackState = { ...defaultRakeback, availableAtomic: "0", processing: false, needsRecovery: false, message: "" };
      let loaded = false, editing = false, refreshing = false, running = false, closed = false;
      const frequency = (minutes: number) => minutes === 15 ? "15 min" : minutes === 60 ? "1 hour" : "6 hours";
      const field = (footer: string) => ({ footer: loaded ? footer : info.message ? "—" : undefined, loading: !loaded && !info.message });
      const page = (value: RakebackState) => ({
        title: "Rakeback", message: value.message || undefined,
        options: [
          { title: "Available", value: "available", ...field(rakebackDollars(value.availableAtomic)), disabled: true },
          { title: value.processing ? "Processing…" : "Rakeback now", value: "run", disabled: !loaded || value.processing || value.availableAtomic === "0" && !value.needsRecovery },
          { title: "Automatic rakeback", value: "auto", ...field(value.autoRakeback ? "On" : "Off"), disabled: !loaded },
          ...(!loaded || value.autoRakeback ? [
            { title: "Trigger", value: "trigger", ...field(value.rakebackMode === "interval" ? "Time" : "Amount"), disabled: !loaded },
            { title: value.rakebackMode === "interval" ? "Frequency" : "Minimum amount", value: "limit", ...field(value.rakebackMode === "interval" ? frequency(value.rakebackIntervalMinutes) : rakebackDollars(value.rakebackThresholdAtomic)), disabled: !loaded },
          ] : []),
          ...(!loaded && value.message ? [{ title: "Retry", value: "retry" }] : []),
        ],
      });
      const refresh = async () => {
        if (closed || editing || refreshing || running || stopped) return; refreshing = true;
        if (!loaded) { info = { ...info, message: "" }; dialog.update("Rakeback", page(info)); }
        try { const value = await rpc.rakeback({}) as RakebackState; if (!closed && !editing && !running) { info = value; loaded = true; dialog.update("Rakeback", page(info)); } }
        catch (error) { if (!closed && !editing && !running) { info = { ...info, message: errorMessage(error) }; dialog.update("Rakeback", page(info)); } }
        finally { refreshing = false; }
      };
      const saveRakeback = async (settings: Partial<RakebackSettings>) => { info = await rpc.rakeback({ settings }) as RakebackState; };
      const timer = setInterval(() => void refresh(), 10_000);
      try {
        while (dialog.active() && !stopped) {
          editing = false;
          const selection = dialog.select(page(info));
          if (!loaded) void refresh();
          const choice = await selection; editing = true;
          if (!choice) return;
          if (!loaded) continue;
          try {
            if (choice === "run") {
              running = true; info = { ...info, processing: true, message: "Processing rakeback…" };
              void (async () => {
                try {
                  const result = await rpc.recover({}) as { kind: string; amountAtomic: string };
                  if (!stopped && result.kind === "complete") context.ui.toast.show({ title: "Rakeback complete", message: `Recovered ${rakebackDollars(result.amountAtomic)}.`, variant: "success" });
                  await sync();
                  if (!closed) {
                    try { info = await rpc.rakeback({}) as RakebackState; }
                    catch { info = { ...info, processing: false, message: result.kind === "complete" ? "Rakeback complete. Balance update unavailable." : "Balance update unavailable." }; }
                    if (result.kind === "busy") info = { ...info, message: "Rakeback already running." };
                  }
                } catch (error) { if (!closed) info = { ...info, processing: false, message: errorMessage(error) }; else if (!stopped) problem(error); }
                finally { running = false; if (!closed) dialog.update("Rakeback", page(info)); }
              })();
            } else if (choice === "auto") await saveRakeback({ autoRakeback: !info.autoRakeback });
            else if (choice === "trigger") {
              const mode = await dialog.select({ title: "Trigger", current: info.rakebackMode, options: [{ title: "Time", value: "interval" }, { title: "Amount", value: "amount" }] });
              if (mode) await saveRakeback({ rakebackMode: mode as RakebackSettings["rakebackMode"] });
            } else if (choice === "limit") {
              if (info.rakebackMode === "interval") {
                const value = await dialog.select({ title: "Frequency", current: String(info.rakebackIntervalMinutes), options: rakebackIntervals.map(minutes => ({ title: frequency(minutes), value: String(minutes) })) });
                if (value) await saveRakeback({ rakebackIntervalMinutes: Number(value) });
              } else {
                const value = await dialog.select({ title: "Minimum amount", current: info.rakebackThresholdAtomic, options: rakebackAmounts.map(amount => ({ title: rakebackDollars(amount), value: amount })) });
                if (value) await saveRakeback({ rakebackThresholdAtomic: value });
              }
            }
          } catch (error) { info = { ...info, processing: false, message: errorMessage(error) }; }
        }
      } finally { closed = true; clearInterval(timer); }
    };
    const account = async () => {
      let closed = false, previous = "";
      const page = () => ({ title: "Account", options: [
        { title: "Wallet", value: "wallet", footer: state().wallet ?? "Not connected", disabled: !state().wallet },
        { title: "Balance", value: "balance", footer: dollars(state().balanceAtomic), disabled: !state().wallet || !state().siteUrl },
      ] });
      const refresh = () => {
        const key = `${state().wallet}:${state().balanceAtomic}:${state().siteUrl}`;
        if (!closed && key !== previous) { previous = key; dialog.update("Account", page()); }
      };
      const timer = setInterval(refresh, 1000);
      void sync().then(refresh);
      try {
        while (dialog.active() && !stopped) {
          const choice = await dialog.select(page());
          if (!choice) return;
          if (choice === "wallet") openProvider(context, `https://solscan.io/account/${state().wallet}`, "Wallet");
          else if (choice === "balance") {
            const action = await dialog.select({ title: "Balance", options: [{ title: "Deposit", value: "deposit" }, { title: "Withdraw", value: "withdraw" }] });
            if (action && state().siteUrl && state().wallet) {
              const url = new URL(state().siteUrl!);
              url.searchParams.set("wallet", action); url.searchParams.set("address", state().wallet!);
              openProvider(context, url.href, action === "deposit" ? "Deposit" : "Withdraw");
            }
          }
        }
      } finally { closed = true; clearInterval(timer); }
    };
    const menu = async () => {
      let settings = details()?.settings, amount: string | undefined, modelLoading = context.ui.model.current()?.providerID === "fossa", amountLoading = true, closed = false;
      const page = () => ({ title: "Fossa Settings", search: true, options: [
        { title: "Account", value: "status", category: "Wallet" },
        { title: "Security", value: "security", category: "Wallet" },
        { title: "Saved wallets", value: "wallets", category: "Wallet" },
        { title: "Rakeback", value: "rakeback", category: "Wallet", footer: amount === undefined ? "—" : rakebackDollars(amount), loading: amountLoading },
        { title: "Methodology", value: "methodology", category: "Routing", footer: settings ? settings.mode[0].toUpperCase() + settings.mode.slice(1) : "—", loading: !settings && modelLoading },
        { title: "Data retention", value: "retention", category: "Routing", footer: settings ? settings.zdrOnly ? "Zero data retention only" : "Off" : "—", loading: !settings && modelLoading },
        { title: "API endpoint", value: "endpoint", category: "Routing" },
        { title: "Model pane", value: "model-pane", category: "Appearance", footer: stopModels.enabled() ? "On" : "Off" },
      ] });
      const selection = dialog.select(page()), update = () => { if (!closed && !stopped) dialog.update("Fossa Settings", page()); };
      void currentModel().then(model => { settings = model.settings; }, () => { settings = undefined; }).finally(() => { modelLoading = false; update(); });
      void rpc.rakeback({}).then(value => { amount = (value as RakebackState).availableAtomic; }, () => {}).finally(() => { amountLoading = false; update(); });
      try { return await selection; } finally { closed = true; }
    };
    const show = async (action?: string) => {
      if (dialog.active()) return; dialog.begin();
      let next = action?.trim().replace(/^\/fossa(?:\s+|$)/, "");
      try {
        while (dialog.active() && !stopped) {
          try {
            const value = next || await menu();
            next = undefined; if (!value) return;
            if (value === "status") await account();
            else if (value === "unlock") await unlock();
            else if (value === "lock") { await rpc.lock({}); await sync(); }
            else if (value === "security") await security();
            else if (value === "endpoint") await endpoint();
            else if (value === "methodology") await methodology();
            else if (value === "retention") await retention();
            else if (value === "rakeback" || value === "recover") await rakeback();
            else if (value === "model-pane") {
              const value = await dialog.select({ title: "Model pane", current: stopModels.enabled() ? "on" : "off", options: [{ title: "On", value: "on" }, { title: "Off", value: "off" }] });
              if (value && (value === "on") !== stopModels.enabled()) await stopModels.toggle();
            }
            else if (value === "wallets") {
              const result = await rpc.wallets({}) as { wallets: { id: string; name: string; address: string }[] };
              if (!result.wallets.length) { await dialog.alert({ title: "Saved wallets", message: "Connect a wallet with /connect." }); continue; }
              const credentials = (await context.client.credential.list()).filter(entry => entry.integrationID === "fossa").sort((a, b) => Number(b.active) - Number(a.active));
              const candidates = result.wallets.map(wallet => { const entry = credentials.find(entry => entry.value.metadata?.walletId === wallet.id), compatible = !!state().apiUrl && entry?.value.metadata?.apiUrl === state().apiUrl; return { ...wallet, credentialId: entry?.id, active: !!entry?.active && compatible, compatible }; });
              const saved = new Map<string, (typeof candidates)[number]>(), priority = (wallet: (typeof candidates)[number]) => wallet.active ? 3 : wallet.compatible ? 2 : wallet.credentialId ? 1 : 0;
              for (const wallet of candidates) {
                const previous = saved.get(wallet.address);
                if (!previous || priority(wallet) > priority(previous)) saved.set(wallet.address, wallet);
              }
              const wallets = [...saved.values()];
              const selected = await dialog.select({ title: "Saved wallets", search: wallets.length > 8, options: wallets.map(wallet => ({ title: wallet.address, value: wallet.credentialId ?? wallet.id, description: !wallet.credentialId ? "Reconnect with /connect" : !wallet.compatible ? "Uses another API endpoint" : undefined, disabled: !wallet.credentialId || !wallet.compatible })), current: wallets.find(wallet => wallet.active)?.credentialId });
              if (selected) { await context.client.credential.activate({ credentialID: selected }); await sync(); await refreshModel(); }
            }
          } catch (error) { problem(error); }
        }
      } finally { dialog.close(); }
    };
    const openPrice = external(prices), openSpeed = external(() => editFilter("minSpeed"));
    context.keymap.layer(() => ({ mode: "global", commands: [
      { id: "fossa.status", title: "Fossa Settings", group: "Fossa", palette: true, slash: { name: "fossa", arguments: true }, run: show },
      { id: "fossa.unlock", title: "Unlock Fossa wallet", group: "Fossa", palette: true, enabled: () => state().security?.protected === true && !state().security?.unlocked, run: external(async () => { await unlock(); }) },
      { id: "fossa.lock", title: "Lock Fossa wallet", group: "Fossa", palette: true, enabled: () => state().security?.protected === true && state().security?.unlocked === true, run: external(async () => { await rpc.lock({}); await sync(); }) },
    ] }));
    const stopComposer = installComposer(context, details, () => dollars(state().balanceAtomic), openPrice, openSpeed, modelError);
    const stopFooters = installMessageFooters(context);
    return () => { stopped = true; clearInterval(timer); stopEvents(); stopUnlock(); stopFooters(); stopComposer(); stopModels(); models.dispose(); dialog.close(); };
  },
});
