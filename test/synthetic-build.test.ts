import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildLibrary } from '../src/decode/build';
import { loadCcDatabase } from '../src/decode/cc-db';
import { groupForPresentation } from '../src/decode/archive';
import { DEFAULT_SETTINGS } from '../src/types';
import { MockVaultApp, syncVault } from './mock-vault';

test('synthetic SQLite catalogue builds, groups and writes reproducible notes', async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kindle-synthetic-build-'));
 try {
  const db = new DatabaseSync(path.join(root, 'cc.db'));
  try {
   db.exec(`CREATE TABLE Entries (p_type TEXT, p_uuid TEXT, p_cdeKey TEXT, p_cdeGroup TEXT, p_titles_0_nominal TEXT, p_languages_0 TEXT);
    INSERT INTO Entries VALUES ('Entry:Item', 'synthetic-book', 'synthetic-key', NULL, 'Synthetic Book', 'en');
    INSERT INTO Entries VALUES ('Entry:Item:Series', 'synthetic-series', 'series-key', 'series-group', 'Synthetic Series', 'en');
    CREATE TABLE Series (d_itemCdeKey TEXT, d_seriesId TEXT, d_itemPositionLabel TEXT, d_itemPosition REAL);
    INSERT INTO Series VALUES ('synthetic-key', 'series-key', '1', 1);`);
  } finally { db.close(); }
  const cc = loadCcDatabase(path.join(root, 'cc.db'));
  assert.equal(cc.seriesOf['synthetic-key'].seriesId, 'series-key');
  assert.equal(cc.seriesName['series-key'], 'Synthetic Series');
  const built = buildLibrary(root);
  assert.equal(built.library.books.length, 1);
  assert.equal(built.library.books[0].title, 'Synthetic Book');
  const grouped = groupForPresentation(built.library.books);
  const app = new MockVaultApp(path.join(root, 'vault'));
  const settings = { ...DEFAULT_SETTINGS, targetFolder: 'Books', copyCovers: false };
  const library = { ...built.library, books: grouped.books };
  assert.equal((await syncVault(app as any, library, settings)).created, 1);
  assert.equal((await syncVault(app as any, library, settings)).unchanged, 1);
 } finally { fs.rmSync(root, { recursive: true }); }
});
