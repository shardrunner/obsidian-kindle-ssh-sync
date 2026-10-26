import { test } from "node:test";

import assert from "node:assert/strict";

import * as fs from "node:fs";

import * as path from "node:path";

import {
	canonicalPrimaryLanguage,
	groupForPresentation,
	groupKeyFor,
	unionAnnotations,
	unionClippings,
	PresentationGroup,
	presentationKey,
} from "../src/decode/archive";

import { RawBook } from "../src/types";

function book(over: Partial<RawBook>): RawBook {
	return {
		uuid: "u",
		title: "T",
		author: "A",
		cdeKey: "B001",
		language: "en",
		location: null,
		on_device: false,
		stats: {},
		annotations: [],
		clippings: [],
		vocabulary: [],
		...over,
	} as RawBook;
}

test("canonicalPrimaryLanguage coalesces case and region, rejecting the malformed", () => {
	assert.equal(canonicalPrimaryLanguage("de"), "de");
	assert.equal(canonicalPrimaryLanguage("DE"), "de");
	assert.equal(canonicalPrimaryLanguage("de-de"), "de");
	assert.equal(canonicalPrimaryLanguage("de_DE"), "de");
	assert.equal(canonicalPrimaryLanguage(" En-GB "), "en");

	// Not mergeable at all.
	assert.equal(canonicalPrimaryLanguage(null), null);
	assert.equal(canonicalPrimaryLanguage(""), null);
	assert.equal(canonicalPrimaryLanguage("   "), null);
	assert.equal(canonicalPrimaryLanguage("1"), null);
	assert.equal(canonicalPrimaryLanguage("-de"), null);
});

test("same cdeKey plus de/DE/de-de merges into one note", () => {
	const r = groupForPresentation([
		book({ uuid: "a", cdeKey: "B1", language: "de", location: "/mnt/us/documents/a.azw3" }),
		book({ uuid: "b", cdeKey: "B1", language: "DE" }),
		book({ uuid: "c", cdeKey: "B1", language: "de-de" }),
	]);

	assert.equal(r.books.length, 1);
	assert.deepStrictEqual(r.groups[0].sourceUuids, ["a", "b", "c"]);
	assert.equal(r.groups[0].primaryUuid, "a");
});

test("same cdeKey but a different primary language never merges", () => {
	const r = groupForPresentation([
		book({ uuid: "a", cdeKey: "B1", language: "de" }),
		book({ uuid: "b", cdeKey: "B1", language: "en" }),
	]);
	assert.equal(r.books.length, 2);
});

test("a missing language or a missing cdeKey never merges", () => {
	const noLang = groupForPresentation([
		book({ uuid: "a", cdeKey: "B1", language: null }),
		book({ uuid: "b", cdeKey: "B1", language: null }),
	]);
	assert.equal(noLang.books.length, 2, "records with no language must stand alone");
	assert.deepStrictEqual(noLang.groups, [], "unmergeable records form no group");

	const noCde = groupForPresentation([
		book({ uuid: "a", cdeKey: null, language: "de" }),
		book({ uuid: "b", cdeKey: null, language: "de" }),
	]);
	assert.equal(noCde.books.length, 2);
	assert.equal(groupKeyFor(book({ cdeKey: null })), null);
});

test("the group primary stays stable when a display-primary source disappears", () => {
	const existing: PresentationGroup[] = [
		{ key: presentationKey("B1", "de"), cdeKey: "B1", language: "de", primaryUuid: "b", sourceUuids: ["a", "b"] },
	];
	// "a" would win a fresh selection (lowest uuid), but the note already exists
	// under "b" and reconciliation identity must not be reselected.
	const r = groupForPresentation(
		[
			book({ uuid: "a", cdeKey: "B1", language: "de", location: "/mnt/us/documents/a.azw3" }),
			book({ uuid: "b", cdeKey: "B1", language: "de" }),
		],
		existing
	);
	assert.equal(r.groups[0].primaryUuid, "b");
	assert.equal(r.books[0].uuid, "b", "the note keeps its kindle_uuid");
	// Display selection is still separate: the resident row supplies the content.
	assert.equal(r.books[0].location, "/mnt/us/documents/a.azw3");
});

test("the hardware-resident row supplies the display fields", () => {
	const r = groupForPresentation([
		book({ uuid: "a", cdeKey: "B1", language: "en", title: "The Final Empire", author: "Sanderson, Brandon" }),
		book({
			uuid: "b",
			cdeKey: "B1",
			language: "en",
			title: "Mistborn: 1",
			author: "Sanderson, Brandon",
			location: "/mnt/us/documents/The Final Empire.kfx",
			on_device: true,
			stats: { minutes: 1938 },
		}),
	]);

	assert.equal(r.books.length, 1);
	assert.equal(r.books[0].title, "Mistborn: 1");
	assert.equal(r.books[0].on_device, true, "on_device is true if ANY member is");
});

test("title, author and language mismatches are surfaced, not silenced", () => {
	const r = groupForPresentation([
		book({ uuid: "a", cdeKey: "B0772S3CSF", language: "de", title: "Instabil", author: "Feuerbach, Sam" }),
		book({ uuid: "b", cdeKey: "B0772S3CSF", language: "de-DE", title: "Instabil", author: "Thariot" }),
	]);

	assert.equal(r.books.length, 1);
	const fields = r.conflicts.map((c) => c.field).sort();
	assert.deepStrictEqual(fields, ["author", "language"]);
	assert.deepStrictEqual(r.conflicts.find((c) => c.field === "author")?.values, [
		"Feuerbach, Sam",
		"Thariot",
	]);
});

test("grouping unions vocabulary and annotations with the same rules as the archive", () => {
	// Members of one group share a cdeKey, so they resolve the same vocab.db
	// lookups; repeated records without identity must not be counted twice.
	const lookup = { word_key: "de:haus", book_key: "B1", usage: "Das Haus", timestamp: 1 };
	const anonymous = { text: "firmware extension without identity" };
	const r = groupForPresentation([
		book({ uuid: "a", cdeKey: "B1", language: "de", vocabulary: [{ id: "1" }, lookup] as never, annotations: [anonymous] as never }),
		book({ uuid: "b", cdeKey: "B1", language: "de", vocabulary: [{ id: "1" }, { id: "2" }, { ...lookup }] as never, annotations: [{ ...anonymous }] as never }),
	]);

	assert.equal(r.books.length, 1);
	assert.deepStrictEqual(r.books[0].vocabulary, [{ id: "1" }, lookup, { id: "2" }]);
	assert.deepStrictEqual(r.books[0].annotations, [anonymous]);
});

test("clippings union by the full parsed tuple, since they carry no id", () => {
	const c = (over: Record<string, unknown>) =>
		({ title: "T", author: "A", type: "highlight", page: 1, location: "5", added_at: "x", text: "t", ...over } as never);
	const merged = unionClippings([[c({}), c({ text: "u" })], [c({}), c({ page: 2 })]]);
	assert.equal(merged.length, 3, "only the byte-identical tuple is a duplicate");
});

test("annotations union by span identity, retaining the newest modification", () => {
	const base = { type: "highlight", startPosition: "10", endPosition: "20", creationTime: "2025-01-01T00:00:00" };
	const merged = unionAnnotations([
		[{ ...base, lastModificationTime: "2025-01-01T00:00:00", note: "old" }],
		[{ ...base, lastModificationTime: "2025-06-01T00:00:00", note: "new" }],
	]) as Record<string, unknown>[];

	assert.equal(merged.length, 1, "the same span must not duplicate");
	assert.equal(merged[0].note, "new", "a changed note replaces its older self");
});

test("a group that shrinks to one record re-keys consistently and converges", () => {
	// The stable primary "b" is the record that disappears -- e.g. the cloud
	// entry vanished from cc.db and no archive record survives for it.
	const existing: PresentationGroup[] = [
		{ key: presentationKey("B1", "de"), cdeKey: "B1", language: "de", primaryUuid: "b", sourceUuids: ["a", "b"] },
	];
	const r = groupForPresentation([book({ uuid: "a", cdeKey: "B1", language: "de" })], existing);

	assert.equal(r.books.length, 1);
	// The note and the group record must agree; a group pointing at a source
	// that no longer exists can never self-heal, because the next run reads it
	// back as the stable primary again.
	assert.equal(r.groups[0].primaryUuid, r.books[0].uuid, "group primary and note uuid disagree");
	assert.deepStrictEqual(r.groups[0].sourceUuids, ["a"]);
	assert.ok(
		r.groups[0].sourceUuids.includes(r.groups[0].primaryUuid),
		"primaryUuid names a record that is not in the group"
	);

	// And it must be stable from then on.
	const again = groupForPresentation([book({ uuid: "a", cdeKey: "B1", language: "de" })], r.groups);
	assert.deepStrictEqual(again.groups, r.groups);
});
