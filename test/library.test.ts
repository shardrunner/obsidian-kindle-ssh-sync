import { test } from "node:test";

import assert from "node:assert/strict";

import * as fs from "node:fs";

import * as path from "node:path";

import { validateLibraryData } from "../src/library";

test("library: accepts a valid library", () => {
	const data = {
		books: [
			{ uuid: "test-uuid-1", title: "Test Book 1" },
			{ uuid: "test-uuid-2", title: "Test Book 2", author: "Author Name" },
		],
	};
	assert.doesNotThrow(() => validateLibraryData(data));
});

test("library: validation preserves raw fallback provenance without mutation", () => {
	const data = { books: [{ uuid: 'u', title: '  Raw Title  ', azw3f: { fpr: ['raw', 123], 'unknown.store': [1, null] }, extra: { raw: true } }] };
	const before = JSON.stringify(data);
	validateLibraryData(data);
	assert.equal(JSON.stringify(data), before);
});

test("library: rejects invalid inputs", () => {
	assert.throws(() => validateLibraryData({}), /books.*array/);
	assert.throws(() => validateLibraryData({ books: [{ title: "No uuid" }] }), /uuid/);
});
