import assert from 'node:assert/strict';
import test from 'node:test';

import { SecretLifecycle } from '../src/ssh-secret-lifecycle.ts';

type Secrets = { password?: string };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('credential lifecycle operation deadlocked')),
          1_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test('delete waits for legacy migration and removes the migrated credential and cache', async () => {
  const lifecycle = new SecretLifecycle<Secrets>();
  const keychain = new Map([['legacy', JSON.stringify({ password: 'old-secret' })]]);
  const migrationRead = deferred();
  const allowMigrationWrite = deferred();
  let deleteStarted = false;

  const load = lifecycle.load('server', async () => {
    const legacy = JSON.parse(keychain.get('legacy')!) as Secrets;
    migrationRead.resolve();
    await allowMigrationWrite.promise;
    keychain.set('v2', JSON.stringify(legacy));
    keychain.delete('legacy');
    return legacy;
  });
  await migrationRead.promise;

  const deletion = lifecycle.delete('server', async () => {
    deleteStarted = true;
    keychain.clear();
  });
  await Promise.resolve();
  assert.equal(deleteStarted, false, 'delete must wait for the in-flight migration');

  allowMigrationWrite.resolve();
  await withTimeout(Promise.all([load, deletion]));
  assert.equal(keychain.size, 0, 'delete must remove the newly migrated v2 entry');

  let postDeleteReads = 0;
  const postDelete = await lifecycle.load('server', async () => {
    postDeleteReads += 1;
    return {};
  });
  assert.deepEqual(postDelete, {});
  assert.equal(postDeleteReads, 1, 'delete must clear the pre-delete cache');
});

test('load started during delete waits and only caches the post-delete result', async () => {
  const lifecycle = new SecretLifecycle<Secrets>();
  await lifecycle.load('server', async () => ({ password: 'old-secret' }));

  const deleteStarted = deferred();
  const allowDelete = deferred();
  const deletion = lifecycle.delete('server', async () => {
    deleteStarted.resolve();
    await allowDelete.promise;
  });
  await deleteStarted.promise;

  let loaderStarted = false;
  const load = lifecycle.load('server', async () => {
    loaderStarted = true;
    return {};
  });
  await Promise.resolve();
  assert.equal(loaderStarted, false, 'load must not observe stale cache during deletion');

  allowDelete.resolve();
  const [, loaded] = await withTimeout(Promise.all([deletion, load]));
  assert.deepEqual(loaded, {});
  assert.deepEqual(
    await lifecycle.load('server', async () => ({ password: 'unexpected' })),
    {},
    'only the post-delete empty result may remain cached',
  );
});
