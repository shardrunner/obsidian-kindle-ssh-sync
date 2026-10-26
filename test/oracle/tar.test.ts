import { test } from "node:test";

import assert from "node:assert/strict";

import * as fs from "node:fs";

import * as path from "node:path";

import { parseTar, TarParser } from "../../src/device/tar";

import { mapRemotePath } from "../../src/device/cache";

const FIXTURES = path.join(__dirname, "../fixtures");

const PULL_TAR = path.join(FIXTURES, "pull.tar");

const CACHE = path.join(FIXTURES, "cache");

function pullTar(): Uint8Array {
	if (!fs.existsSync(PULL_TAR)) throw new Error(`missing fixture ${PULL_TAR}`);
	return new Uint8Array(fs.readFileSync(PULL_TAR));
}

let cached: ReturnType<typeof parseTar> | undefined;

function entries() {
	if (!cached) cached = parseTar(pullTar());
	return cached;
}

test("the archive parses into files and directories with no unsupported members", () => {
	const all = entries();
	const files = all.filter((e) => e.type === "file");
	const dirs = all.filter((e) => e.type === "directory");

	assert.equal(files.length, 1221);
	assert.equal(dirs.length, 335);
});

test("GNU LongName entries are resolved, not truncated to 100 bytes", () => {
	const all = entries();
	const long = all.filter((e) => e.name.length > 100);

	// A parser that ignores typeflag 'L' would produce zero of these and would
	// silently truncate or garble the majority of the archive instead.
	assert.equal(long.length, 880);
	for (const e of long) {
		assert.ok(!e.name.includes("\0"), `NUL in resolved name: ${e.name}`);
		assert.ok(e.name.startsWith("mnt/") || e.name.startsWith("var/"), e.name);
	}
});

test("every extracted file is byte-identical to the cached original", () => {
	const mismatches: string[] = [];
	let compared = 0;

	for (const e of entries()) {
		if (e.type !== "file") continue;
		const local = mapRemotePath(e.name);
		assert.ok(local, `unmapped member ${e.name}`);

		const original = fs.readFileSync(path.join(CACHE, ...local!.split("/")));
		compared++;
		if (Buffer.compare(Buffer.from(e.data), original) !== 0) mismatches.push(e.name);
	}

	assert.deepStrictEqual(mismatches.slice(0, 5), [], `${mismatches.length} files differ`);
	assert.equal(compared, 1221);
});

test("tar strips the leading slash, and every member maps into the cache", () => {
	for (const e of entries()) {
		assert.ok(!e.name.startsWith("/"), `member kept its leading slash: ${e.name}`);
	}
	assert.equal(mapRemotePath("var/local/cc.db"), "cc.db");
	assert.equal(mapRemotePath("mnt/us/system/vocabulary/vocab.db"), "vocab.db");
	assert.equal(mapRemotePath("mnt/us/documents/A/B.sdr/x.yjf"), "documents/A/B.sdr/x.yjf");
	assert.equal(mapRemotePath("mnt/us/system/thumbnails/t.jpg"), "thumbnails/t.jpg");
	// Anything outside the explicit mapping is refused, not written somewhere
	// plausible.
	assert.equal(mapRemotePath("etc/passwd"), null);
	assert.equal(mapRemotePath("mnt/us/other/x"), null);
	assert.equal(mapRemotePath("var/local/cc.db.bak"), null);
});

test("parsing streams: chunk boundaries never change the result", () => {
	const bytes = pullTar();
	const collected: string[] = [];
	const parser = new TarParser((e) => collected.push(`${e.name}:${e.size}`));

	// Deliberately unaligned chunks, so no boundary falls on a 512-block.
	const step = 7919;
	for (let i = 0; i < bytes.length; i += step) {
		parser.write(bytes.subarray(i, Math.min(i + step, bytes.length)));
	}
	parser.end();

	assert.deepStrictEqual(collected, entries().map((e) => `${e.name}:${e.size}`));
});
