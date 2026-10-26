import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MockVaultApp, syncVault } from './mock-vault';
import { DEFAULT_SETTINGS } from '../src/types';
import { generateFilenames } from '../src/book-note';

const book = { uuid: 'synthetic-id', title: 'Synthetic Book', percentFinished: 50 };
const settings = { ...DEFAULT_SETTINGS, targetFolder: 'Books', inactiveSubfolder: '', copyCovers: false };
const dest = `Books/${generateFilenames([book]).get(book.uuid)}`;
const owned = (uuid = book.uuid) => `---\nmeta_generator: kindle_sync\nkindle_uuid: ${uuid}\n---\n\n## Highlights\n\n> Keep me\n`;
async function fixture(fn: (app: MockVaultApp) => Promise<void>) {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kindle-safety-'));
 try { await fn(new MockVaultApp(dir)); } finally { fs.rmSync(dir, { recursive: true }); }
}
for (const kind of ['file', 'folder', 'other uuid', 'moving', 'temp']) {
 test(`preflight refuses ${kind} collision without mutations`, () => fixture(async app => {
  if (kind === 'moving' || kind === 'temp') await app.vault.create('Books/old.md', owned());
  const blocked = kind === 'temp' ? `Books/__kindle-sync-move-${book.uuid}.md` : dest;
  if (kind.includes('folder')) await app.vault.createFolder(blocked);
  else await app.vault.create(blocked, kind === 'other uuid' ? owned('other') : 'personal content');
  const before = [...app.fileContents];
  await assert.rejects(syncVault(app as any, { books: [book] }, settings));
  assert.deepEqual([...app.fileContents], before);
 }));
}
test('read error aborts before creating or moving anything', () => fixture(async app => {
 await app.vault.create('Books/old.md', owned());
 app.vault.read = async () => { throw new Error('synthetic read failure'); };
 const before = [...app.fileContents];
 await assert.rejects(syncVault(app as any, { books: [book] }, settings), /synthetic read failure/);
 assert.deepEqual([...app.fileContents], before);
}));
for (const field of ['targetFolder', 'inactiveSubfolder', 'assetsSubfolder']) {
 for (const value of ['../escape', '/absolute', 'a/../b', 'a\0b', 'C:\\escape']) {
  test(`rejects ${field} ${JSON.stringify(value)} before writes`, () => fixture(async app => {
   await assert.rejects(syncVault(app as any, { books: [book] }, { ...settings, [field]: value }));
   assert.deepEqual(fs.readdirSync(app.vaultPath), []);
  }));
 }
}
test('owned note updates and then converges', () => fixture(async app => {
 await app.vault.create(dest, owned());
 await syncVault(app as any, { books: [book] }, settings);
 assert.match(app.fileContents.get(dest)!, /Keep me/);
 const stats = await syncVault(app as any, { books: [book] }, settings);
 assert.equal(stats.unchanged, 1);
}));

{
 test('cover preflight rejects a folder at the cover path without note writes', () => fixture(async app => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'kindle-cover-cache-'));
  try {
   fs.mkdirSync(path.join(cache, 'thumbnails'));
   fs.writeFileSync(path.join(cache, 'thumbnails', 'synthetic.jpg'), 'new');
   const destination = 'Books/assets/synthetic.jpg';
   await app.vault.createFolder(destination);
   const before = [...app.fileContents];
   await assert.rejects(syncVault(app as any, { books: [{ ...book, thumbnail: 'synthetic.jpg' }] }, { ...settings, copyCovers: true, cachePath: cache }), /cover destination/);
   assert.deepEqual([...app.fileContents], before);
  } finally { fs.rmSync(cache, { recursive: true }); }
 }));
}
test('duplicate owned UUIDs fail', () => fixture(async app => {
 await app.vault.create('Books/one.md', owned());
 await app.vault.create('Books/two.md', owned());
 const before = [...app.fileContents];
 await assert.rejects(syncVault(app as any, { books: [book] }, settings), /Duplicate owned UUID/);
 assert.deepEqual([...app.fileContents], before);
}));
test('a file blocking a configured folder fails before writes', () => fixture(async app => {
 await app.vault.create('Books', 'personal');
 await assert.rejects(syncVault(app as any, { books: [book] }, settings), /blocks folder/);
 assert.equal(app.fileContents.size, 1);
}));
test('planned note cannot also be a configured folder', () => fixture(async app => {
 await assert.rejects(syncVault(app as any, { books: [book] }, {
  ...settings, inactiveSubfolder: dest.slice('Books/'.length),
 }), /blocks configured folder/);
 assert.deepEqual(fs.readdirSync(app.vaultPath), []);
}));
test('owned notes parked at their temporary name recover', () => fixture(async app => {
 await app.vault.create(`Books/__kindle-sync-move-${book.uuid}.md`, owned());
 await syncVault(app as any, { books: [book] }, settings);
 assert.match(app.fileContents.get(dest)!, /Keep me/);
}));

test('changed cover is overwritten with a warning', () => fixture(async app => {
 const cache = path.join(app.vaultPath, 'cache');
 fs.mkdirSync(path.join(cache, 'thumbnails'), { recursive: true });
 fs.writeFileSync(path.join(cache, 'thumbnails/test.jpg'), 'new');
 await app.vault.createBinary('Books/assets/test.jpg', new TextEncoder().encode('old').buffer as ArrayBuffer);
 const stats = await syncVault(app as any, { books: [{ ...book, thumbnail: 'test.jpg' }] }, { ...settings, cachePath: cache, copyCovers: true });
 assert.equal(fs.readFileSync(path.join(app.vaultPath, 'Books/assets/test.jpg'), 'utf8'), 'new');
 assert.ok(stats.warnings.some(w => /Overwriting changed cover/.test(w)));
}));

for (const current of ['personal content', owned('different-id')]) {
 test('stale metadata cannot authorize replacing a book note', () => fixture(async app => {
  await app.vault.create(dest, current);
  app.metadataCache.getFileCache = () => ({ frontmatter: { meta_generator: 'kindle_sync', kindle_uuid: book.uuid } });
  await assert.rejects(syncVault(app as any, { books: [book] }, settings), /ownership changed/i);
  assert.equal(app.fileContents.get(dest), current);
 }));
}

test('pre-aborted writer performs no operations', () => fixture(async app => {
 const controller = new AbortController();
 controller.abort();
 await assert.rejects(syncVault(app as any, { books: [book] }, settings, controller.signal), /abort/i);
 assert.equal(app.files.size, 0);
}));

for (const orphan of [false, true]) {
 test(`current custom properties survive stale metadata (orphan=${orphan})`, () => fixture(async app => {
  await app.vault.create(dest, owned().replace('---\n\n', 'book_rating: 3\nremoved_property: old\nkindle_on_device: true\n---\n\n'));
  const cached = app.metadataCache.getFileCache(app.vault.getFileByPath(dest));
  const current = owned().replace('---\n\n', 'book_rating: 5\ntags: ["fiction", "favorite"]\n"reading: notes": {"comment":"current"}\nkindle_on_device: true\n---\n\n');
  await app.vault.modify(app.vault.getFileByPath(dest), current);
  app.metadataCache.getFileCache = () => cached;
  await syncVault(app as any, { books: orphan ? [] : [book] }, settings);
  const result = app.fileContents.get(dest)!;
  assert.match(result, /book_rating: 5/);
  assert.match(result, /tags: \["fiction","favorite"\]/);
  assert.match(result, /"reading: notes": \{"comment":"current"\}/);
  assert.doesNotMatch(result, /removed_property:/);
  if (orphan) assert.match(result, /kindle_on_device: false/);
 }));
}

test('orphan decisions use current properties when metadata says already off-device', () => fixture(async app => {
 await app.vault.create(dest, owned().replace('---\n\n', 'kindle_on_device: false\nkindle_finished: true\n---\n\n'));
 const cached = app.metadataCache.getFileCache(app.vault.getFileByPath(dest));
 await app.vault.modify(app.vault.getFileByPath(dest), owned().replace('---\n\n', 'kindle_on_device: true\nkindle_finished: false\nkindle_read_status: reading\n---\n\n'));
 app.metadataCache.getFileCache = () => cached;
 const stats = await syncVault(app as any, { books: [] }, settings);
 assert.equal(stats.orphaned, 1);
 assert.match(app.fileContents.get(dest)!, /kindle_on_device: false/);
 assert.match(app.fileContents.get(dest)!, /kindle_read_status: "abandoned"/);
}));

test('malformed current frontmatter fails before any vault writes', () => fixture(async app => {
 await app.vault.create(dest, owned());
 const cached = app.metadataCache.getFileCache(app.vault.getFileByPath(dest));
 const current = owned().replace('---\n\n', 'tags: [unterminated\n---\n\n');
 await app.vault.modify(app.vault.getFileByPath(dest), current);
 app.metadataCache.getFileCache = () => cached;
 await assert.rejects(syncVault(app as any, { books: [book, { uuid: 'new', title: 'New' }] }, settings), /Invalid frontmatter/);
 assert.deepEqual([...app.fileContents], [[dest, current]]);
}));
