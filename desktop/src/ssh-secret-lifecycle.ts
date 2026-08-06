/**
 * Per-name serialization for cached credential loads, stores, and deletes.
 * Registering each operation on one queue before it waits closes the window in
 * which a migration could recreate a just-deleted credential. Writers receive
 * their current value directly and never call back into this lifecycle, so the
 * queue cannot form a load/store/delete promise cycle.
 */
export class SecretLifecycle<T> {
  private readonly cache = new Map<string, T>();
  private readonly tails = new Map<string, Promise<void>>();

  async load(name: string, loader: () => Promise<T>, force = false): Promise<T> {
    return this.run(name, async () => {
      if (!force && this.cache.has(name)) return this.cache.get(name)!;
      const value = await loader();
      this.cache.set(name, value);
      return value;
    });
  }

  async store(
    name: string,
    loader: (() => Promise<T>) | undefined,
    writer: (current: T | undefined) => Promise<T>,
  ): Promise<T> {
    return this.run(name, async () => {
      let current = this.cache.get(name);
      if (!this.cache.has(name) && loader) {
        current = await loader();
        this.cache.set(name, current);
      }
      try {
        const value = await writer(current);
        this.cache.set(name, value);
        return value;
      } catch (error) {
        // A failed writer may have changed durable state before reporting a
        // cleanup error. Force the next caller to re-read instead of serving a
        // cache entry whose generation is now uncertain.
        this.cache.delete(name);
        throw error;
      }
    });
  }

  async delete(name: string, deleter: () => Promise<void>): Promise<void> {
    await this.run(name, async () => {
      this.cache.delete(name);
      await deleter();
    });
  }

  private async run<R>(name: string, operation: () => Promise<R>): Promise<R> {
    const previous = this.tails.get(name);
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const tail = (previous ?? Promise.resolve()).catch(() => {}).then(() => turn);
    this.tails.set(name, tail);

    if (previous) await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(name) === tail) this.tails.delete(name);
    }
  }
}
