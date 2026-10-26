import { test } from "node:test";

import assert from "node:assert/strict";

import * as fs from "node:fs";

import * as path from "node:path";

import {
	parseClippings,
	mergeClippingsBytes,
	mergeClippingsText,
	decodeUtf8Sig,
} from "../../src/decode/clippings";

import { golden } from "./golden";

const FIXTURES = path.join(__dirname, "../fixtures");

const CLIPPINGS = path.join(FIXTURES, "cache", "documents", "My Clippings.txt");

const expected = golden().clippings!;

function parseFixture() {
	return parseClippings(decodeUtf8Sig(new Uint8Array(fs.readFileSync(CLIPPINGS))));
}

test("the parser reproduces the golden clipping records exactly", () => {
	const parsed = parseFixture();
	assert.equal(parsed.clippings.length, 2987, "clipping count drifted; re-measure the fixture");
	assert.deepStrictEqual(parsed.clippings, expected.clippings);
});

const enc = (s: string) => new TextEncoder().encode(s);

const block = (n: number) =>
	`Book ${n} (Author)\n- Your Highlight on location ${n} | Added on Monday\n\nText ${n}`;

test("merging the real cached file with itself is a no-op", () => {
	const bytes = new Uint8Array(fs.readFileSync(CLIPPINGS));
	const text = decodeUtf8Sig(bytes);
	assert.equal(mergeClippingsText(text, text), text);
});
