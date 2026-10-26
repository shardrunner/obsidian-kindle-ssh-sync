import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

test('public demo matches production renderer without private data', () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kindle-demo-'));
 try {
  execFileSync(process.execPath, ['--import', require.resolve('tsx'), path.resolve('scripts/generate-demo.ts')], { cwd: root, env: { ...process.env, TZ: 'Europe/Berlin' } });
  const note = 'docs/demo/Alex Example--The Garden of Small Ideas.md';
  assert.equal(fs.readFileSync(path.join(root, note), 'utf8'), fs.readFileSync(note, 'utf8'));
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
