import { test } from "node:test";

import assert from "node:assert/strict";

import * as fs from "node:fs";


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
} from "../src/book-note";

test("author normalisation: swaps single comma, preserves multiple/and/&, handles empty", () => {
	assert.equal(normalizeAuthor("Sanderson, Brandon"), "Brandon Sanderson");
	assert.equal(normalizeAuthor("Walker, Matthew"), "Matthew Walker");
	assert.equal(normalizeAuthor("Addison, Katherine"), "Katherine Addison");
	assert.equal(normalizeAuthor(""), "Unknown");
	assert.equal(normalizeAuthor(null), "Unknown");
	assert.equal(normalizeAuthor(undefined), "Unknown");
	assert.equal(
		normalizeAuthor("Douglas Adams and Eoin Colfer"),
		"Douglas Adams and Eoin Colfer"
	);
	assert.equal(normalizeAuthor("Smith, John & Doe, Jane"), "Smith, John & Doe, Jane");
	assert.equal(normalizeAuthor("SingleName"), "SingleName");
});

test("filename sanitisation: replaces forbidden characters and collapses spaces", () => {
	assert.equal(
		sanitizeFilename("Why We Sleep: Unlocking the Power of Sleep/Dreams?"),
		"Why We Sleep Unlocking the Power of Sleep Dreams"
	);
	assert.equal(
		sanitizeFilename("Book *[Title]* <Version> | Part #1 ^test"),
		"Book Title Version Part 1 test"
	);
});

test("word boundary truncation: truncates cleanly at 120 characters", () => {
	const longText =
		"This is a very long book title that exceeds one hundred and twenty characters easily and should be truncated cleanly on a word boundary without breaking words";
	const truncated = truncateOnWordBoundary(longText, 120);
	assert.ok(truncated.length <= 120);
	assert.ok(!truncated.endsWith(" "));
	assert.ok(!truncated.endsWith("-"));
});

test("format and origin decoding", () => {
	assert.equal(decodeMimeType("application/x-mobipocket-ebook"), "MOBI");
	assert.equal(decodeMimeType("application/x-kfx-ebook"), "KFX");
	assert.equal(decodeMimeType("application/x-mobi8-ebook"), "KF8");
	assert.equal(decodeMimeType("application/x-kindle-acx"), "ACX");

	assert.equal(decodeOriginType(0), "Purchased");
	assert.equal(decodeOriginType(22), "Kindle Unlimited");
	assert.equal(decodeOriginType(10), "Manual");
	assert.equal(decodeOriginType(null), "Sideloaded");
});

test("progress and pages resolution: Schuldig and Red Sister cases", () => {
	// Schuldig APNX resolution
	const schuldigBook: any = {
		uuid: "schuldig-uuid",
		title: "Schuldig",
		read_status: "unread",
		azw3f: { lpr: { position: "1341728" } },
		azw3r: {
			"apnx.key": {
				// 589 elements -> 588 pages
				oPNToPosition: [0, 0, ...Array(587).fill(1300000), 1400000],
			},
		},
	};
	const resolved = resolveProgressAndPages(schuldigBook);
	assert.ok(resolved.progress !== undefined);
	assert.ok(resolved.page !== undefined);
	assert.ok(resolved.totalPages !== undefined);

	// Red Sister: read_status=read, percentFinished=14.04, percent_read=128.4
	const redSister: any = {
		uuid: "red-sister-uuid",
		title: "Red Sister",
		percentFinished: 14.043895,
		read_status: "read",
		stats: { percent_read: 128.4, hours: 20.5 },
	};
	const rsResolved = resolveProgressAndPages(redSister);
	assert.equal(rsResolved.progress, 14.0);
	assert.equal(rsResolved.percentFinished, 14.0);
	assert.equal(rsResolved.textRead, 128.4);
	assert.equal(isFinished(redSister, rsResolved.progress), true);
});

test("clipping count ignores bookmarks, empty text and repeated clippings", () => {
	const clip = { title: "T", type: "highlight", location: "10", text: "Same passage", added_at: "Samstag, 7. Dezember 2024 16:31:47" };
	const book: any = { uuid: "u", title: "T", author: "A", clippings: [
		clip, { ...clip, added_at: "Samstag, 7. Dezember 2024 16:31:50" }, { ...clip, location: "11" },
		{ ...clip, type: "bookmark" }, { ...clip, text: " " },
	] };
	assert.equal(buildBookFrontmatter(book, { targetFolder: "K", copyCovers: false }).kindle_clippings, 2);
});

test("frontmatter builder maps kindle_amazon_archived and kindle_on_device correctly", () => {
	const onDeviceCloudBook: any = {
		uuid: "uuid-cloud-1",
		title: "Cloud Book",
		author: "Author",
		isArchived: 1,
		on_device: true,
	};
	const fmCloud = buildBookFrontmatter(onDeviceCloudBook, {
		targetFolder: "Kindle-Sync",
		copyCovers: false,
	});
	assert.equal(fmCloud.kindle_amazon_archived, true);
	assert.equal(fmCloud.kindle_on_device, true);
	assert.equal((fmCloud as any).kindle_archived, undefined);
	assert.equal((fmCloud as any).amazon_archived, undefined);

	const onDeviceLocalBook: any = {
		uuid: "uuid-local-1",
		title: "Local Book",
		author: "Author",
		isArchived: 0,
		on_device: true,
	};
	const fmLocal = buildBookFrontmatter(onDeviceLocalBook, {
		targetFolder: "Kindle-Sync",
		copyCovers: false,
	});
	assert.equal(fmLocal.kindle_amazon_archived, false);
	assert.equal(fmLocal.kindle_on_device, true);
	assert.equal((fmLocal as any).kindle_archived, undefined);
	assert.equal((fmLocal as any).amazon_archived, undefined);

	const syntheticBook: any = {
		uuid: "uuid-synth-1",
		title: "Synthetic Book",
		author: "Author",
		isArchived: null,
		on_device: false,
	};
	const fmSynth = buildBookFrontmatter(syntheticBook, {
		targetFolder: "Kindle-Sync",
		copyCovers: false,
	});
	assert.equal(fmSynth.kindle_amazon_archived, false);
	assert.equal(fmSynth.kindle_on_device, false);
	assert.equal((fmSynth as any).kindle_archived, undefined);
	assert.equal((fmSynth as any).amazon_archived, undefined);
});

test("read status mapping: preserves incoming read_status directly", () => {
	const readingBook: any = {
		uuid: "uuid-reading-1",
		title: "Reading Book",
		read_status: "reading",
		percentFinished: 45.0,
		on_device: false,
	};
	const fm1 = buildBookFrontmatter(readingBook, {
		targetFolder: "Kindle-Sync",
		copyCovers: false,
	});
	assert.equal(fm1.kindle_read_status, "reading");
	assert.equal(fm1.kindle_on_device, false);

	const readBook: any = {
		uuid: "uuid-read-1",
		title: "Read Book",
		read_status: "read",
		on_device: false,
	};
	const fm2 = buildBookFrontmatter(readBook, {
		targetFolder: "Kindle-Sync",
		copyCovers: false,
	});
	assert.equal(fm2.kindle_read_status, "read");

	const unreadBook: any = {
		uuid: "uuid-unread-1",
		title: "Unread Book",
		read_status: "unread",
		on_device: false,
	};
	const fm3 = buildBookFrontmatter(unreadBook, {
		targetFolder: "Kindle-Sync",
		copyCovers: false,
	});
	assert.equal(fm3.kindle_read_status, "unread");
});
