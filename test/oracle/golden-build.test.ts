import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLibrary, UNTITLED } from "../../src/decode/build";
import { groupForPresentation } from "../../src/decode/archive";
import { CACHE, golden } from "./golden";

let built: ReturnType<typeof buildLibrary> | undefined;
function build() {
	built ??= buildLibrary(CACHE);
	return built;
}

test("the build produces the golden's 690 source records, keyed by uuid", () => {
	const mine = new Set(build().library.books.map((b) => b.uuid));
	const theirs = new Set(golden().books.map((b) => b.uuid));
	assert.equal(mine.size, 690);

	const missing = [...theirs].filter((u) => !mine.has(u));
	const extra = [...mine].filter((u) => !theirs.has(u));
	assert.deepStrictEqual({ missing, extra }, { missing: [], extra: [] });
});

test("every source record deep-equals its golden record", () => {
	const byUuid = new Map(build().library.books.map((b) => [b.uuid, b]));
	const expectedBooks = golden().books;
	const failures: string[] = [];

	for (const expected of expectedBooks) {
		const actual = byUuid.get(expected.uuid);
		if (!actual) continue; // covered by the previous test
		try {
			assert.deepStrictEqual(actual, expected);
		} catch (e) {
			const msg = (e as Error).message.split("\n").slice(0, 6).join("\n");
			failures.push(`${expected.uuid} "${expected.title}":\n${msg}`);
		}
	}

	assert.deepStrictEqual(
		failures.slice(0, 3),
		[],
		`${failures.length} of ${expectedBooks.length} source records diverged; ` +
			`if intended, review and run npm run fixtures:golden`
	);
});

test("record order, vocabulary and groups match the golden", () => {
	const { books, groups, clippings: _parserOracle, ...rest } = golden();
	const library = build().library;
	assert.deepStrictEqual(library.books.map((b) => b.uuid), books.map((b) => b.uuid));
	assert.deepStrictEqual({ vocabulary: library.vocabulary }, rest);
	assert.deepStrictEqual(groupForPresentation(library.books, build().archiveGroups).groups, groups);
});

test("the record split matches the measured fixture", () => {
	const books = build().library.books;

	assert.equal(books.filter((b) => b.on_device).length, 534, "on-device records");
	// Two books deleted from the device survive only through the archive.
	assert.equal(books.filter((b) => !b.on_device).length, 156, "archive-only records");
	assert.equal(books.filter((b) => b.uuid.startsWith("synthetic-")).length, 154);
});

test("the vocabulary word layer is carried, so word and stem survive", () => {
	// The WORDS table (word, stem, status, category) exists only in the
	// top-level vocabulary block; per-book lookup records do not carry it.
	const v = build().library.vocabulary as { stats: Record<string, number>; words: unknown[] };
	assert.equal(v.stats.total_words, 2096);
	assert.equal(v.words.length, 2096);
});

test("the build surfaces no warnings on a clean fixture", () => {
	assert.deepStrictEqual(build().warnings, []);
});

test("a row with no nominal title gets a meaningful placeholder", () => {
	// Fires on 0 of 534 rows here, so this pins intent rather than observed behaviour.
	assert.equal(
		build().library.books.filter((b) => b.title === UNTITLED).length,
		0,
		"fixture unexpectedly contains an untitled row; re-measure"
	);
});
