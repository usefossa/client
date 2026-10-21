import type { BoxRenderable, ScrollBoxRenderable, TextRenderable, Renderable } from "@opentui/core";
import type { Context } from "@opencode/plugin/tui/context";
import { createEffect, createRoot, untrack } from "solid-js";
import { createModelSource, type ModelSource } from "./model-source";
import { openProvider } from "./provider-row";
import { isText, textOf, visibleNodes } from "./render-tree";
import type { ModelDetails } from "./types";

const commandId = "fossa.model-pane.toggle", gap = 2;
const bindings = ["ctrl+g", "ctrl+y", "ctrl+]", "ctrl+\\"];
const normalize = (value: string) => value.toLowerCase().replace(/\s/g, "");
function freeBinding(context: Context) {
  const used = new Set(context.keymap.commands().filter(command => command.id !== commandId).flatMap(command => command.id ? context.keymap.shortcuts(command.id) : command.bind ? [command.bind] : []).map(normalize));
  return bindings.find(bind => !used.has(normalize(bind))) ?? false;
}

function dialogShell(node: Renderable | null, width: number, height: number) {
  for (; node?.parent; node = node.parent) if (!node.id.startsWith("fossa-") && node.width < width - 2 && node.height < height - 1
    && Math.abs(node.parent.width - width) <= 1 && Math.abs(node.parent.height - height) <= 1) return node;
}

type Row = { box: BoxRenderable; dot: TextRenderable; name: TextRenderable; detail: TextRenderable; url: string };

// native constructors keep opentui inside the host's rendering runtime.
export function installModelPicker(context: Context, suppliedSource?: ModelSource) {
  return createRoot(disposeRoot => {
    const source = suppliedSource ?? createModelSource(context), renderer = context.renderer;
    const [appearance, saveAppearance] = context.storage.store("appearance", { initial: { modelPane: true } });
    let pendingEnabled: boolean | undefined, toggleRevision = 0, saving = Promise.resolve();
    const enabled = () => pendingEnabled ?? appearance.modelPane !== false;
    const toggle = async () => {
      const next = !enabled(), revision = ++toggleRevision;
      pendingEnabled = next;
      if (!next) clear();
      renderer.requestRender();
      try { await (saving = saving.catch(() => {}).then(() => saveAppearance(draft => { draft.modelPane = next; }))); }
      finally { if (revision === toggleRevision) pendingEnabled = undefined; renderer.requestRender(); }
    };
    const binding = untrack(() => freeBinding(context));
    context.keymap.layer(() => ({ mode: "global", commands: [{ id: commandId, title: "Toggle Fossa model pane", group: "Fossa", palette: true, bind: binding, run: () => { void toggle().catch(error => context.ui.toast.show({ title: "Fossa", message: String(error), variant: "error" })); } }] }));
    const active = () => context.keymap.commands().some(command => command.id === "model.dialog.favorite");
    let inventory: unknown, cachedModels: { id: string; name: string }[] = [], providers: unknown, cachedCategories = new Set<string>();
    const models = () => { const next = context.data.location.model.list(context.location); if (next !== inventory) { inventory = next; cachedModels = (next ?? []).filter(model => model.providerID === "fossa"); } return cachedModels; };
    const categories = () => { const next = context.data.location.provider.list(context.location); if (next !== providers) { providers = next; cachedCategories = new Set(["Recent", "Favorites", ...(next ?? []).map(provider => provider.name)]); } return cachedCategories; };
    let selector: Renderable | undefined, scroll: ScrollBoxRenderable | undefined, category: TextRenderable | undefined;
    let host: Renderable | undefined, left: Renderable["left"], top: Renderable["top"], frame: BoxRenderable | undefined;
    let title: TextRenderable | undefined, heading: TextRenderable | undefined, message: TextRenderable | undefined, panel: ScrollBoxRenderable | undefined;
    let footer: BoxRenderable | undefined, shortcut: TextRenderable | undefined, selected = "", sample: TextRenderable | undefined;
    let latest: ModelDetails | undefined, failure: string | undefined, unwatch: (() => void) | undefined, stopped = false;
    let palette: unknown[] = [], rows: Row[] = [], painted: ModelDetails | undefined, paintedError: string | undefined;
    // native layout skips undefined positions; auto clears the previous offset.
    const restore = () => {
      if (host && !host.isDestroyed && (host.left !== (left ?? "auto") || host.top !== (top ?? "auto"))) host.setPosition({ left: left ?? "auto", top: top ?? "auto" });
    };
    const clear = () => {
      unwatch?.(); unwatch = undefined; restore();
      if (frame && !frame.isDestroyed) { frame.parent?.remove(frame); frame.destroyRecursively(); }
      host = frame = panel = footer = undefined; title = heading = message = shortcut = sample = undefined;
      selected = ""; latest = painted = undefined; failure = paintedError = undefined; palette = []; rows = [];
    };
    const draw = () => {
      if (!frame || !panel || !sample || frame.isDestroyed) return;
      const theme = context.theme.surface("dialog"), ink = context.theme.text;
      const accent = category?.fg ?? theme.hue.accent[200];
      const blue = theme.hue.interactive[200];
      const colors = [theme.background.base, ink.base, ink.muted, accent, blue, sample.attributes];
      const changed = colors.some((color, index) => color !== palette[index]);
      const key = context.keymap.shortcuts(commandId)[0] ?? "";
      if (shortcut && shortcut.plainText !== key) shortcut.content = key;
      if (!changed && painted === latest && paintedError === failure) return;
      palette = colors; painted = latest; paintedError = failure;
      frame.backgroundColor = theme.background.base;
      title!.fg = ink.base; title!.attributes = sample.attributes & 1;
      heading!.fg = accent; heading!.attributes = 1;
      shortcut!.fg = ink.muted;
      for (const child of footer!.getChildren()) if (isText(child) && child !== shortcut) child.fg = ink.base;
      const offers = latest?.offers ?? [], Text = sample.constructor as typeof TextRenderable, Box = host!.constructor as typeof BoxRenderable;
      while (rows.length > offers.length) { const row = rows.pop()!; panel.remove(row.box); row.box.destroyRecursively(); }
      offers.forEach((offer, index) => {
        let row = rows[index];
        if (!row) {
          const box = new Box(renderer, { id: "fossa-picker-provider-" + index, flexDirection: "row", paddingLeft: 3, paddingRight: 3, gap: 1, height: 1, flexShrink: 0 });
          const dot = new Text(renderer, { width: 1, flexShrink: 0, wrapMode: "none" });
          const name = new Text(renderer, { paddingLeft: 1, flexGrow: 1, minWidth: 0, wrapMode: "none", overflow: "hidden" });
          const detail = new Text(renderer, { flexShrink: 0, wrapMode: "none" });
          row = { box, dot, name, detail, url: offer.url }; box.add(dot); box.add(name); box.add(detail); panel!.add(box); rows.push(row);
          const target = row; box.onMouseUp = () => openProvider(context, target.url);
        }
        const detail = [offer.input, offer.output, offer.cached].map(value => value.toFixed(2)).join("/") + "  " + offer.speed + " T/S";
        if (row.name.plainText !== offer.provider) row.name.content = offer.provider;
        if (row.detail.plainText !== detail) row.detail.content = detail;
        const dot = index === 0 ? "●" : " ";
        if (row.dot.plainText !== dot) row.dot.content = dot;
        row.url = offer.url; row.dot.fg = blue; row.name.fg = index === 0 ? blue : ink.base; row.detail.fg = ink.muted;
      });
      message!.visible = !offers.length;
      message!.fg = ink.muted;
      message!.content = failure ?? (latest ? "No matching providers." : "Loading providers…");
    };
    const discover = () => {
      const focused = dialogShell(renderer.currentFocusedRenderable, renderer.width, renderer.height);
      if (focused) selector = focused;
      if (!selector || selector.isDestroyed || !selector.parent) {
        selector = undefined;
        for (const node of visibleNodes(renderer.root)) if ("scrollTo" in node && "viewport" in node) {
          const shell = dialogShell(node, renderer.width, renderer.height);
          if (shell) { selector = shell; break; }
        }
      }
      if (!selector) return;
      if (!scroll || scroll.isDestroyed || dialogShell(scroll, renderer.width, renderer.height) !== selector) {
        scroll = undefined; category = undefined;
        for (const node of visibleNodes(selector)) if ("scrollTo" in node && "viewport" in node) { scroll = node as ScrollBoxRenderable; break; }
      }
      return scroll;
    };
    const position = () => {
      if (!host?.parent || !frame) return;
      const parent = host.parent, side = host.width * 2 + gap <= renderer.width - 2;
      const offsetLeft = side ? (typeof left === "number" ? left : 0) - Math.ceil((host.width + gap) / 2) : left ?? "auto";
      const baseY = host.y - (typeof host.top === "number" ? host.top : 0) + (typeof top === "number" ? top : 0);
      const lift = side ? 0 : Math.max(0, baseY + host.height * 2 + gap + 1 - renderer.height);
      const offsetTop = lift ? (typeof top === "number" ? top : 0) - lift : top ?? "auto";
      if (host.left !== offsetLeft || host.top !== offsetTop) host.setPosition({ left: offsetLeft, top: offsetTop });
      const x = host.x - parent.x + (side ? host.width + gap : 0), y = host.y - parent.y + (side ? 0 : host.height + gap);
      if (frame.left !== x) frame.left = x;
      if (frame.top !== y) frame.top = y;
      if (frame.width !== host.width) frame.width = host.width;
      if (frame.height !== host.height) frame.height = host.height;
    };
    const scan = async () => {
      if (stopped) return;
      if (!active() || !enabled()) { if (frame) clear(); if (!active()) { selector = scroll = category = undefined; } return; }
      const list = discover();
      if (!list || !selector) { if (frame) clear(); return; }
      const theme = context.theme.surface("dialog");
      let chosen: { model: string; sample: TextRenderable } | undefined;
      for (const node of visibleNodes(list)) {
        if (!isText(node)) continue;
        const text = node.plainText;
        if (node.attributes & 1 && categories().has(text)) category = node;
        let highlighted = false, row: Renderable | null = node.parent;
        for (; row && row !== list; row = row.parent) if ("backgroundColor" in row && (row as BoxRenderable).backgroundColor.equals(theme.background.action.primary.focused)) { highlighted = true; break; }
        if (!highlighted) continue;
        const model = models().find(model => text === model.name || text.startsWith(model.name + " "));
        if (model && (text.endsWith(" Fossa") || [...visibleNodes(row!)].some(child => textOf(child) === "Fossa") || category?.plainText === "Fossa")) chosen = { model: model.id, sample: node };
        // one native row is highlighted; other rows cannot select this panel.
        if (model || text !== "●" && text !== "▪" && text.trim()) break;
      }
      const side = selector.width * 2 + gap <= renderer.width - 2;
      if (!chosen || !side && selector.height * 2 + gap > renderer.height - 2) { if (frame) clear(); return; }
      if (host !== selector || !frame || frame.isDestroyed) {
        clear(); host = selector; left = host.left; top = host.top; sample = chosen.sample;
        const Box = host.constructor as typeof BoxRenderable, Text = sample.constructor as typeof TextRenderable, Scroll = list.constructor as typeof ScrollBoxRenderable;
        frame = new Box(renderer, { id: "fossa-picker-frame", position: "absolute", paddingTop: 1, paddingBottom: 1, gap: 1, onMouseUp: event => event.stopPropagation() });
        const header = new Box(renderer, { paddingLeft: 4, paddingRight: 4, flexShrink: 0 });
        title = new Text(renderer, { content: "Providers", wrapMode: "none" }); header.add(title); frame.add(header);
        panel = new Scroll(renderer, { id: "fossa-picker-panel", flexGrow: 1, minHeight: 0, scrollX: false, paddingLeft: 1, paddingRight: 1, scrollbarOptions: { visible: false }, contentOptions: { flexShrink: 0 } });
        const group = new Box(renderer, { paddingLeft: 3, height: 1, flexShrink: 0 }); heading = new Text(renderer, { content: "Matching filters", wrapMode: "none" }); group.add(heading); panel.add(group);
        message = new Text(renderer, { paddingLeft: 3, content: "Loading providers…", flexShrink: 0 }); panel.add(message); frame.add(panel);
        footer = new Box(renderer, { paddingLeft: 4, paddingRight: 4, flexDirection: "row", gap: 1, height: 1, flexShrink: 0, onMouseUp: () => { void toggle(); } });
        footer.add(new Text(renderer, { content: "Toggle this panel", wrapMode: "none" })); shortcut = new Text(renderer, { wrapMode: "none" }); footer.add(shortcut); frame.add(footer); host.parent!.add(frame);
      }
      sample = chosen.sample;
      if (selected !== chosen.model) {
        unwatch?.(); selected = chosen.model; latest = undefined; failure = undefined; panel!.scrollTo(0);
        unwatch = source.watch(selected, (value, error) => { latest = value; failure = error; draw(); renderer.requestRender(); });
      }
      position(); draw();
    };
    createEffect(() => { if (appearance.modelPane === false && pendingEnabled === undefined) clear(); renderer.requestRender(); });
    renderer.setFrameCallback(scan);
    const dispose = () => { stopped = true; renderer.removeFrameCallback(scan); clear(); disposeRoot(); if (!suppliedSource) source.dispose(); };
    return Object.assign(dispose, { enabled, toggle, active });
  });
}
