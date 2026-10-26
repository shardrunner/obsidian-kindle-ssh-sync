import * as path from "node:path";
import { test } from "node:test";

import assert from "node:assert/strict";

import * as fs from "node:fs";
import { golden } from "./golden";


import {
	normalizeAuthor,
	sanitizeFilename,
	truncateOnWordBoundary,
	decodeMimeType,
	decodeOriginType,
	resolveProgressAndPages,
	isFinished,
	isActiveBook,
	generateFilenames,
	buildBookFrontmatter,
} from "../../src/book-note";

test("real library measurements: active/inactive, on_device, and collision counts", () => {
	const library = golden();
	assert.equal(library.books.length, 690);

	const onDeviceBooks = library.books.filter(
		(b) => b.on_device !== false && (b as any).on_device !== 0
	);
	const archivedBooks = library.books.filter(
		(b) => b.on_device === false || (b as any).on_device === 0
	);

	assert.equal(onDeviceBooks.length, 534);
	assert.equal(archivedBooks.length, 156);

	const onDeviceActive = onDeviceBooks.filter(isActiveBook);
	const onDeviceInactive = onDeviceBooks.filter((b) => !isActiveBook(b));

	assert.equal(onDeviceActive.length, 131);
	assert.equal(onDeviceInactive.length, 403);

	const filenames = generateFilenames(library.books);
	assert.equal(filenames.size, 690);
	// Check that all filenames are unique across all 690 books
	const uniqueNames = new Set(filenames.values());
	assert.equal(uniqueNames.size, 690);
});
