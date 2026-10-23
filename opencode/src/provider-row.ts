import { spawn } from "node:child_process";
import type { BoxRenderable, TextRenderable } from "@opentui/core";
import type { Context } from "@opencode/plugin/tui/context";
import type { ModelDetails } from "./types";

export const price = (value: number) => `$${Number(value.toFixed(6))}`;
export function openProvider(context: Context, url: string, title = "Provider profile") {
  if (!/^https?:\/\//.test(url)) return;
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const child = spawn(command, process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url], { detached: true, stdio: "ignore" });
  child.on("error", () => context.ui.toast.show({ title, message: `Open ${url}`, variant: "error" })); child.unref();
}
export function providerRow(context: Context, sample: TextRenderable, offer: ModelDetails["offers"][number], best: boolean, id: string) {
  const Box = sample.parent!.constructor as typeof BoxRenderable, Text = sample.constructor as typeof TextRenderable;
  const theme = context.theme, accent = theme.surface("dialog");
  const row = new Box(context.renderer, { id, flexDirection: "row", flexWrap: "wrap", flexShrink: 0, gap: 2 });
  const amounts = new Box(context.renderer, { id: `${id}-amounts`, flexDirection: "row", flexWrap: "wrap", flexGrow: 1 });
  const add = (content: string, bright = false) => {
    const node = new Text(context.renderer, { content, fg: bright ? theme.text.base : theme.text.muted, flexShrink: 0 }); amounts.add(node); return node;
  };
  const name = add(offer.provider, true);
  if (offer.url) {
    name.onMouseOver = () => { name.fg = accent.text.action.primary.focused; name.bg = accent.background.action.primary.focused; };
    name.onMouseOut = () => { name.fg = theme.text.base; name.bg = "transparent"; };
    name.onMouseUp = () => openProvider(context, offer.url);
  }
  if (best) {
    add(" ");
    amounts.add(new Text(context.renderer, { content: " Best ", fg: accent.text.action.primary.focused, bg: accent.background.action.primary.focused, attributes: 1, flexShrink: 0 }));
  }
  add("  "); add("IN ", true); add(price(offer.input)); add(" · ");
  add("OUT ", true); add(price(offer.output)); add(" · ");
  add("CACHE ", true); add(price(offer.cached)); row.add(amounts);
  const speed = new Box(context.renderer, { flexDirection: "row", flexShrink: 0 });
  speed.add(new Text(context.renderer, { content: `${offer.speed} `, fg: theme.text.muted }));
  speed.add(new Text(context.renderer, { content: "T/S", fg: theme.text.base })); row.add(speed);
  return row;
}
