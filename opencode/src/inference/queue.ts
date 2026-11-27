// one waiter wakes per handoff. cancellation removes its place immediately.
export class BookingQueue {
  private busy = false;
  private waiting = new Set<() => void>();
  get idle() { return !this.busy; }

  async run<T>(signal: AbortSignal | undefined, action: () => Promise<T>) {
    signal?.throwIfAborted();
    if (this.busy) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => { signal?.removeEventListener("abort", abort); resolve(); };
        const abort = () => { this.waiting.delete(wake); reject(signal?.reason); };
        this.waiting.add(wake);
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
    this.busy = true;
    try { signal?.throwIfAborted(); return await action(); }
    finally {
      const next = this.waiting.values().next().value;
      if (next) { this.waiting.delete(next); next(); }
      else this.busy = false;
    }
  }
}
