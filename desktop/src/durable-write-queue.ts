/**
 * Serialized durable writes that remember only successfully persisted values.
 * A rejected write clears its scheduled marker, so submitting the same value
 * again is a real retry rather than an in-memory equality no-op.
 */
export class DurableWriteQueue<T> {
  private persisted: string | null = null;
  private scheduled: string | null = null;
  private tail: Promise<void> = Promise.resolve();
  private readonly serialize: (value: T) => string;

  constructor(serialize: (value: T) => string) {
    this.serialize = serialize;
  }

  markPersisted(value: T): void {
    this.persisted = this.serialize(value);
  }

  enqueue(value: T, writer: (snapshot: T) => Promise<void>): boolean {
    const serialized = this.serialize(value);
    if (serialized === this.scheduled) return false;
    if (this.scheduled === null && serialized === this.persisted) {
      this.tail = this.tail.catch(() => {});
      return false;
    }

    this.scheduled = serialized;
    const operation = this.tail
      .catch(() => {})
      .then(() => writer(value))
      .then(() => { this.persisted = serialized; });
    this.tail = operation.finally(() => {
      if (this.scheduled === serialized) this.scheduled = null;
    });
    return true;
  }

  flush(): Promise<void> {
    return this.tail;
  }
}
