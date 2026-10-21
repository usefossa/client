import type { Context, DialogSelectOption } from "@opencode/plugin/tui/context";
import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import { batch, createMemo, createSignal, For, Show } from "solid-js";

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
      context.ui.dialog.show(() => <box height={height()} paddingBottom={2}>
        <box paddingLeft={4} paddingRight={4} flexDirection="row" justifyContent="space-between"><text fg={theme().text.base} attributes={1}>{page().title}</text><text fg={theme().text.muted} onMouseUp={() => finish()}>esc</text></box>
        <Show when={page().kind === "select" && page().search}>
          <box paddingLeft={4} paddingRight={4} paddingTop={1} paddingBottom={1} flexShrink={0}><input value={query()} onInput={text => { setQuery(text); setSelected(0); scroll?.scrollTo(0); }} placeholder="Search" placeholderColor={theme().text.muted} textColor={theme().text.base} focusedTextColor={theme().text.formfield.focused} focusedBackgroundColor={theme().background.formfield.focused} cursorColor={theme().text.formfield.focused} ref={node => { search = node; node.traits = { status: "FILTER" }; focus(); }} /></box>
        </Show>
        <scrollbox ref={node => { scroll = node; }} flexGrow={1} scrollX={false} paddingLeft={1} paddingRight={1} marginTop={page().kind === "select" && page().search ? 0 : 1}>
          <Show when={page().message || page().description}><box paddingLeft={3} paddingRight={3} paddingBottom={1} gap={1}>
            <Show when={page().message}><text fg={theme().text.base}>{page().message}</text></Show>
            <Show when={page().description}><text fg={theme().text.muted}>{page().description}</text></Show>
          </box></Show>
          <Show when={page().kind === "select"}>
            <For each={options()}>{(item, index) => <>
              <Show when={item.category && item.category !== options()[index() - 1]?.category}><box paddingLeft={3} paddingTop={index() ? 1 : 0}><text fg={theme().hue.accent[200]} attributes={1}>{item.category}</text></box></Show>
              <box id={`fossa-option-${index()}`} paddingLeft={page().current === item.value ? 1 : 3} paddingRight={3} flexShrink={0} backgroundColor={selected() === index() ? theme().background.action.primary.focused : "transparent"} onMouseMove={() => setSelected(index())} onMouseOver={() => setSelected(index())} onMouseDown={() => setSelected(index())} onMouseUp={() => { if (!item.disabled) finish(item.value); }}>
                <box flexDirection="row" gap={1} flexShrink={0}>
                  <Show when={page().current === item.value}><text flexShrink={0} fg={selected() === index() ? theme().text.action.primary.focused : theme().text.formfield.selected}>●</text></Show>
                  <text flexShrink={1} minWidth={0} wrapMode="char" attributes={selected() === index() ? 1 : 0} fg={item.disabled ? theme().text.muted : selected() === index() ? theme().text.action.primary.focused : theme().text.base}>{item.title}</text>
                  <box flexGrow={1} />
                  <Show when={item.loading} fallback={<Show when={item.footer}><text flexShrink={0} fg={selected() === index() ? theme().text.action.primary.focused : theme().text.muted}>{item.footer}</text></Show>}><box width={8} height={1} flexShrink={0} backgroundColor={theme().background.raised.base} /></Show>
                </box>
                <Show when={item.description}><text paddingLeft={page().current === item.value ? 2 : 0} flexShrink={0} wrapMode="word" fg={selected() === index() ? theme().text.action.primary.focused : theme().text.muted}>{item.description}</text></Show>
              </box>
            </>}</For>
            <Show when={!options().length}><box paddingLeft={3}><text fg={theme().text.muted}>No results</text></box></Show>
          </Show>
          <Show when={page().kind === "prompt"}><box paddingLeft={3} paddingRight={3}><input value={value()} onInput={setValue} placeholder={page().placeholder} textColor={theme().text.base} focusedTextColor={theme().text.base} cursorColor={theme().text.base} ref={node => { input = node; focus(); }} /></box></Show>
        </scrollbox>
        <Show when={page().kind !== "select"}><box paddingLeft={4} marginTop={1}><text fg={theme().text.base} attributes={1} onMouseUp={submit}>{page().kind === "alert" ? "OK" : "Save"}</text></box></Show>
      </box>, () => { mounted = false; setActive(false); const done = resolve; resolve = undefined; done?.(); });
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
