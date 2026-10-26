import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MockVaultApp, syncVault } from './mock-vault';
import { VaultTransaction } from '../src/vault-transaction';
import { DEFAULT_SETTINGS } from '../src/types';

for (const interruption of ['none', 'write', 'park', 'rename'] as const) {
 test(`batch preserves rename updates in rewritten notes (interruption: ${interruption})`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kindle-backlinks-'));
  try {
   const app = new MockVaultApp(path.join(root, 'vault'));
   const settings = { ...DEFAULT_SETTINGS, targetFolder: 'Books', inactiveSubfolder: '', copyCovers: false, cachePath: path.join(root, 'cache') };
   const owned = (uuid: string, body = '') => `---\nmeta_generator: kindle_sync\nkindle_uuid: ${uuid}\nrelated: "[[Books/Auth--Old]]"\n---\n${body}`;
   await app.vault.create('Books/Auth--Old.md', owned('mover'));
   await app.vault.create('Books/Auth--Reader.md', owned('reader'));
   await app.vault.create('Books/orphan.md', owned('orphan', 'Preserved body: [[Books/Auth--Old]]\n'));

   const modify = app.vault.modify;
   let writeInterrupted = false;
   app.vault.modify = async (file, content) => {
    await modify(file, content);
    if (interruption === 'write' && !writeInterrupted) {
     writeInterrupted = true;
     throw new Error('lost write checkpoint');
    }
   };

   // Model FileManager's link-update side effect, including links in properties.
   // The production writer must not subsequently undo these changes.
   const rename = app.fileManager.renameFile;
   app.fileManager.renameFile = async (file, destination) => {
    const oldLink = `[[${file.path.slice(0, -3)}]]`;
    const newLink = `[[${destination.slice(0, -3)}]]`;
    await rename(file, destination);
    for (const note of app.vault.getMarkdownFiles()) {
     const before = await app.vault.read(note);
     if (before.includes(oldLink)) await app.vault.modify(note, before.replaceAll(oldLink, newLink));
    }
    if ((interruption === 'rename' && destination === 'Books/Auth--New.md') ||
        (interruption === 'park' && destination === 'Books/__kindle-sync-move-mover.md')) {
     throw new Error('lost rename checkpoint');
    }
   };

   const library = { books: [
    { uuid: 'mover', author: 'Auth', title: 'New', read_status: 'read' },
    { uuid: 'reader', author: 'Auth', title: 'Reader', read_status: 'read' },
    // A new book must still be able to occupy the mover's former path.
    { uuid: 'new', author: 'Auth', title: 'Old', read_status: 'read' },
   ] };
   if (interruption !== 'none') {
    await assert.rejects(syncVault(app as any, library, settings), /lost (write|rename) checkpoint/);
    assert.equal(await new VaultTransaction(app as any, settings).recover(), true);
   } else {
    await syncVault(app as any, library, settings);
   }
   for (const p of ['Books/Auth--New.md', 'Books/Auth--Reader.md', 'Books/orphan.md']) {
    const content = app.fileContents.get(p)!;
    assert.ok(content.includes('[[Books/Auth--New]]'), `${p} lost its updated link`);
    assert.ok(!content.includes('[[Books/Auth--Old]]'), `${p} restored a stale link`);
    assert.ok(!content.includes('__kindle-sync-move-'), `${p} retained a temporary link`);
   }
   assert.match(app.fileContents.get('Books/orphan.md')!, /Preserved body: \[\[Books\/Auth--New\]\]/);
   assert.match(app.fileContents.get('Books/Auth--Old.md')!, /kindle_uuid: "new"/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
 });
}
