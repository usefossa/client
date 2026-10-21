import type { TextNodeRenderable, TextRenderable } from "@opentui/core";
import type { SessionMessageAssistant } from "@opencode/client";
import type { Context } from "@opencode/plugin/tui/context";
import { Fossa } from "./rpc";
import type { RoutedRequest } from "./types";
import { createEffect, createMemo, createSignal, untrack } from "solid-js";
import { visibleNodes } from "./render-tree";

// native v2 has no assistant-footer slot; append a host text span without replacing its styles.
export function installMessageFooters(context: Context) {
  const rpc = context.client.rpc(Fossa), labels = new Map<TextRenderable, TextNodeRenderable>();
  const session = createMemo(() => { const route = context.ui.router.current(); return route.type === "session" ? route.sessionID : ""; });
  const messages = createMemo(() => session() ? context.data.session.message.list(session()) : []);
  const byID = createMemo(() => new Map(messages().map(message => [message.id, message])));
  const names = createMemo(() => new Map((context.data.location.model.list(context.location) ?? []).filter(model => model.providerID === "fossa").map(model => [model.id, model.name])));
  const [routes, setRoutes] = createSignal<RoutedRequest[]>([]);
  let loading = false, queued = false, stopped = false, dirty = true, scannedAt = 0, matched = "";
  let retry: ReturnType<typeof setTimeout> | undefined;
  const refresh = async () => {
    const id = session();
    if (!id || stopped || !messages().some(message => message.type === "assistant" && message.model.providerID === "fossa")) return;
    if (loading) { queued = true; return; }
    clearTimeout(retry); retry = undefined;
    loading = true;
    try {
      const value = await rpc.routes({ session: id }) as { routes: RoutedRequest[] };
      if (!stopped && session() === id) {
        const previous = routes();
        if (value.routes.length !== previous.length || value.routes.some((row, index) => row.id !== previous[index].id || row.provider !== previous[index].provider || row.model !== previous[index].model || row.startedAt !== previous[index].startedAt)) { setRoutes(value.routes); dirty = true; context.renderer.requestRender(); }
      }
    }
    catch { if (!stopped) retry = setTimeout(() => void refresh(), 2000); }
    finally { loading = false; if (queued && !stopped) { queued = false; void refresh(); } }
  };
  const draw = async () => {
    if (!session() || !routes().length) return;
    const now = performance.now();
    if (!dirty && now - scannedAt < 250) return;
    scannedAt = now; dirty = false;
    const list = messages(), matchedRoutes = routes(), inventory = names(), index = byID();
    const seen = new Set<TextRenderable>();
    let current: SessionMessageAssistant | undefined;
    for (const node of visibleNodes(context.renderer.root)) {
      const id = node.id.startsWith("session-part:") ? node.id.split(":")[1] : node.id;
      const message = index.get(id);
      if (message) current = message.type === "assistant" ? message : undefined;
      if (!current) continue;
      if (current.model.providerID !== "fossa") continue;
      if (!("plainText" in node) || typeof node.plainText !== "string" || !("getTextChildren" in node) || typeof node.getTextChildren !== "function") continue;
      const name = inventory.get(current.model.id) ?? `fossa/${current.model.id}`;
      if (!node.plainText.toLowerCase().startsWith(`${current.agent} · ${name}`.toLowerCase())) continue;
      const next = list.find(message => message.type === "assistant" && message.time.created > current!.time.created);
      const end = current.time.completed ?? (next?.type === "assistant" ? next.time.created - 1 : Infinity);
      const matched = matchedRoutes.findLast(row => row.model === current!.model.id && row.startedAt >= current!.time.created && row.startedAt <= end);
      if (!matched) continue;
      const text = node as TextRenderable; seen.add(text);
      let label = labels.get(text);
      if (!label || !text.getTextChildren().includes(label)) {
        const sample = text.getTextChildren().find(child => "fg" in child && "children" in child);
        if (!sample) continue;
        const Span = sample.constructor as typeof TextNodeRenderable;
        label = new Span({ id: `fossa-route-${current.id}`, fg: context.theme.text.muted }); text.add(label); labels.set(text, label);
      }
      const content = ` · ${matched.provider}`;
      if (label.children[0] !== content) label.children = [content];
      if (label.fg !== context.theme.text.muted) label.fg = context.theme.text.muted;
    }
    for (const [text, label] of labels) if (!seen.has(text)) { if (!text.isDestroyed) text.remove(label); labels.delete(text); }
  };
  createEffect(() => {
    session(); setRoutes([]); dirty = true; matched = ""; clearTimeout(retry);
    for (const [text, label] of labels) if (!text.isDestroyed) text.remove(label);
    labels.clear();
  });
  createEffect(() => { messages().filter(message => message.type === "assistant" && message.model.providerID === "fossa").map(message => message.id); untrack(() => void refresh()); });
  const stopEvents = rpc.events.on("updated", event => {
    if (!event.data.provider || event.data.sessionID !== session()) return;
    const key = `${event.data.requestId}:${event.data.provider}`;
    if (key !== matched) { matched = key; void refresh(); }
  });
  context.renderer.setFrameCallback(draw);
  return () => {
    stopped = true; clearTimeout(retry); stopEvents(); context.renderer.removeFrameCallback(draw);
    for (const [text, label] of labels) if (!text.isDestroyed) text.remove(label);
    labels.clear();
  };
}
