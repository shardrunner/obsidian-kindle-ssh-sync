import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promotePull, writeFileAtomic } from "../src/device/cache";

// Count real calls rather than timing assertions, which vary with disk and CI load.
test("promotion only syncs changed directories", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cache-io-"));
	const nativeFs = require("node:fs") as typeof fs;
	const sync = t.mock.method(nativeFs, "fsyncSync", nativeFs.fsyncSync);
	const files = Array.from({ length: 20 }, (_, i) => ({
		remote: `mnt/us/documents/book-${i}.sdr/book.azw3f`,
		bytes: Buffer.from(`synthetic ${i}`),
	}));
	try {
		promotePull(root, files, { host: "test" });
		// Per file: durable object + live file (four syncs), plus its new SDR directory.
		assert.ok(sync.mock.callCount() <= 5 * files.length + 20, `Too many initial fsyncs: ${sync.mock.callCount()}`);
		const initialSyncs = sync.mock.callCount();
		promotePull(root, files, { host: "test" });
		// Reused objects/directories are already durable; only new live writes/metadata need syncing.
		assert.ok(sync.mock.callCount() - initialSyncs <= 2 * files.length + 10);
		for (const [i, file] of files.entries()) assert.deepEqual(fs.readFileSync(path.join(root, `documents/book-${i}.sdr/book.azw3f`)), file.bytes);
	} finally {
		t.mock.restoreAll();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a normal re-pull refuses a same-size corrupt raw object before journaling", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cache-corrupt-reuse-"));
	const file = { remote: "var/local/cc.db", bytes: Buffer.from("same bytes") };
	try {
		promotePull(root, [file], { host: "test" });
		const object = path.join(root, "raw-objects", fs.readdirSync(path.join(root, "raw-objects"))[0]);
		fs.writeFileSync(object, Buffer.from("bad object")); // same length, different digest
		assert.throws(() => promotePull(root, [file], { host: "test" }), /Corrupt raw object/);
		assert.equal(fs.existsSync(path.join(root, ".pending-promotion.json")), false);
		assert.deepEqual(fs.readFileSync(path.join(root, "cc.db")), file.bytes);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("atomic writes durably create each missing ancestor", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cache-parent-"));
	const nativeFs = require("node:fs") as typeof fs;
	const synced: string[] = [];
	const originalSync = nativeFs.fsyncSync;
	try {
		t.mock.method(nativeFs, "fsyncSync", (fd: number) => {
			if (fs.fstatSync(fd).isDirectory()) synced.push(fs.readlinkSync(`/proc/self/fd/${fd}`));
			originalSync(fd);
		});
		const destination = path.join(root, "one", "two", "three", "file");
		writeFileAtomic(destination, Buffer.from("data"));
		for (const dir of [root, path.join(root, "one"), path.join(root, "one/two"), path.join(root, "one/two/three")]) {
			assert.ok(synced.includes(dir), `Missing directory durability: ${dir}`);
		}
	} finally {
		t.mock.restoreAll();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
