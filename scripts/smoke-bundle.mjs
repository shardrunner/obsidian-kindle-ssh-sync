import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire, isBuiltin } from 'node:module';
import { createHash } from 'node:crypto';

// Evaluate the release bytes, not a separately bundled test entry. The appended
// probe relies on esbuild's unminified internal names and fails loudly on drift.
const filename = path.resolve(process.argv[2] ?? 'main.js');
const source = fs.readFileSync(filename, 'utf8');
const require = createRequire(import.meta.url);
const blocked = new Set();
const commands = [];
const notices = [];
class Plugin {
  app = {};
  async loadData() { return {}; }
  async saveData(data) { this.data = data; }
  addSettingTab() {}
  addCommand(command) { commands.push(command); }
}
const obsidian = {
  Plugin,
  PluginSettingTab: class {},
  Modal: class {},
  Notice: class { constructor(message) { notices.push(message); } },
  TFile: class {},
  TFolder: class {},
  normalizePath: (value) => value.replaceAll('\\', '/'),
};
function bundleRequire(id) {
  if (id === 'obsidian') return obsidian;
  if (id === 'cpu-features' || id.endsWith('.node')) {
    blocked.add(id);
    const error = new Error(`Synthetic missing optional dependency: ${id}`);
    error.code = 'MODULE_NOT_FOUND';
    throw error;
  }
  assert.ok(isBuiltin(id), `Unexpected external runtime dependency: ${id}`);
  return require(id);
}
const module = { exports: {} };
const context = vm.createContext({
  module, exports: module.exports, require: bundleRequire,
  Buffer, process, console, setTimeout, clearTimeout, setInterval, clearInterval,
  setImmediate, clearImmediate, TextDecoder, TextEncoder, AbortController,
  __filename: filename, __dirname: path.dirname(filename),
});
new vm.Script(source + '\n;globalThis.__smoke = { buildLibrary, buildConnectConfig };', { filename }).runInContext(context);
const plugin = new module.exports.default();
await plugin.onload();
assert.deepEqual(commands.map(({ id }) => id).sort(), ['cancel-kindle-sync', 'sync-kindle-cache', 'sync-kindle-device']);
assert.equal(notices.length, 0, `Unexpected load notices: ${notices.join('; ')}`);
assert.ok([...blocked].some((id) => id.endsWith('sshcrypto.node')), 'Native SSH crypto fallback was not exercised');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kindle-bundle-smoke-'));
try {
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = path.join(root, 'cc.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE Entries(p_type TEXT, p_uuid TEXT, p_titles_0_nominal TEXT); INSERT INTO Entries VALUES ('Entry:Item', 'smoke-1', 'Smoke book')");
  } finally { db.close(); }
  const result = context.__smoke.buildLibrary(root);
  assert.equal(result.library.books.length, 1);
  assert.equal(result.library.books[0].title, 'Smoke book');
  const hostKey = Buffer.from('synthetic host key');
  const config = context.__smoke.buildConnectConfig({
    kindleHost: '127.0.0.1:2222', kindleUser: 'synthetic',
    kindlePassword: 'synthetic-only',
    kindleHostFingerprint: 'SHA256:' + createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, ''),
    syncTimeoutSeconds: 1,
  });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 2222);
  assert.equal(config.password, 'synthetic-only');
  assert.equal(config.hostVerifier(hostKey), true);
  assert.equal(config.hostVerifier(Buffer.from('wrong key')), false);
  plugin.onunload();
  console.log('Bundle smoke passed: plugin load, bundled SQLite decode, SSH config/host key check, missing native accelerator fallback.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
