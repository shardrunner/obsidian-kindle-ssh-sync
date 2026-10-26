import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildLibrary } from "../../src/decode/build";
import { groupForPresentation, PresentationGroup } from "../../src/decode/archive";
import { RawBook } from "../../src/types";

const FIXTURES = path.join(__dirname, "../fixtures");
const CACHE = path.join(FIXTURES, "cache");

/**
 * A scratch cache seeded from the frozen fixture. Rebuilding from cache alone,
 * with no device and no network, must reproduce the same archive semantics
 * every time -- that is what makes "Update vault from cache" trustworthy.
 */
function seedScratchCache(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kindle-ssh-sync-idem-"));
	fs.cpSync(CACHE, dir, { recursive: true });
	return dir;
}

interface Run {
	books: RawBook[];
	groups: PresentationGroup[];
	notes: RawBook[];
}

function runOnce(cacheRoot: string, priorGroups: PresentationGroup[] = []): Run {
	const built = buildLibrary(cacheRoot);
	const grouped = groupForPresentation(built.library.books, priorGroups);
	return { books: built.library.books, groups: grouped.groups, notes: grouped.books };
}

test("three consecutive builds from cache alone are semantically identical", () => {
	const dir = seedScratchCache();
	try {
		const first = runOnce(dir);
		const second = runOnce(dir, first.groups);
		// The third run stands in for "delete the target and rebuild from cache":
		// nothing but the cache and the carried group state is available.
		const third = runOnce(dir, second.groups);

		for (const [label, run] of [
			["second", second],
			["third", third],
		] as const) {
			assert.equal(run.books.length, first.books.length, `${label}: source record count`);
			assert.equal(run.notes.length, first.notes.length, `${label}: note count`);
			assert.deepStrictEqual(run.groups, first.groups, `${label}: presentation groups`);
			assert.deepStrictEqual(
				run.notes.map((b) => b.uuid),
				first.notes.map((b) => b.uuid),
				`${label}: note identities`
			);
			assert.deepStrictEqual(
				JSON.parse(JSON.stringify(run.notes)),
				JSON.parse(JSON.stringify(first.notes)),
				`${label}: rendered note content`
			);
		}

		assert.equal(first.notes.length, 634);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("the rebuild includes the archive-only records, not just the on-device ones", () => {
	const dir = seedScratchCache();
	try {
		const run = runOnce(dir);
		const archiveOnly = run.books.filter((b) => !b.on_device);
		assert.equal(archiveOnly.length, 156);
		// They must survive into the notes, not merely into the source archive.
		const noteUuids = new Set(run.notes.map((b) => b.uuid));
		const survived = archiveOnly.filter((b) => noteUuids.has(b.uuid));
		assert.ok(survived.length > 0, "archive-only records vanished from the output");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("replaying a build adds no duplicate source record, group or note", () => {
	const dir = seedScratchCache();
	try {
		const first = runOnce(dir);
		const second = runOnce(dir, first.groups);

		const uuids = second.books.map((b) => b.uuid);
		assert.equal(new Set(uuids).size, uuids.length, "duplicate source record");

		const keys = second.groups.map((g) => g.key);
		assert.equal(new Set(keys).size, keys.length, "duplicate presentation group");

		const notes = second.notes.map((b) => b.uuid);
		assert.equal(new Set(notes).size, notes.length, "duplicate note");

		for (const g of second.groups) {
			assert.equal(
				new Set(g.sourceUuids).size,
				g.sourceUuids.length,
				`group ${g.key} lists a source twice`
			);
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("a build with no archive at all still produces the full library", () => {
	// Cold start: on a fresh install the archive is absent. Books
	// already deleted from the device are simply gone -- but everything the
	// device still has must come through.
	const dir = seedScratchCache();
	try {
		fs.rmSync(path.join(dir, "archive.json"));
		const built = buildLibrary(dir);

		assert.deepStrictEqual(built.warnings, [], "a missing archive is not a warning");
		assert.equal(built.library.books.filter((b) => b.on_device).length, 534);
		// The 154 synthetic records are regenerated from vocab.db and clippings,
		// so they survive a cold start; the 2 deleted books do not.
		assert.equal(built.library.books.length, 688);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("a malformed archive fails the build instead of silently starting empty", () => {
	const dir = seedScratchCache();
	try {
		fs.writeFileSync(path.join(dir, "archive.json"), "{ this is not json");
		// Only absence is a first run; rebuilding without the archive would drop
		// every archive-only record on the next publication.
		assert.throws(() => buildLibrary(dir), /Invalid archive/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("archive-only records come from carry-forward when an archive exists", () => {
	// With archive.json present -- the normal case -- all 156 arrive through the
	// archived-carry-forward branch, as copies of archived records. The synthetic
	// generators are the *cold-start* path that reconstructs 154 of them from
	// vocab.db and My Clippings.txt. The other 2 were deleted from the device and
	// have no trace left, so only the archive keeps them.
	const dir = seedScratchCache();
	try {
		const withArchive = buildLibrary(dir);
		fs.rmSync(path.join(dir, "archive.json"));
		const coldStart = buildLibrary(dir);

		assert.equal(withArchive.library.books.filter((b) => !b.on_device).length, 156);
		assert.equal(coldStart.library.books.filter((b) => !b.on_device).length, 154);

		// A cold start reconstructs everything except the deleted books.
		const cold = new Set(coldStart.library.books.map((b) => b.uuid));
		const onlyArchived = withArchive.library.books.filter((b) => !cold.has(b.uuid));
		assert.equal(coldStart.library.books.length, withArchive.library.books.length - 2);
		assert.deepStrictEqual(
			onlyArchived.map((b) => [b.on_device, b.uuid.startsWith("synthetic-")]),
			[[false, false], [false, false]]
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("group state round-trips through archive.json in a single read", () => {
	const dir = seedScratchCache();
	try {
		const first = buildLibrary(dir);
		const grouped = groupForPresentation(first.library.books, first.archiveGroups);
		fs.writeFileSync(
			path.join(dir, "archive.json"),
			JSON.stringify({ books: first.library.books, groups: grouped.groups })
		);

		const second = buildLibrary(dir);
		assert.deepStrictEqual(second.archiveGroups, grouped.groups);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
