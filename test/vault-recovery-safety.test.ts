import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MockVaultApp } from './mock-vault';
import { VaultTransaction, vaultContentHash as h } from '../src/vault-transaction';
import { DEFAULT_SETTINGS } from '../src/types';
import { validateVaultSettings } from '../src/vault-writer';

async function fixture(run: (app: MockVaultApp, settings: typeof DEFAULT_SETTINGS) => Promise<void>) {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kindle-recovery-safety-'));
 try { await run(new MockVaultApp(path.join(root, 'vault')), { ...DEFAULT_SETTINGS, cachePath: path.join(root, 'cache') }); }
 finally { fs.rmSync(root, { recursive: true, force: true }); }
}

for (const binary of [false, true]) {
 test(`recovery never overwrites a refused ${binary ? 'cover' : 'note'} collision`, () => fixture(async (app, settings) => {
  const tx = new VaultTransaction(app as any, settings);
  tx.operations.push({ kind: 'write', path: 'Books/new.md', content: binary ? Buffer.from('generated').toString('base64') : 'generated', create: true, binary });
  await app.vault.create('Books/new.md', 'personal content');
  await assert.rejects(tx.commit(), /Destination appeared/);
  await assert.rejects(new VaultTransaction(app as any, settings).recover(), /conflict/i);
  assert.equal(fs.readFileSync(path.join(app.vaultPath, 'Books/new.md'), 'utf8'), 'personal content');
 }));
}

test('ambiguous partial creation stops for review instead of overwriting', () => fixture(async (app, settings) => {
 const tx = new VaultTransaction(app as any, settings);
 tx.operations.push({ kind: 'write', path: 'Books/new.md', content: 'complete', create: true });
 const create = app.vault.create;
 app.vault.create = async (p, content) => { await create(p, content.slice(0, 3)); throw new Error('interrupted'); };
 await assert.rejects(tx.commit(), /interrupted/);
 app.vault.create = create;
 await assert.rejects(new VaultTransaction(app as any, settings).recover(), /Recovery conflict/);
 assert.equal(app.fileContents.get('Books/new.md'), 'com');
 // Simulate the user's reviewed resolution: retain the partial file elsewhere.
 await app.fileManager.renameFile(app.vault.getFileByPath('Books/new.md'), 'Books/saved-partial.md');
 assert.equal(await new VaultTransaction(app as any, settings).recover(), true);
 assert.equal(app.fileContents.get('Books/new.md'), 'complete');
 assert.equal(app.fileContents.get('Books/saved-partial.md'), 'com');
}));

test('renames use FileManager so Obsidian can update backlinks', () => fixture(async (app, settings) => {
 await app.vault.create('Books/old.md', '---\nmeta_generator: kindle_sync\nkindle_uuid: one\n---\nbook');
 await app.vault.create('Reader.md', '[[Books/old]]');
 const rename = app.fileManager.renameFile;
 app.vault.rename = async () => { throw new Error('bypassed backlink-aware API'); };
 app.fileManager.renameFile = async (file, destination) => {
  await rename(file, destination);
  await app.vault.modify(app.vault.getFileByPath('Reader.md'), '[[Books/new]]');
 };
 const tx = new VaultTransaction(app as any, settings);
 tx.operations.push({ kind: 'move', from: 'Books/old.md', path: 'Books/new.md', uuid: 'one' });
 await tx.commit();
 assert.equal(app.fileContents.get('Reader.md'), '[[Books/new]]');
}));

test('Linux colon folder paths accepted by settings also commit and recover', () => fixture(async (app, settings) => {
 settings.targetFolder = 'Books:Reading';
 validateVaultSettings(settings);
 const tx = new VaultTransaction(app as any, settings);
 tx.operations.push({ kind: 'write', path: 'Books:Reading/new.md', content: 'complete', create: true });
 const create = app.vault.create;
 app.vault.create = async (...args) => { await create(...args); throw new Error('lost checkpoint'); };
 await assert.rejects(tx.commit(), /lost checkpoint/);
 app.vault.create = create;
 await new VaultTransaction(app as any, settings).recover();
 assert.equal(app.fileContents.get('Books:Reading/new.md'), 'complete');
}));

test('invalid operation paths fail before publishing a journal', () => fixture(async (app, settings) => {
 const tx = new VaultTransaction(app as any, settings);
 tx.operations.push({ kind: 'write', path: '../escape', content: 'no', create: true });
 await assert.rejects(tx.commit(), /Unsafe/);
 assert.equal(await new VaultTransaction(app as any, settings).recover(), false);
}));

const owned = (uuid = 'one', body = 'before') => `---\nmeta_generator: kindle_sync\nkindle_uuid: ${uuid}\n---\n${body}`;
for (const replacement of ['edited', 'missing', 'folder']) {
 test(`existing write rejects ${replacement} during replay`, () => fixture(async (app, settings) => {
  await app.vault.create('Books/note.md', owned());
  const tx = new VaultTransaction(app as any, settings);
  tx.operations.push({ kind: 'write', path: 'Books/note.md', content: owned('one', 'after'), beforeHash: h(owned()) });
  const modify = app.vault.modify;
  app.vault.modify = async () => { throw new Error('interrupt'); };
  await assert.rejects(tx.commit(), /interrupt/);
  app.vault.modify = modify;
  if (replacement === 'edited') await modify(app.vault.getFileByPath('Books/note.md'), owned('one', 'personal edit'));
  else {
   fs.unlinkSync(path.join(app.vaultPath, 'Books/note.md'));
   app.files.delete('Books/note.md');
   if (replacement === 'folder') await app.vault.createFolder('Books/note.md');
  }
  await assert.rejects(new VaultTransaction(app as any, settings).recover(), /conflict/i);
 }));
}
test('move replay rejects unrelated destination', () => fixture(async (app, settings) => {
 await app.vault.create('Books/old.md', owned());
 const tx = new VaultTransaction(app as any, settings);
 tx.operations.push({ kind: 'move', from: 'Books/old.md', path: 'Books/new.md', uuid: 'one' });
 const rename = app.fileManager.renameFile;
 app.fileManager.renameFile = async (...args) => { await rename(...args); throw new Error('interrupt'); };
 await assert.rejects(tx.commit(), /interrupt/);
 await app.vault.modify(app.vault.getFileByPath('Books/new.md'), owned('other'));
 await assert.rejects(new VaultTransaction(app as any, settings).recover(), /conflict/i);
}));
test('cancellation checkpoints completed operation and leaves remaining operations recoverable', () => fixture(async (app, settings) => {
 const controller = new AbortController();
 const tx = new VaultTransaction(app as any, settings, controller.signal);
 tx.operations.push({ kind: 'write', path: 'one.md', content: 'one', create: true }, { kind: 'write', path: 'two.md', content: 'two', create: true });
 const create = app.vault.create;
 app.vault.create = async (...args) => { const file = await create(...args); controller.abort(); return file; };
 await assert.rejects(tx.commit(), /abort/i);
 assert.equal(app.vault.getFileByPath('two.md'), null);
 app.vault.create = create;
 assert.equal(await new VaultTransaction(app as any, settings).recover(), true);
}));

test('normal apply rejects an intervening edit to a later write', () => fixture(async (app, settings) => {
 await app.vault.create('one.md', 'before one');
 await app.vault.create('two.md', 'before two');
 const tx = new VaultTransaction(app as any, settings);
 tx.operations.push({ kind: 'write', path: 'one.md', content: 'after one', beforeHash: h('before one') }, { kind: 'write', path: 'two.md', content: 'after two', beforeHash: h('before two') });
 const modify = app.vault.modify;
 app.vault.modify = async (file, content) => {
  await modify(file, content);
  if (file.path === 'one.md') await modify(app.vault.getFileByPath('two.md'), 'personal edit');
 };
 await assert.rejects(tx.commit(), /conflict/i);
 assert.equal(app.fileContents.get('two.md'), 'personal edit');
 await assert.rejects(new VaultTransaction(app as any, settings).recover(), /conflict/i);
}));
test('move replay rejects a replaced source', () => fixture(async (app, settings) => {
 await app.vault.create('Books/old.md', owned());
 const tx = new VaultTransaction(app as any, settings);
 tx.operations.push({ kind: 'move', from: 'Books/old.md', path: 'Books/new.md', uuid: 'one' });
 const rename = app.fileManager.renameFile;
 app.fileManager.renameFile = async () => { throw new Error('interrupt'); };
 await assert.rejects(tx.commit(), /interrupt/);
 app.fileManager.renameFile = rename;
 await app.vault.modify(app.vault.getFileByPath('Books/old.md'), owned('other'));
 await assert.rejects(new VaultTransaction(app as any, settings).recover(), /conflict/i);
 assert.equal(app.vault.getFileByPath('Books/new.md'), null);
}));
test('exact existing write result is idempotent after lost checkpoint', () => fixture(async (app, settings) => {
 await app.vault.create('note.md', 'before');
 const tx = new VaultTransaction(app as any, settings);
 tx.operations.push({ kind: 'write', path: 'note.md', content: 'after', beforeHash: h('before') });
 const modify = app.vault.modify;
 app.vault.modify = async (...args) => { await modify(...args); throw new Error('interrupt'); };
 await assert.rejects(tx.commit(), /interrupt/);
 app.vault.modify = async () => { throw new Error('must not rewrite exact result'); };
 assert.equal(await new VaultTransaction(app as any, settings).recover(), true);
}));
test('overwrites without a before hash and moves without an owner fail before publishing', () => fixture(async (app, settings) => {
 for (const op of [{ kind: 'write', path: 'note.md', content: 'x' }, { kind: 'move', from: 'a.md', path: 'b.md' }]) {
  const tx = new VaultTransaction(app as any, settings);
  tx.operations.push(op as any);
  await assert.rejects(tx.commit(), /Invalid sync journal operation/);
 }
 assert.equal(await new VaultTransaction(app as any, settings).recover(), false);
}));
