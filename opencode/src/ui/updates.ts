import type { Context } from "@opencode/plugin/tui/context";

export function installUpdateNotice(context: Context) {
  const controller = new AbortController();
  const [notice, setNotice] = context.storage.memory<{ shown: string[] }>("updates", { initial: { shown: [] } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const show = (key: string) => {
    if (notice.shown.includes(key)) return;
    context.ui.toast.show({ title: "Fossa update available", message: "A newer Fossa plugin is available. Close OpenCode, run opencode plugin update in your terminal, then reopen OpenCode.", variant: "warning", duration: 20_000 });
    setNotice(value => { value.shown.push(key); });
  };
  const check = async () => {
    let delay = 60 * 60_000;
    try {
      if (context.options.simulateUpdate === true) { show("simulation"); return; }
      const options = { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) };
      const plugins = await context.client.plugin.list({ location: context.location }, options);
      const source = plugins.data.find(plugin => (plugin.id === "fossa" || plugin.id === "fossa.ui") && plugin.source.type === "package")?.source;
      if (controller.signal.aborted || source?.type !== "package") return;
      const checked = await context.client.plugin.check({ location: context.location, target: source.target }, options);
      if (controller.signal.aborted) return;
      const outdated = checked.data.some(plugin => plugin.source.type === "package" && plugin.source.target === source.target && plugin.source.outdated && !plugin.source.updating);
      if (outdated) show(JSON.stringify([source.target, source.version]));
    } catch { delay = 5 * 60_000; }
    finally { if (!controller.signal.aborted) timer = setTimeout(() => void check(), delay); }
  };
  const start = async () => { context.renderer.removeFrameCallback(start); void check(); };
  context.renderer.setFrameCallback(start);
  return () => { controller.abort(); clearTimeout(timer); context.renderer.removeFrameCallback(start); };
}
