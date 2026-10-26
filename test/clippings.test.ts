import { test } from "node:test";

import assert from "node:assert/strict";

import * as fs from "node:fs";

import * as path from "node:path";

import {
	parseClippings,
	mergeClippingsBytes,
	mergeClippingsText,
	decodeUtf8Sig,
} from "../src/decode/clippings";

test("German, Spanish and French metadata lines are all recognised", () => {
	const text = [
		"Ein Buch (Autor, Ein)",
		"- Ihre Markierung bei Position 123-125 | Hinzugefügt am Montag, 3. März 2025",
		"",
		"Der markierte Text.",
		"==========",
		"Un Libro (Autor)",
		"- Su nota en la página 42 | Añadido el lunes, 3 de marzo de 2025",
		"",
		"Mi nota.",
		"==========",
		"Un Livre (Auteur)",
		"- Votre signet sur l'emplacement 900 | Ajouté le lundi 3 mars 2025",
		"==========",
	].join("\n");

	const r = parseClippings(text);
	assert.deepStrictEqual(
		r.clippings.map((c) => [c.type, c.page, c.location]),
		[
			["highlight", null, "123-125"],
			["note", 42, null],
			["bookmark", null, "900"],
		]
	);
	assert.deepStrictEqual(r.clippings.map((c) => c.author), ["Autor, Ein", "Autor", "Auteur"]);
	assert.equal(r.clippings[0].added_at, "Montag, 3. März 2025");
});

const enc = (s: string) => new TextEncoder().encode(s);

const block = (n: number) =>
	`Book ${n} (Author)\n- Your Highlight on location ${n} | Added on Monday\n\nText ${n}`;

test("a device-side prune can never shrink the cached clippings file", () => {
	const cached = enc([block(1), block(2), block(3), ""].join("\n==========\n"));
	// The device has pruned 1 and 2 and added 4 -- exactly the case that would
	// silently destroy data if the pull wrote the device's copy straight out.
	const device = enc([block(3), block(4), ""].join("\n==========\n"));

	const merged = decodeUtf8Sig(mergeClippingsBytes(cached, device));
	const r = parseClippings(merged);

	assert.deepStrictEqual(
		r.clippings.map((c) => c.title),
		["Book 1", "Book 2", "Book 3", "Book 4"]
	);
});

test("merging is idempotent, so a replayed pull adds no duplicates", () => {
	const cached = enc([block(1), block(2), ""].join("\n==========\n"));
	const once = mergeClippingsBytes(cached, cached);
	const twice = mergeClippingsBytes(once, cached);
	assert.deepStrictEqual(Array.from(twice), Array.from(once));
	assert.equal(parseClippings(decodeUtf8Sig(twice)).clippings.length, 2);
});

test("merging always emits a BOM and tolerates an empty side", () => {
	assert.equal(decodeUtf8Sig(mergeClippingsBytes(null, enc(block(1)))).startsWith("﻿"), false);
	assert.equal(mergeClippingsBytes(null, enc(block(1)))[0], 0xef);
	assert.deepStrictEqual(
		decodeUtf8Sig(mergeClippingsBytes(enc(block(1)), null)),
		block(1)
	);
	assert.equal(mergeClippingsBytes(null, null).length, 3); // BOM only
});

test("a BOM left mid-file by an earlier merge does not leak into titles", () => {
	const text = [
		"First (Author, A)",
		"- Your Highlight at location 1-2 | Added on Monday, 3 March 2025",
		"",
		"One.",
		"==========",
		"﻿Second (Author, B)",
		"- Your Highlight at location 3-4 | Added on Monday, 3 March 2025",
		"",
		"Two.",
		"==========",
	].join("\r\n");
	const parsed = parseClippings(text);
	assert.deepEqual(parsed.clippings.map((c) => c.title), ["First", "Second"]);
	assert.equal(parsed.clippings[1].author, "Author, B");
});

test("merge treats a BOM-prefixed copy of a block as the same block", () => {
	const block = "Book (Author)\n- Your Highlight at location 1 | Added on Monday, 3 March 2025\n\nText.\n";
	const merged = mergeClippingsText(`${block}==========\n`, `﻿${block}==========\n`);
	assert.equal(merged, `${block}==========\n`);
});
