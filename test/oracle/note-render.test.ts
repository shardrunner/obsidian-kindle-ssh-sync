import * as path from "node:path";
import { test } from "node:test";

import assert from "node:assert/strict";

import * as fs from "node:fs";
import { golden } from "./golden";


import {
	parseClippingDate,
	formatClipping,
	renderHighlights,
	renderBookNote,
	extractHighlightBlocks,
	renderFrontmatterYaml,
} from "../../src/note-render";

import { buildBookFrontmatter } from "../../src/book-note";

import { BookFrontmatter, RawClipping } from "../../src/types";

test("render full note: Wind and Truth fixture (47KB)", () => {
	const library = golden();
	const windAndTruth = library.books.find((b) => b.title === "Wind and Truth");
	assert.ok(windAndTruth);
	if (!windAndTruth) return;

	const frontmatter = buildBookFrontmatter(windAndTruth, {
		targetFolder: "Unterhaltung/Media/Lesen/Kindle-Sync",
		copyCovers: true,
	});

	const rendered = renderBookNote(frontmatter, { clippings: windAndTruth.clippings || [], baseEmbed: "Kindle.base#Detail" }).content;
	assert.ok(rendered.startsWith("---\n"));
	assert.ok(rendered.includes('kindle_uuid: "4fc0dd32-fe3e-4708-bee0-3cb8dd2800f7"'));
	assert.ok(rendered.includes("kindle_amazon_archived: false"));
	assert.ok(rendered.includes("kindle_on_device: true"));
	assert.ok(!rendered.includes("kindle_archived"));
	assert.ok(!rendered.includes("\namazon_archived:"));
	assert.ok(rendered.includes("![[Kindle.base#Detail]]"));
	assert.ok(rendered.includes("## Highlights"));
	assert.ok(rendered.length > 40000); // 47KB fixture
});
