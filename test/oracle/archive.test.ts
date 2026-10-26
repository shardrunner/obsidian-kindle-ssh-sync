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
} from "../../src/decode/archive";

import { RawBook } from "../../src/types";
import { golden } from "./golden";

const oracleBooks: RawBook[] = golden().books;

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

function expectedGroupsIndependently(): Map<string, string[]> {
	const buckets = new Map<string, string[]>();
	for (const b of oracleBooks) {
		const cde = b.cdeKey ? String(b.cdeKey).trim() : "";
		const raw = b.language ? String(b.language).trim() : "";
		const lang = raw ? raw.split(/[-_]/)[0].toLowerCase() : "";
		if (!cde || !/^[a-z]{2,8}$/.test(lang)) continue;
		const key = presentationKey(cde, lang);
		const list = buckets.get(key);
		if (list) list.push(b.uuid);
		else buckets.set(key, [b.uuid]);
	}
	// Only real collisions matter.
	return new Map([...buckets].filter(([, v]) => v.length > 1));
}

test("the fixture has 55 collision groups covering 111 source records", () => {
	const groups = expectedGroupsIndependently();
	assert.equal(groups.size, 55);
	assert.equal([...groups.values()].reduce((n, v) => n + v.length, 0), 111);

	const shapes: Record<number, number> = {};
	for (const v of groups.values()) shapes[v.length] = (shapes[v.length] ?? 0) + 1;
	assert.deepStrictEqual(shapes, { 2: 54, 3: 1 }, "54 pairs and one triple");
});

test("grouping the fixture yields exactly 634 notes", () => {
	const r = groupForPresentation(oracleBooks);
	// 690 source records - 56 rows removed by 55 groups merging.
	assert.equal(r.books.length, 634);
	assert.equal(oracleBooks.length - r.books.length, 56);
});

test("each produced group matches the independently derived membership", () => {
	const expected = expectedGroupsIndependently();
	const produced = new Map(
		groupForPresentation(oracleBooks)
			.groups.filter((g) => g.sourceUuids.length > 1)
			.map((g) => [g.key, [...g.sourceUuids].sort()])
	);

	assert.equal(produced.size, expected.size);
	for (const [key, uuids] of expected) {
		assert.deepStrictEqual(produced.get(key), [...uuids].sort(), `group ${key} differs`);
	}
});

test("every note's uuid is unique and drawn from its group's source records", () => {
	const r = groupForPresentation(oracleBooks);
	const uuids = r.books.map((b) => b.uuid);
	assert.equal(new Set(uuids).size, uuids.length, "two notes would collide on kindle_uuid");

	const byKey = new Map(r.groups.map((g) => [g.primaryUuid, g]));
	for (const b of r.books) {
		const g = byKey.get(b.uuid);
		if (g) assert.ok(g.sourceUuids.includes(b.uuid));
	}
});

test("grouping is idempotent when replayed with its own group state", () => {
	const first = groupForPresentation(oracleBooks);
	const second = groupForPresentation(oracleBooks, first.groups);

	assert.deepStrictEqual(
		second.books.map((b) => b.uuid),
		first.books.map((b) => b.uuid)
	);
	assert.deepStrictEqual(second.groups, first.groups);
});

test("no merged note loses a clipping, an annotation or a lookup", () => {
	const r = groupForPresentation(oracleBooks);
	const bySource = new Map(oracleBooks.map((b) => [b.uuid, b]));

	for (const g of r.groups) {
		if (g.sourceUuids.length < 2) continue;
		const note = r.books.find((b) => b.uuid === g.primaryUuid);
		assert.ok(note, `no note for group ${g.key}`);

		for (const key of ["clippings", "annotations", "vocabulary"] as const) {
			const maxMember = Math.max(
				...g.sourceUuids.map((u) => (bySource.get(u)?.[key]?.length ?? 0))
			);
			assert.ok(
				(note![key]?.length ?? 0) >= maxMember,
				`${g.key} lost ${key}: note has ${note![key]?.length ?? 0}, a member had ${maxMember}`
			);
		}
	}
});
