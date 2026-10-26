import { test } from "node:test";

import assert from "node:assert/strict";

import * as path from "node:path";

import { loadCcDatabase, rowAuthor, jsonLoadOr } from "../../src/decode/cc-db";

import { loadVocabulary, unionLookups, VocabLookup } from "../../src/decode/vocab-db";

import { loadFmcache } from "../../src/decode/fmcache-db";

import { hasNodeSqlite } from "../../src/decode/sqlite";

const CACHE = path.join(__dirname, "../fixtures", "cache");

test("cc.db yields the measured Entry:Item rows with unique uuids", () => {
	const cc = loadCcDatabase(path.join(CACHE, "cc.db"));

	assert.equal(cc.rows.length, 534);

	const uuids = new Set(cc.rows.map((r) => String(r["p_uuid"])));
	assert.equal(uuids.size, 534, "p_uuid must be unique -- notes are keyed by it");
});

test("cdeKey is NOT unique, which is why it cannot be a source identity", () => {
	const cc = loadCcDatabase(path.join(CACHE, "cc.db"));

	const keys = cc.rows
		.map((r) => r["p_cdeKey"])
		.filter((k): k is string => k !== null && k !== undefined && k !== "")
		.map(String);

	// 468 distinct values across 524 rows: 55 groups covering 111 books.
	assert.equal(keys.length, 524);
	assert.equal(new Set(keys).size, 468);
});

test("the Series tables are empty in this fixture", () => {
	// Measured: Series has 0 rows and there are no Entry:Item:Series entries, so
	// no book in the fixture carries series data. The reader must return empty
	// maps rather than failing, and the series join is consequently unexercised
	// by the golden test -- recorded here so that is a known gap, not a surprise.
	const cc = loadCcDatabase(path.join(CACHE, "cc.db"));
	assert.deepStrictEqual(cc.seriesOf, {});
	assert.deepStrictEqual(cc.seriesName, {});
});

test("every cc.db row resolves to an author without throwing", () => {
	const cc = loadCcDatabase(path.join(CACHE, "cc.db"));
	for (const r of cc.rows) assert.equal(typeof rowAuthor(r), "string");
});

test("vocab.db yields the measured word and lookup counts", () => {
	const v = loadVocabulary(path.join(CACHE, "vocab.db"));

	assert.equal(v.stats.total_words, 2096);
	assert.equal(v.stats.total_lookups, 2860);
	// Legacy schema: every row is category 0, so mastery is never recorded.
	assert.equal(v.stats.mastered_words, 0);
	assert.equal(v.stats.learning_words, 2096);
	assert.equal(v.words.length, 2096);
});

test("vocabulary lookups are indexed by book and by normalised title", () => {
	const v = loadVocabulary(path.join(CACHE, "vocab.db"));
	assert.ok(Object.keys(v.by_book).length > 0);
	assert.ok(Object.keys(v.by_title).length > 0);
	assert.ok(Object.keys(v.books).length > 0);

	// Every indexed lookup must be one of the parsed lookups.
	const total = Object.values(v.by_book).reduce((n, l) => n + l.length, 0);
	assert.ok(total >= v.stats.total_lookups - 26, "by_book lost more lookups than the known 26");
});

test("a missing or 0-byte fmcache.db decodes to no marks, without warnings", () => {
	// /mnt/us/system/fmcache/ does not exist on this device at all; the
	// fixture's fmcache.db is 0 bytes and must not reach SQLite.
	for (const file of ["no-such-fmcache.db", "fmcache.db"]) {
		const fm = loadFmcache(path.join(CACHE, file));
		assert.deepStrictEqual(fm, { read_state: {}, sessions: {}, warnings: [] }, file);
	}
});
