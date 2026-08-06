import assert from 'node:assert/strict';
import test from 'node:test';

import { DurableWriteQueue } from '../src/durable-write-queue.ts';

test('a failed write leaves the same value dirty and retryable', async () => {
  const queue = new DurableWriteQueue<string>(value => value);
  queue.markPersisted('old');
  let attempts = 0;
  const writer = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('Keychain unavailable');
  };

  assert.equal(queue.enqueue('new', writer), true);
  await assert.rejects(queue.flush(), /Keychain unavailable/);
  assert.equal(queue.enqueue('new', writer), true, 'same value must schedule a retry');
  await queue.flush();
  assert.equal(attempts, 2);
  assert.equal(queue.enqueue('new', writer), false, 'persisted value should now be clean');
});

test('reverting while another value is queued schedules a restoring write', async () => {
  const queue = new DurableWriteQueue<string>(value => value);
  queue.markPersisted('old');
  const writes: string[] = [];
  assert.equal(queue.enqueue('new', async value => { writes.push(value); }), true);
  assert.equal(queue.enqueue('old', async value => { writes.push(value); }), true);
  await queue.flush();
  assert.deepEqual(writes, ['new', 'old']);
});
