import type { BoxRenderable, Renderable, TextRenderable } from "@opentui/core";
import type { Context } from "@opencode/plugin/tui/context";
import { onCleanup } from "opentui:runtime-module:solid-js";
import { jsx } from "opentui:runtime-module:%40opentui%2Fsolid%2Fjsx-runtime";
import { providerRow } from "./provider-row";
import type { ModelDetails } from "./types";

type Mount = { anchor?: BoxRenderable; sample?: TextRenderable; normal: () => boolean; top?: BoxRenderable; bottom?: BoxRenderable; balance?: TextRenderable; inputs?: readonly unknown[] };
const remove = (node?: Renderable) => { if (node && !node.isDestroyed) { node.parent?.remove(node); node.destroyRecursively(); } };

export function installComposer(context: Context, details: () => ModelDetails | undefined, balance: () => string, openPrice: () => void, openSpeed: () => void) {
  const mounts = new Set<Mount>();
  const clear = (mount: Mount) => { remove(mount.top); remove(mount.bottom); mount.top = undefined; mount.bottom = undefined; mount.balance = undefined; mount.inputs = undefined; };
  const stopSlot = context.ui.slot({ append: "prompt.footer", render: input => {
    const mount: Mount = { normal: () => input.mode === "normal" }; mounts.add(mount);
    onCleanup(() => { clear(mount); mounts.delete(mount); });
    return jsx("box", { id: "fossa-composer-anchor", visible: false, ref: (node: BoxRenderable) => { mount.anchor = node; },
      get children() { return jsx("text", { ref: (node: TextRenderable) => { mount.sample = node; } }); },
    });
  } });
  const draw = async () => {
    const available = balance();
    for (const mount of mounts) {
      const { anchor, sample } = mount, footer = anchor?.parent, prompt = footer?.parent;
      if (!anchor || anchor.isDestroyed || !sample || sample.isDestroyed || !footer || !prompt) continue;
      if (context.ui.model.current()?.providerID !== "fossa" || !mount.normal()) { clear(mount); continue; }
      const Box = anchor.constructor as typeof BoxRenderable, Text = sample.constructor as typeof TextRenderable;
      const theme = context.theme, focus = theme.surface("dialog");
      const composer = prompt.getChildren().find(node => !node.id.startsWith("fossa-") && "borderColor" in node) as BoxRenderable | undefined;
      const border = theme.hue.accent[200], background = theme.background.raised.base;
      const value = details(), home = context.ui.router.current().type === "home";
      const inputs = [home, value, border, background, composer?.customBorderChars, context.renderer.width < 44, theme.text.base, theme.text.muted, focus.background.action.primary.focused, focus.text.action.primary.focused];
      if (!mount.bottom || mount.bottom.isDestroyed || inputs.some((value, index) => value !== mount.inputs?.[index])) {
        clear(mount); mount.inputs = inputs;
        if (home) {
          mount.top = new Box(context.renderer, { id: "fossa-composer-provider", marginBottom: 1, flexShrink: 0 });
          if (value?.offers[0]) mount.top.add(providerRow(context, sample, value.offers[0], true, "fossa-composer-offer"));
          else mount.top.add(new Text(context.renderer, { content: value ? "No providers match your filters." : "Loading providers…", fg: theme.text.muted }));
          prompt.add(mount.top, 0);
        }
        mount.bottom = new Box(context.renderer, { id: "fossa-composer-filters", border: ["left"], borderColor: border, customBorderChars: composer?.customBorderChars, marginBottom: 1, flexShrink: 0 });
        const controls = new Box(context.renderer, { backgroundColor: background, paddingLeft: context.renderer.width < 44 ? 0 : 1, paddingRight: 2, flexDirection: "row", gap: 2, flexWrap: "wrap", flexShrink: 0, width: "100%" });
        mount.bottom.add(controls);
        const control = (title: string, value: string, run: () => void) => {
          const box = new Box(context.renderer, { flexDirection: "row", paddingLeft: 1, paddingRight: 1, flexShrink: 0 });
          const label = new Text(context.renderer, { content: `${title}  `, fg: theme.text.base });
          const setting = new Text(context.renderer, { content: value, fg: theme.text.muted });
          box.add(label); box.add(setting); box.onMouseUp = run;
          box.onMouseOver = () => { box.backgroundColor = focus.background.action.primary.focused; label.fg = setting.fg = focus.text.action.primary.focused; };
          box.onMouseOut = () => { box.backgroundColor = background; label.fg = theme.text.base; setting.fg = theme.text.muted; };
          controls.add(box);
        };
        const auto = !value || [value.settings.maxInputPrice, value.settings.maxCachedPrice, value.settings.maxOutputPrice].every(item => item === undefined);
        control("Price", auto ? "Auto" : "Custom", openPrice);
        control("Speed", value?.settings.minSpeed ? `${value.settings.minSpeed} T/S` : "Auto", openSpeed);
        controls.add(new Box(context.renderer, { flexGrow: 1 }));
        mount.balance = new Text(context.renderer, { id: "fossa-composer-balance", content: available, fg: theme.text.base, flexShrink: 0, wrapMode: "none" });
        controls.add(mount.balance); prompt.add(mount.bottom, prompt.getChildren().indexOf(footer));
      }
      if (mount.balance && mount.balance.plainText !== available) mount.balance.content = available;
    }
  };
  context.renderer.setFrameCallback(draw);
  return () => { context.renderer.removeFrameCallback(draw); stopSlot(); mounts.forEach(clear); mounts.clear(); };
}
