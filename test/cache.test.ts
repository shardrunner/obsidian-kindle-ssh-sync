import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CacheError,
	CacheLock,
	defaultCachePath,
	isExcludedMember,
	mapRemotePath,
	promotePull,
	readCacheSizes,
	readObject,
	sha256,
	StagedFile,
} from "../src/device/cache";
import { buildPullCommand } from "../src/device/pull";
import { buildConnectConfig, DEVICE_DEFAULTS, parseHost } from "../src/device/ssh";

function scratch(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "kindle-ssh-sync-cache-"));
}

const file = (remote: string, text: string): StagedFile => ({
	remote,
	bytes: new TextEncoder().encode(text),
});

/** Snapshot manifests, oldest first: their names start with the ISO time. */
const manifests = (dir: string) =>
	fs.readdirSync(path.join(dir, "snapshots")).sort()
		.map((name) => JSON.parse(fs.readFileSync(path.join(dir, "snapshots", name), "utf-8")));

test("a pull writes raw objects, a manifest and the live view, in that order", () => {
	const dir = scratch();
	try {
		const files = [
			file("var/local/cc.db", "database-one"),
			file("mnt/us/documents/a.sdr/x.yjf", "sidecar"),
		];
		const r = promotePull(dir, files, { host: "kindle", takenAt: new Date("2026-08-22T10:00:00Z") });

		assert.equal(r.newObjects, 2);
		assert.equal(fs.readFileSync(path.join(dir, "cc.db"), "utf-8"), "database-one");
		assert.equal(
			fs.readFileSync(path.join(dir, "documents", "a.sdr", "x.yjf"), "utf-8"),
			"sidecar"
		);

		const [manifest] = manifests(dir);
		assert.equal(manifest.host, "kindle");
		assert.equal(manifest.files["var/local/cc.db"], sha256(files[0].bytes));

		// Every byte is recoverable from the object store alone.
		assert.equal(
			new TextDecoder().decode(readObject(dir, manifest.files["var/local/cc.db"])),
			"database-one"
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("a changed database does not destroy its predecessor -- hole 1 is closed", async () => {
	const dir = scratch();
	try {
		promotePull(dir, [file("var/local/cc.db", "with-the-book")], {
			host: "k",
			takenAt: new Date("2026-08-22T10:00:00Z"),
		});
		// The device deleted a book, so the new cc.db simply lacks its row.
		promotePull(dir, [file("var/local/cc.db", "without-it")], {
			host: "k",
			takenAt: new Date("2026-08-22T11:00:00Z"),
		});

		assert.equal(fs.readFileSync(path.join(dir, "cc.db"), "utf-8"), "without-it");

		// The old bytes are still there, reachable through the older manifest.
		const [oldManifest, newManifest] = manifests(dir);
		assert.equal(
			new TextDecoder().decode(readObject(dir, oldManifest.files["var/local/cc.db"])),
			"with-the-book"
		);
		assert.equal((await readCacheSizes(dir)).objectCount, 2);
		assert.notEqual(oldManifest.takenAt, newManifest.takenAt);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("a byte-identical re-pull adds no new object and no duplicate", async () => {
	const dir = scratch();
	try {
		const files = [file("var/local/cc.db", "same")];
		const first = promotePull(dir, files, { host: "k", takenAt: new Date("2026-08-22T10:00:00Z") });
		const second = promotePull(dir, files, { host: "k", takenAt: new Date("2026-08-22T11:00:00Z") });

		assert.equal(first.newObjects, 1);
		assert.equal(second.newObjects, 0, "content-addressed storage must deduplicate");
		assert.equal((await readCacheSizes(dir)).objectCount, 1);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("the cache lock is exclusive, so two vaults cannot interleave", () => {
	const dir = scratch();
	try {
		const lock = CacheLock.acquire(dir);
		assert.throws(() => CacheLock.acquire(dir), CacheError);
		assert.throws(() => CacheLock.acquire(dir), /locked by another sync/);

		lock.release();
		// Releasing twice is not an error, and the lock is reusable afterwards.
		lock.release();
		CacheLock.acquire(dir).release();
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("the default cache path honours XDG_DATA_HOME", () => {
	const saved = process.env.XDG_DATA_HOME;
	try {
		process.env.XDG_DATA_HOME = "/tmp/xdg-test";
		assert.equal(defaultCachePath(), "/tmp/xdg-test/kindle-ssh-sync");
		delete process.env.XDG_DATA_HOME;
		assert.match(defaultCachePath(), /\.local\/share\/kindle-ssh-sync$/);
	} finally {
		if (saved === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = saved;
	}
});

test("readObject refuses anything that is not a digest", () => {
	assert.throws(() => readObject("/tmp", "../../etc/passwd"), /Not a sha256 digest/);
	assert.throws(() => readObject("/tmp", "abc"), /Not a sha256 digest/);
});

// --- the remote command ----------------------------------------------------

test("the pull command guards against a partial find and avoids --null", () => {
	const cmd = buildPullCommand();

	assert.match(cmd, /^set -eu$/m, "a failed find must not yield a successful pull");
	assert.match(cmd, /trap 'rm -f "\$list"' EXIT HUP INT TERM/);
	// busybox 1.28.3 rejects --null outright.
	assert.ok(!cmd.includes("--null"), "busybox tar does not support --null");
	assert.ok(!cmd.includes("-print0"), "newline-separated -T is the measured idiom");
	assert.match(cmd, /-T "\$list"/);
});

test("fmcache.db is listed only when present, and there is only one archive", () => {
	const cmd = buildPullCommand();

	// tar exits non-zero on a missing member, and the directory does not exist on 5.11.2.
	assert.match(cmd, /if \[ -e \/mnt\/us\/system\/fmcache\/fmcache\.db \]/);
	// An `&&` between two halves would short-circuit and silently skip the
	// documents tree; a second `tar cf -` would concatenate two archives.
	assert.ok(!cmd.includes("&&"), "no short-circuit between pull halves");
	assert.equal(cmd.match(/tar cf -/g)?.length, 1, "exactly one archive in the stream");
});

test("the pull command asks for every sidecar extension, not only the decoded ones", () => {
	const cmd = buildPullCommand();
	// Backed up != decoded: the ask was to keep all the raw data.
	for (const ext of [".azw3f", ".azw3r", ".yjf", ".yjr", ".mbs", ".mbp1", ".xray", ".asc", ".phl", ".ea", ".eal", ".pdr", ".apnx"]) {
		assert.ok(cmd.includes(`-name '*${ext}'`), `missing ${ext}`);
	}
});

// --- transport -------------------------------------------------------------

test("blank host/user use device defaults with explicit password auth and pin", () => {
	const config = buildConnectConfig({
		kindleHost: "",
		kindleUser: "   ",
		kindlePassword: "session-secret",
		kindleHostFingerprint: "SHA256:" + "A".repeat(43),
		syncTimeoutSeconds: 600,
	});

	assert.equal(config.host, DEVICE_DEFAULTS.host);
	assert.equal(config.username, DEVICE_DEFAULTS.user);
	assert.equal(config.password, "session-secret");
	assert.deepEqual(config.authHandler, ["password"]);
	assert.equal(typeof config.hostVerifier, "function");
	assert.equal(config.readyTimeout, 15_000);
	// The probe measured modern algorithms only, so no override is needed.
	assert.equal((config as Record<string, unknown>).algorithms, undefined);
});

test("explicit settings win over the defaults", () => {
	const config = buildConnectConfig({
		kindleHost: " 10.0.0.5 ",
		kindleUser: "user",
		kindlePassword: "secret",
		kindleHostFingerprint: "SHA256:" + "A".repeat(43),
		syncTimeoutSeconds: 30,
	});
	assert.equal(config.host, "10.0.0.5");
	assert.equal(config.username, "user");
	assert.equal(config.password, "secret");
	assert.equal(config.readyTimeout, 15_000);
});

test("an explicit port in the host setting is honoured, not silently ignored", () => {
	assert.deepStrictEqual(parseHost(undefined), { host: DEVICE_DEFAULTS.host, port: 22 });
	assert.deepStrictEqual(parseHost("  "), { host: DEVICE_DEFAULTS.host, port: 22 });
	assert.deepStrictEqual(parseHost("192.168.15.244"), { host: "192.168.15.244", port: 22 });
	assert.deepStrictEqual(parseHost("127.0.0.1:2222"), { host: "127.0.0.1", port: 2222 });
	assert.throws(() => parseHost("host:0"), /Not a valid port/);
});

/**
 * The device's thumbnails directory is not only covers for books you own.
 * Kindle also parks Amazon store wishlist art in a `StoreWishListResults`
 * subfolder, and leaves zero-byte `.partial` files behind while a cover is
 * still downloading. Neither belongs in a reading archive.
 *
 * Measured on FW 5.11.2, 2026-08-23: 15 wishlist covers, 18 partials, and not
 * one of the 15 ASINs appears among the 519 cdeKeys in the catalogue.
 */
test("store wishlist covers are not cached: they are not books you own", () => {
	assert.equal(
		mapRemotePath("mnt/us/system/thumbnails/StoreWishListResults/thumbnail_B005LWRAKU_EBOK.jpg"),
		null
	);
	assert.equal(mapRemotePath("mnt/us/system/thumbnails/StoreWishListResults"), null);
	assert.ok(isExcludedMember("mnt/us/system/thumbnails/StoreWishListResults/x.jpg"));

	// A cover for a book you do own, in the same directory, is still cached.
	assert.equal(
		mapRemotePath("mnt/us/system/thumbnails/thumbnail_B005LWRAKU_EBOK.jpg"),
		"thumbnails/thumbnail_B005LWRAKU_EBOK.jpg"
	);
	assert.equal(isExcludedMember("mnt/us/system/thumbnails/thumbnail_B005LWRAKU_EBOK.jpg"), false);
});

test("half-downloaded .partial covers are not cached", () => {
	assert.equal(
		mapRemotePath("mnt/us/system/thumbnails/thumbnail_B016WQUL7C_EBOK_portrait.jpg.partial"),
		null
	);
	assert.ok(isExcludedMember("mnt/us/documents/whatever.azw3f.partial"));

	// `.partial` must match only as a suffix, never as a substring.
	assert.equal(isExcludedMember("mnt/us/system/thumbnails/thumbnail_partial_EBOK.jpg"), false);
});

test("an unmapped path is not an exclusion: pull.ts tells the two apart", () => {
	// Both are null from mapRemotePath, but only one is a surprise. pull.ts
	// warns about the unmapped path and stays quiet about the exclusion, so
	// these two must never collapse into one another.
	assert.equal(mapRemotePath("etc/shadow"), null);
	assert.equal(isExcludedMember("etc/shadow"), false);
});
