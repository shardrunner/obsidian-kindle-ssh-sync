import { test } from "node:test";

import assert from "node:assert/strict";

import * as path from "node:path";

import { loadCcDatabase, rowAuthor, jsonLoadOr } from "../src/decode/cc-db";

import { loadVocabulary, unionLookups, VocabLookup } from "../src/decode/vocab-db";

import { loadFmcache } from "../src/decode/fmcache-db";

import { hasNodeSqlite } from "../src/decode/sqlite";

test("this runtime provides node:sqlite", () => {
	// The plugin checks this capability at load time, not via Obsidian's version.
	assert.equal(hasNodeSqlite(), true);
});

test("rowAuthor prefers the structured credits blob over the flattened column", () => {
	assert.equal(
		rowAuthor({ j_credits: JSON.stringify([{ name: { display: "Sanderson, Brandon" } }]) }),
		"Sanderson, Brandon"
	);
	// display missing -> collation
	assert.equal(
		rowAuthor({ j_credits: JSON.stringify([{ name: { collation: "Hobb, Robin" } }]) }),
		"Hobb, Robin"
	);
	// a plain string name is used as-is
	assert.equal(rowAuthor({ j_credits: JSON.stringify([{ name: "Thariot" }]) }), "Thariot");
	// malformed JSON falls through to the column, never throws
	assert.equal(rowAuthor({ j_credits: "{not json", p_credits_0_name_collation: "Fallback" }), "Fallback");
	assert.equal(rowAuthor({}), "");
});

test("jsonLoadOr returns the fallback on anything unparseable", () => {
	assert.deepStrictEqual(jsonLoadOr("[1,2]", []), [1, 2]);
	assert.deepStrictEqual(jsonLoadOr("nope", []), []);
	assert.deepStrictEqual(jsonLoadOr(null, []), []);
	assert.deepStrictEqual(jsonLoadOr(42, []), []);
});

test("a missing vocab.db yields an empty structure rather than throwing", () => {
	const v = loadVocabulary("/nonexistent-synthetic-kindle-test/absent.db");
	assert.deepStrictEqual(v.stats, {
		total_words: 0,
		total_lookups: 0,
		mastered_words: 0,
		learning_words: 0,
	});
});

test("unionLookups merges by id and retains id-less entries", () => {
	const a: VocabLookup[] = [
		{ id: "1", word_key: "w1", book_key: "b1", book_asin: null, book_title: null, dict_key: null, pos: null, usage: "u1", timestamp: 100 },
		{ id: "2", word_key: "w2", book_key: "b1", book_asin: null, book_title: null, dict_key: null, pos: null, usage: "u2", timestamp: 200 },
	];
	const b: VocabLookup[] = [
		{ id: "2", word_key: "w2", book_key: "b1", book_asin: null, book_title: null, dict_key: null, pos: null, usage: "u2-updated", timestamp: 250 },
		{ id: "3", word_key: "w3", book_key: "b1", book_asin: null, book_title: null, dict_key: null, pos: null, usage: "u3", timestamp: 300 },
		{ id: null, word_key: null, book_key: "b1", book_asin: null, book_title: null, dict_key: null, pos: null, usage: "anon1", timestamp: null },
		{ id: null, word_key: null, book_key: "b1", book_asin: null, book_title: null, dict_key: null, pos: null, usage: "anon2", timestamp: null },
	];

	const merged = unionLookups(a, b);
	assert.equal(merged.length, 5);
	assert.deepStrictEqual(
		merged.map((m) => m.id),
		["1", "2", "3", null, null]
	);
	assert.equal(merged[1].usage, "u2-updated", "incoming edits replace archived values");
	assert.equal(merged[1].timestamp, 250);
	let repeated = merged;
	for (let i = 0; i < 3; i++) repeated = unionLookups(repeated, b.map(item => ({ ...item })));
	assert.deepEqual(repeated, merged, "id-less repeated snapshots do not grow");
});
