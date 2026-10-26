import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MockVaultApp, syncVault } from './mock-vault';
import { VaultTransaction, vaultContentHash as h } from '../src/vault-transaction';
import { DEFAULT_SETTINGS } from '../src/types';

test('durable journal refuses ambiguous partial existing writes after restart', async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kindle-transaction-'));
 try {
  const app = new MockVaultApp(path.join(root, 'vault'));
  const settings = { ...DEFAULT_SETTINGS, cachePath: path.join(root, 'cache') };
  await app.vault.create('Books/old.md', 'original');
  const tx = new VaultTransaction(app as any, settings);
  tx.operations.push({ kind: 'write', path: 'Books/old.md', content: 'complete content', beforeHash: h('original') }, { kind: 'write', path: 'Books/second.md', content: 'second', create: true });
  const modify = app.vault.modify;
  app.vault.modify = async (file, content) => { await modify(file, content.slice(0, 3)); throw new Error('interrupted'); };
  await assert.rejects(tx.commit(), /interrupted/);
  assert.equal(app.fileContents.get('Books/old.md'), 'com');
  app.vault.modify = modify;
  await assert.rejects(new VaultTransaction(app as any, settings).recover(), /conflict/i);
  assert.equal(app.fileContents.get('Books/old.md'), 'com');
  assert.equal(app.vault.getFileByPath('Books/second.md'), null);
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('new book can occupy a path vacated by a planned mover', async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kindle-vacated-'));
 try {
  const app = new MockVaultApp(path.join(root, 'vault'));
  const settings = { ...DEFAULT_SETTINGS, targetFolder: 'Books', cachePath: path.join(root, 'cache'), copyCovers: false };
  await app.vault.create('Books/Auth--Alpha.md', '---\nmeta_generator: kindle_sync\nkindle_uuid: existing\n---\n');
  const stats = await syncVault(app as any, { books: [{ uuid: 'existing', title: 'Beta', author: 'Auth', read_status: 'read' }, { uuid: 'new', title: 'Alpha', author: 'Auth', read_status: 'read' }] }, settings);
  assert.equal(stats.created, 1);
  assert.match(app.fileContents.get('Books/Auth--Alpha.md')!, /kindle_uuid: "new"/);
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('sync recovery completes orphan flags and new notes', async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kindle-batch-'));
 try {
  const app = new MockVaultApp(path.join(root, 'vault'));
  const settings = { ...DEFAULT_SETTINGS, targetFolder: 'Books', cachePath: path.join(root, 'cache'), copyCovers: false, baseEmbed: '' };
  await app.vault.create('Books/orphan.md', '---\nmeta_generator: kindle_sync\nkindle_uuid: orphan\nkindle_read_status: reading\n---\n\nPersonal retained body\n');
  const library = { books: [{ uuid: 'new', title: 'New' }] };
  const create = app.vault.create;
  app.vault.create = async (p, content) => { if (p === 'Books/inactive/Unknown--New.md') throw new Error('disk full'); return create(p, content); };
  await assert.rejects(syncVault(app as any, library, settings), /disk full/);
  app.vault.create = create;
  await assert.rejects(syncVault(app as any, library, settings), /Recovered interrupted/);
  assert.match(app.fileContents.get('Books/orphan.md')!, /kindle_on_device: false/);
  assert.match(app.fileContents.get('Books/orphan.md')!, /kindle_read_status: "abandoned"/);
  assert.match(app.fileContents.get('Books/orphan.md')!, /Personal retained body/);
  assert.match(app.fileContents.get('Books/inactive/Unknown--New.md')!, /kindle_uuid: "new"/);
  const stats = await syncVault(app as any, library, settings);
  assert.equal(stats.unchanged, 1);
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const kind of ['move', 'create', 'binary'] as const) {
 test(`replays ${kind} completed before checkpoint`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kindle-checkpoint-'));
  try {
   const app = new MockVaultApp(path.join(root, 'vault'));
   const settings = { ...DEFAULT_SETTINGS, cachePath: path.join(root, 'cache') };
   const originalContent = '---\nmeta_generator: kindle_sync\nkindle_uuid: one\n---\noriginal';
   await app.vault.create('Books/old.md', originalContent);
   const tx = new VaultTransaction(app as any, settings);
   const owner = kind === 'move' ? app.fileManager : app.vault;
   const method = kind === 'move' ? 'renameFile' : kind === 'create' ? 'create' : 'createBinary';
   const original = (owner as any)[method].bind(owner);
   (owner as any)[method] = async (...args: any[]) => { await original(...args); throw new Error('lost checkpoint'); };
   tx.operations.push(kind === 'move' ? { kind: 'move', from: 'Books/old.md', path: 'Books/new.md', uuid: 'one' } : { kind: 'write', path: 'Books/new.md', content: kind === 'binary' ? Buffer.from('complete').toString('base64') : 'complete', binary: kind === 'binary', create: true });
   await assert.rejects(tx.commit(), /lost checkpoint/);
   (owner as any)[method] = original;
   assert.equal(await new VaultTransaction(app as any, settings).recover(), true);
   assert.equal(fs.readFileSync(path.join(root, 'vault/Books/new.md'), 'utf8'), kind === 'move' ? originalContent : 'complete');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
 });
}

for (const cancel of [false, true]) test(`archive survives ${cancel ? 'cancellation' : 'publication failure'} and cache setting change`, async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kindle-archive-'));
 const oldXdg = process.env.XDG_DATA_HOME;
 process.env.XDG_DATA_HOME = root;
 try {
  const app = new MockVaultApp(path.join(root, 'vault'));
  const settings = { ...DEFAULT_SETTINGS, cachePath: path.join(root, 'cache'), copyCovers: false };
  const controller = new AbortController();
  const archive = path.join(settings.cachePath, 'archive.json');
  const create = app.vault.create;
  app.vault.create = async (p, content) => { const result = await create(p, content); fs.mkdirSync(archive, { recursive: true }); if (cancel) controller.abort(); return result; };
  const payload = JSON.stringify({ books: [{ uuid: 'source' }], groups: [{ id: 'stable' }] });
  await assert.rejects(syncVault(app as any, { books: [{ uuid: 'one', title: 'One' }] }, settings, controller.signal, payload));
  const tx = new VaultTransaction(app as any, { ...settings, cachePath: path.join(root, 'other') });
  assert.equal(await tx.pendingCacheRoot(), settings.cachePath);
  fs.rmdirSync(archive);
  assert.equal(await tx.recover(), true);
  assert.equal(fs.readFileSync(archive, 'utf8'), payload);
  assert.equal(await tx.recover(), false);
  await syncVault(app as any, { books: [] }, settings, undefined, 'empty archive');
  assert.equal(fs.readFileSync(archive, 'utf8'), 'empty archive');
  // No note operations remain, but publication must still run.
  await syncVault(app as any, { books: [] }, settings, undefined, 'archive only');
  assert.equal(fs.readFileSync(archive, 'utf8'), 'archive only');
 } finally { if (oldXdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = oldXdg; fs.rmSync(root, { recursive: true, force: true }); }
});

for (const before of [null, 'original archive']) test(`shared-cache recovery preserves newer archive (before=${before})`, async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kindle-shared-archive-'));
 try {
  const first = new MockVaultApp(path.join(root, 'first'));
  const second = new MockVaultApp(path.join(root, 'second'));
  const settings = { ...DEFAULT_SETTINGS, cachePath: path.join(root, 'cache') };
  const archive = path.join(settings.cachePath, 'archive.json');
  fs.mkdirSync(settings.cachePath, { recursive: true });
  if (before !== null) fs.writeFileSync(archive, before);
  const tx = new VaultTransaction(first as any, settings);
  tx.operations.push({ kind: 'write', path: 'note.md', content: 'note', create: true });
  const create = first.vault.create;
  first.vault.create = async () => { throw new Error('notes failed'); };
  await assert.rejects(tx.commit('older payload'), /notes failed/);
  const journal = path.join(tx.directory, 'transaction.json');
  const pending = fs.readFileSync(journal);
  await new VaultTransaction(second as any, settings).commit('newer payload');
  first.vault.create = create;
  await assert.rejects(new VaultTransaction(first as any, settings).recover(), /Recovery conflict.*archive/);
  assert.equal(fs.readFileSync(archive, 'utf8'), 'newer payload');
  assert.deepEqual(fs.readFileSync(journal), pending);
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('archive read failure closes preflight before journal or notes', async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kindle-archive-preflight-'));
 try {
  const app = new MockVaultApp(path.join(root, 'vault'));
  const settings = { ...DEFAULT_SETTINGS, cachePath: path.join(root, 'cache') };
  fs.mkdirSync(path.join(settings.cachePath, 'archive.json'), { recursive: true });
  const tx = new VaultTransaction(app as any, settings);
  tx.operations.push({ kind: 'write', path: 'note.md', content: 'note', create: true });
  await assert.rejects(tx.commit('payload'), /EISDIR/);
  assert.equal(fs.existsSync(path.join(tx.directory, 'transaction.json')), false);
  assert.equal(app.vault.getFileByPath('note.md'), null);
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const applied of [false, true]) test(`archive replay accepts ${applied ? 'already applied payload' : 'unchanged before hash'}`, async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kindle-archive-replay-'));
 try {
  const app = new MockVaultApp(path.join(root, 'vault'));
  const settings = { ...DEFAULT_SETTINGS, cachePath: path.join(root, 'cache') };
  const archive = path.join(settings.cachePath, 'archive.json');
  fs.mkdirSync(settings.cachePath, { recursive: true });
  fs.writeFileSync(archive, 'original');
  const tx = new VaultTransaction(app as any, settings);
  tx.operations.push({ kind: 'write', path: 'note.md', content: 'note', create: true });
  const create = app.vault.create;
  app.vault.create = async () => { throw new Error('notes failed'); };
  await assert.rejects(tx.commit('payload'), /notes failed/);
  const journal = path.join(tx.directory, 'transaction.json');
  assert.match(JSON.parse(fs.readFileSync(journal, 'utf8')).archiveBeforeHash, /^[a-f0-9]{64}$/);
  app.vault.create = create;
  if (applied) fs.writeFileSync(archive, 'payload');
  assert.equal(await tx.recover(), true);
  assert.equal(fs.readFileSync(archive, 'utf8'), 'payload');
  assert.equal(fs.existsSync(journal), false);
  assert.equal(fs.existsSync(`${journal}.progress`), false);
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the global lock excludes another process using a different vault and cache', async () => {
 const { CacheLock, defaultCachePath } = await import('../src/device/cache');
 const { spawnSync } = await import('node:child_process');
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kindle-global-lock-'));
 const oldXdg = process.env.XDG_DATA_HOME; process.env.XDG_DATA_HOME = root;
 try {
  const lock = CacheLock.acquire(defaultCachePath());
  try {
   const code = `import { CacheLock, defaultCachePath } from './src/device/cache.ts';
    try { CacheLock.acquire(defaultCachePath()); process.exit(2); } catch (e) { if (!/locked by another sync/.test(e.message)) throw e; }`;
   const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { encoding: 'utf8' });
   assert.equal(result.status, 0, result.stderr);
  } finally { lock.release(); }
 } finally { if (oldXdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = oldXdg; fs.rmSync(root, { recursive: true, force: true }); }
});
