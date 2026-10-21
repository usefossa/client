import type { Context, DialogSelectOption } from "@opencode/plugin/tui/context";
import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import { batch, createComponent, createMemo, createSignal, For, Show } from "opentui:runtime-module:solid-js";
import { jsx, type JSX } from "opentui:runtime-module:%40opentui%2Fsolid%2Fjsx-runtime";

const Conditional: (props: { when: unknown; fallback?: JSX.Element; children: JSX.Element }) => JSX.Element = Show;

type Page = { kind: "select" | "alert" | "prompt"; title: string; message?: string; description?: string; placeholder?: string; search?: boolean; current?: string; options?: readonly (DialogSelectOption<string> & { loading?: boolean })[] };

export function settingsDialog(context: Context) {
  const [page, setPage] = createSignal<Page>({ kind: "select", title: "Fossa Settings" }), [selected, setSelected] = createSignal(0), [value, setValue] = createSignal(""), [query, setQuery] = createSignal(""), [busy, setBusy] = createSignal(false), [active, setActive] = createSignal(false);
  const theme = () => context.theme.surface("dialog");
  const options = createMemo(() => {
    const words = query().trim().toLowerCase().split(/\s+/);
    return (page().options ?? []).filter(item => words.every(word => `${item.title} ${item.description ?? ""} ${item.category ?? ""} ${item.footer ?? ""}`.toLowerCase().includes(word)));
  });
  let mounted = false, resolve: ((value?: string) => void) | undefined, search: InputRenderable | undefined, input: InputRenderable | undefined, scroll: ScrollBoxRenderable | undefined;
  const finish = (answer?: string) => { if (busy()) return; setBusy(true); const done = resolve; resolve = undefined; done?.(answer); };
  const submit = () => { const item = options()[selected()]; if (page().kind === "prompt") finish(value()); else if (page().kind === "alert") finish(); else if (item && !item.disabled) finish(item.value); };
  const focus = () => queueMicrotask(() => { const node = page().kind === "select" ? page().search ? search : undefined : input; if (node && !node.isDestroyed) node.focus(); });
  const height = () => {
    if (page().kind !== "select") return Math.min(20, context.renderer.height - 4);
    const width = Math.max(1, Math.min(72, context.renderer.width - 12)), lines = (text: string) => text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / width)), 0);
    const categories = (page().options ?? []).filter((item, index, all) => item.category && item.category !== all[index - 1]?.category).length;
    const message = page().message ? lines(page().message!) + 1 : 0, rows = (page().options ?? []).reduce((sum, item) => sum + lines(item.title) + (item.description ? lines(item.description) : 0), 0);
    return Math.min(20, context.renderer.height - 4, rows + categories + Math.max(0, categories - 1) + (page().search ? 6 : 4) + message);
  };
  const move = (delta: number) => {
    const count = options().length; if (!count) return;
    setSelected(index => (index + delta + count) % count);
    const row = scroll?.getChildren().find(node => node.id === `fossa-option-${selected()}`);
    if (row && scroll) { const y = row.y - scroll.y; if (y < 0) scroll.scrollBy(y); else if (y + row.height > scroll.height) scroll.scrollBy(Math.min(y, y + row.height - scroll.height)); }
  };
  const present = (next: Page, initial = "", current?: string): Promise<string | undefined> => {
    if (!active()) return Promise.resolve(undefined);
    batch(() => { setValue(initial); setQuery(""); setSelected(Math.max(0, next.options?.findIndex(item => current === undefined ? !item.disabled : item.value === current) ?? 0)); setPage(next); setBusy(false); });
    scroll?.scrollTo(0);
    const result = new Promise<string | undefined>(done => { resolve = done; });
    if (!mounted) {
      mounted = true;
      context.ui.dialog.show(() => jsx("box", { get height() { return height(); }, paddingBottom: 2, get children() { return [
        jsx("box", { paddingLeft: 4, paddingRight: 4, flexDirection: "row", justifyContent: "space-between", get children() { return [
          jsx("text", { get fg() { return theme().text.base; }, attributes: 1, get children() { return page().title; } }),
          jsx("text", { get fg() { return theme().text.muted; }, onMouseUp: () => finish(), children: "esc" }),
        ]; } }),
        createComponent(Conditional, { get when() { return page().kind === "select" && page().search; }, get children() {
          return jsx("box", { paddingLeft: 4, paddingRight: 4, paddingTop: 1, paddingBottom: 1, flexShrink: 0, get children() {
            return jsx("input", { get value() { return query(); }, onInput: (text: string) => { setQuery(text); setSelected(0); scroll?.scrollTo(0); }, placeholder: "Search",
              get placeholderColor() { return theme().text.muted; }, get textColor() { return theme().text.base; },
              get focusedTextColor() { return theme().text.formfield.focused; }, get focusedBackgroundColor() { return theme().background.formfield.focused; },
              get cursorColor() { return theme().text.formfield.focused; }, ref: (node: InputRenderable) => { search = node; node.traits = { status: "FILTER" }; focus(); },
            });
          } });
        } }),
        jsx("scrollbox", { ref: (node: ScrollBoxRenderable) => { scroll = node; }, flexGrow: 1, scrollX: false, paddingLeft: 1, paddingRight: 1,
          get marginTop() { return page().kind === "select" && page().search ? 0 : 1; }, get children() { return [
            createComponent(Conditional, { get when() { return page().message || page().description; }, get children() {
              return jsx("box", { paddingLeft: 3, paddingRight: 3, paddingBottom: 1, gap: 1, get children() { return [
                createComponent(Conditional, { get when() { return page().message; }, get children() { return jsx("text", { get fg() { return theme().text.base; }, get children() { return page().message; } }); } }),
                createComponent(Conditional, { get when() { return page().description; }, get children() { return jsx("text", { get fg() { return theme().text.muted; }, get children() { return page().description; } }); } }),
              ]; } });
            } }),
            createComponent(Conditional, { get when() { return page().kind === "select"; }, get children() { return [
              createComponent(For<NonNullable<Page["options"]>, JSX.Element>, { get each() { return options(); }, children: (item, index) => [
                createComponent(Conditional, { get when() { return item.category && item.category !== options()[index() - 1]?.category; }, get children() {
                  return jsx("box", { paddingLeft: 3, get paddingTop() { return index() ? 1 : 0; }, get children() {
                    return jsx("text", { get fg() { return theme().hue.accent[200]; }, attributes: 1, children: item.category });
                  } });
                } }),
                jsx("box", { get id() { return `fossa-option-${index()}`; }, get paddingLeft() { return page().current === item.value ? 1 : 3; }, paddingRight: 3, flexShrink: 0,
                  get backgroundColor() { return selected() === index() ? theme().background.action.primary.focused : "transparent"; },
                  onMouseMove: () => setSelected(index()), onMouseOver: () => setSelected(index()), onMouseDown: () => setSelected(index()), onMouseUp: () => { if (!item.disabled) finish(item.value); },
                  get children() { return [
                    jsx("box", { flexDirection: "row", gap: 1, flexShrink: 0, get children() { return [
                      createComponent(Conditional, { get when() { return page().current === item.value; }, get children() {
                        return jsx("text", { flexShrink: 0, get fg() { return selected() === index() ? theme().text.action.primary.focused : theme().text.formfield.selected; }, children: "●" });
                      } }),
                      jsx("text", { flexShrink: 1, minWidth: 0, wrapMode: "char", get attributes() { return selected() === index() ? 1 : 0; },
                        get fg() { return item.disabled ? theme().text.muted : selected() === index() ? theme().text.action.primary.focused : theme().text.base; }, children: item.title,
                      }),
                      jsx("box", { flexGrow: 1 }),
                      createComponent(Conditional, { when: item.loading, get fallback() {
                        return createComponent(Conditional, { when: item.footer, get children() {
                          return jsx("text", { flexShrink: 0, get fg() { return selected() === index() ? theme().text.action.primary.focused : theme().text.muted; }, children: item.footer });
                        } });
                      }, get children() { return jsx("box", { width: 8, height: 1, flexShrink: 0, get backgroundColor() { return theme().background.raised.base; } }); } }),
                    ]; } }),
                    createComponent(Conditional, { when: item.description, get children() {
                      return jsx("text", { get paddingLeft() { return page().current === item.value ? 2 : 0; }, flexShrink: 0, wrapMode: "word",
                        get fg() { return selected() === index() ? theme().text.action.primary.focused : theme().text.muted; }, children: item.description,
                      });
                    } }),
                  ]; },
                }),
              ] }),
              createComponent(Conditional, { get when() { return !options().length; }, get children() {
                return jsx("box", { paddingLeft: 3, get children() { return jsx("text", { get fg() { return theme().text.muted; }, children: "No results" }); } });
              } }),
            ]; } }),
            createComponent(Conditional, { get when() { return page().kind === "prompt"; }, get children() {
              return jsx("box", { paddingLeft: 3, paddingRight: 3, get children() {
                return jsx("input", { get value() { return value(); }, onInput: setValue, get placeholder() { return page().placeholder; },
                  get textColor() { return theme().text.base; }, get focusedTextColor() { return theme().text.base; }, get cursorColor() { return theme().text.base; }, ref: (node: InputRenderable) => { input = node; focus(); },
                });
              } });
            } }),
          ]; },
        }),
        createComponent(Conditional, { get when() { return page().kind !== "select"; }, get children() {
          return jsx("box", { paddingLeft: 4, marginTop: 1, get children() {
            return jsx("text", { get fg() { return theme().text.base; }, attributes: 1, onMouseUp: submit, get children() { return page().kind === "alert" ? "OK" : "Save"; } });
          } });
        } }),
      ]; } }), () => { mounted = false; setActive(false); const done = resolve; resolve = undefined; done?.(); });
    }
    focus(); return result;
  };
  context.keymap.layer(() => ({ mode: "modal", priority: 200, enabled: active, commands: [
    { id: "fossa.dialog.back", bind: "escape", run: () => finish() },
    { id: "fossa.dialog.submit", bind: "return", run: submit },
    { id: "fossa.dialog.up", bind: "up", enabled: () => page().kind === "select", run: () => move(-1) },
    { id: "fossa.dialog.down", bind: "down", enabled: () => page().kind === "select", run: () => move(1) },
  ] }));
  return {
    active,
    update: (title: string, patch: Partial<Page>) => {
      if (!active() || page().title !== title) return;
      const current = options()[selected()]?.value;
      batch(() => { setPage(value => ({ ...value, ...patch })); const index = options().findIndex(item => item.value === current && !item.disabled); setSelected(Math.max(0, index < 0 ? options().findIndex(item => !item.disabled) : index)); });
    },
    begin: () => setActive(true),
    close: () => { if (mounted) context.ui.dialog.clear(); else setActive(false); },
    select: (options: Omit<Page, "kind"> & { current?: string }) => present({ ...options, kind: "select" }, "", options.current),
    alert: async (options: { title: string; message: string }) => { await present({ ...options, kind: "alert" }); },
    prompt: (options: { title: string; description?: string; placeholder?: string; value?: string }) => present({ ...options, kind: "prompt" }, options.value),
  };
}
