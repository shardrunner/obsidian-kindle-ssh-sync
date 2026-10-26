import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);
async function until(ready: () => boolean) {
 const deadline = Date.now() + 2000;
 while (!ready()) { assert.ok(Date.now() < deadline, 'phase did not start'); await new Promise(r => setImmediate(r)); }
}
async function harness() {
 const state: any = { events: [], notices: [], reports: [], saved: [], settings: [], sizes: 0 };
 class Notice { constructor(public message: string) { state.notices.push(message); } setMessage(m: string) { state.notices.push(m); } hide() {} }
 class Plugin { app = { vault: {} }; async loadData() { return state.persisted; } async saveData(data: any) { state.saved.push(data); } addSettingTab() {} addCommand() {} }
 const mocks: Record<string, any> = {
  obsidian: { Notice, Plugin, parseYaml: () => { throw new Error("unexpected parsing in orchestration mock"); } },
  './settings-tab': { KindleSyncSettingTab: class {} },
  './sync-report-modal': { SyncReportModal: class { constructor(_app: any, report: any) { state.reports.push(report); } open() {} } },
  './decode/sqlite': { hasNodeSqlite: () => true },
  './sync-log': { recordSync: (root: string, entry: any) => { state.events.push('log'); if (state.logError) throw state.logError; (state.logs ??= []).push({ root, ...entry }); } },
  './decode/build': { buildLibrary: () => { state.events.push('decode'); if (state.decodeError) throw state.decodeError; return { library: { books: [], vocabulary: { stats: {}, words: [] } }, archiveGroups: [], warnings: [] }; } },
  './decode/archive': { groupForPresentation: () => ({ books: [], groups: [], conflicts: [] }) },
  './vault-transaction': { VaultTransaction: class { directory = '/fixed-vault'; signal: AbortSignal; async pendingCacheRoot() { return state.pendingRoot; } constructor(_a: any, settings: any, signal: AbortSignal) { this.signal = signal; state.settings.push(settings); } async recover() { state.events.push('vault-recover'); if (state.recoveryWait) await state.recoveryWait; return !!state.pendingRoot; } } },
  './vault-writer': { validateVaultSettings() {}, syncLibraryToVault: async (_a: any, _l: any, settings: any, transaction: { signal: AbortSignal }, parseYaml: unknown, archive: string) => { assert.equal(parseYaml, mocks.obsidian.parseYaml); assert.deepEqual(JSON.parse(archive), { books: [], groups: [], vocabulary: { stats: {}, words: [] } }); transaction.signal.throwIfAborted(); state.settings.push(settings); state.events.push('write'); if (state.writeWait) await state.writeWait; return { created: 1, warnings: [] }; } },
  './device/pull': { formatBytes: String, pullFromDevice: async (o: any) => { state.events.push('pull'); state.settings.push(o.settings); if (state.wait) await state.wait; o.signal.throwIfAborted(); return { warnings: [], fileCount: 0, bytesPulled: 0, newObjects: 0 }; } },
  './device/cache': { resolveCachePath: () => '/fake-cache', defaultCachePath: () => '/default-cache', CacheLock: { acquire: (root: string) => { const held: Set<string> = state.held ??= new Set(); if (held.has(root)) throw new Error(`The cache at ${root} is locked by another sync`); held.add(root); (state.lockRoots ??= []).push(root); state.events.push('lock'); return { release: () => { held.delete(root); state.events.push('release'); } }; } }, recoverCachePromotion: (root: string) => { state.recoveredRoot = root; state.events.push('recover'); }, writeFileAtomic: () => state.events.push('archive'), readCacheSizes: async () => { state.sizes++; if (state.sizeWait) await state.sizeWait; return { objectStoreBytes: 1, objectCount: 1, manifestBytes: 0, archiveBytes: 1 }; }, SIZE_WARNING_BYTES: 100 },
  'node:fs': { existsSync: () => true },
 };
 const result = await build({ entryPoints: ['src/main.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', plugins: [{ name: 'stubs', setup(b) { b.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, external: true } : undefined); } }] });
 const module = { exports: {} as any };
 new Function('require', 'module', 'exports', result.outputFiles[0].text)((id: string) => mocks[id] ?? req(id), module, module.exports);
 return { state, Plugin: module.exports.default };
}

test('the password defaults to the preset and is saved with the other settings', async () => {
 const { state, Plugin } = await harness(); const p = new Plugin();
 state.persisted = undefined; await p.loadSettings();
 assert.equal(p.settings.kindlePassword, 'kindle');
 state.persisted = { kindlePassword: 'saved', targetFolder: 'Books' };
 await p.loadSettings(); assert.equal(p.settings.kindlePassword, 'saved'); assert.equal(p.settings.targetFolder, 'Books');
 p.settings.kindlePassword = 'changed'; await p.saveSettings();
 assert.equal(state.saved.at(-1).kindlePassword, 'changed');
});


test('settings are isolated; recovery and the lock span pull, decode, writes and reporting', async () => {
 const { state, Plugin } = await harness(); const p = new Plugin(); await p.loadSettings();
 let finish!: () => void; state.wait = new Promise<void>(r => finish = r);
 p.settings.targetFolder = 'Original'; const work = p.runSync({ fromDevice: true });
 await until(() => state.events.includes('pull'));
 p.settings.targetFolder = 'Changed'; finish(); await work;
 assert.ok(state.settings.every((s: any) => s.targetFolder === 'Original'));
 assert.deepEqual(state.events, ['lock', 'recover', 'vault-recover', 'pull', 'decode', 'write', 'log', 'release']);
 assert.equal(state.logs.length, 1); const log = state.logs[0];
 assert.equal(log.root, '/fake-cache'); assert.equal(log.outcome, 'success'); assert.equal(log.source, 'device');
 assert.equal(log.stats.created, 1); assert.deepEqual(log.warnings, []); assert.equal(log.cacheSummary, state.reports[0].cacheSummary);
 assert.equal(state.sizes, 1); assert.equal(state.reports[0].stats.warnings.length, 0); assert.ok(state.reports[0].cacheSummary);
});

for (const action of ['cancelSync', 'onunload']) test(`${action} keeps cross-instance lock until work stops and prevents writes`, async () => {
 const { state, Plugin } = await harness(); const p = new Plugin(); const other = new Plugin(); other.app = p.app;
 let finish!: () => void; state.wait = new Promise<void>(r => finish = r);
 const work = p.runSync({ fromDevice: true });
 await until(() => state.events.includes('pull'));
 p[action](); const noticeCount = state.notices.length;
 // The filesystem lock, not an in-memory registry, excludes the second instance.
 await other.runSync({ fromDevice: false }); assert.equal(state.events.filter((e: string) => e === 'lock').length, 1);
 const afterOther = state.notices.length; assert.ok(afterOther >= noticeCount);
 assert.ok(!state.events.includes('release')); finish(); await work;
 assert.ok(!state.events.includes('decode') && !state.events.includes('write')); assert.equal(state.events.at(-1), 'release'); assert.equal(state.reports.length, 0);
 // The locked-out second instance never held the lock, so only the cancelled sync is logged.
 assert.deepEqual(state.logs.map((l: any) => l.outcome), ['cancelled']);
 if (action === 'onunload') assert.equal(state.notices.length, afterOther);
 state.wait = undefined; await other.runSync({ fromDevice: false }); assert.equal(state.reports.length, 1);
});

for (const phase of ['recovery', 'write', 'size']) test(`unload during ${phase} awaits settlement before releasing locks`, async () => {
 const { state, Plugin } = await harness(); const p = new Plugin();
 let finish!: () => void; state[`${phase}Wait`] = new Promise<void>(r => finish = r);
 const work = p.runSync({ fromDevice: false });
 await until(() => phase === 'size' ? state.sizes === 1 : state.events.includes(phase === 'recovery' ? 'vault-recover' : 'write'));
 p.onunload(); const notices = state.notices.length;
 assert.ok(!state.events.includes('release')); finish(); await work;
 assert.equal(state.events.at(-1), 'release'); assert.equal(state.notices.length, notices); assert.equal(state.reports.length, 0);
 if (phase !== 'size') assert.ok(!state.events.includes('archive'));
});

 test('changed cache recovers the journal snapshot cache before any pull or decode', async () => {
 const { state, Plugin } = await harness(); const p = new Plugin();
 state.pendingRoot = '/old-cache'; p.settings.cachePath = '/new-cache';
 await p.runSync({ fromDevice: true });
 assert.deepEqual(state.lockRoots, ['/default-cache']);
 assert.equal(state.recoveredRoot, '/old-cache');
 assert.deepEqual(state.events, ['lock', 'recover', 'vault-recover', 'log', 'release']);
 assert.equal(state.reports.length, 0); assert.equal(state.logs[0].outcome, 'recovered');
});

test('a failed sync is logged with its error before the lock is released', async () => {
 const { state, Plugin } = await harness(); const p = new Plugin();
 state.decodeError = new Error('bad cc.db');
 await p.runSync({ fromDevice: false });
 assert.deepEqual(state.events.slice(-2), ['log', 'release']);
 assert.equal(state.logs[0].outcome, 'failed'); assert.equal(state.logs[0].source, 'cache');
 assert.match(state.logs[0].error, /bad cc\.db/); assert.equal(state.logs[0].stats, undefined);
 assert.ok(state.notices.some((n: string) => n.includes('bad cc.db')));
});

test('a log write failure is reported without hiding the sync result or keeping the lock', async () => {
 const { state, Plugin } = await harness(); const p = new Plugin();
 state.logError = new Error('disk full');
 await p.runSync({ fromDevice: false });
 assert.equal(state.reports.length, 1); assert.equal(state.events.at(-1), 'release');
 assert.ok(state.notices.some((n: string) => n.includes('disk full')));
});
