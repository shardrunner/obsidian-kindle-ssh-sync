import { test } from "node:test";
import assert from "node:assert/strict";
import { validateLibraryData } from "../../src/library";
import { golden } from "./golden";

test("library: the golden decode of the real library validates", () => {
	const library = golden();
	assert.doesNotThrow(() => validateLibraryData(library));
	assert.equal(library.books.length, 690);
	assert.ok(library.clippings?.clippings && library.clippings.clippings.length > 0);
});
