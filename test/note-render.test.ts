import { test } from "node:test";

import assert from "node:assert/strict";

import * as fs from "node:fs";


import {
	parseClippingDate,
	formatClipping,
	renderHighlights,
	renderBookNote,
	extractHighlightBlocks,
	renderFrontmatterYaml,
} from "../src/note-render";

import { buildBookFrontmatter } from "../src/book-note";

import { BookFrontmatter, RawClipping } from "../src/types";

test("dedup by type, position and text; escaped multiline blocks converge, including empty notes", () => {
 const base: RawClipping = { title: "T", type: "highlight", location: "1-2", page: "3", added_at: "2024-01-01", text: "Same\n\ntext" };
 const clips = [base, { ...base, text: "Same text" }, { ...base, type: "note" }, { ...base, location: "4" }, { ...base, page: "5" }, { ...base, added_at: "2024-01-02" }, { ...base, type: "note", text: "" }];
 const first = renderHighlights(clips);
 // A later timestamp alone does not make a distinct highlight.
 assert.equal(extractHighlightBlocks(`## Highlights\n\n${first.text}`).size, 5);
 for (const incoming of [clips, []]) {
  const second = renderHighlights(incoming, `## Highlights\n\n${first.text}`);
  assert.equal(second.text, first.text);
  assert.equal(renderHighlights(incoming, `## Highlights\n\n${second.text}`).text, first.text);
 }
});

test("imported markup is literal while retained Markdown and base embeds stay authored", () => {
 const payload = '![image](https://remote.test/x) ![[embed]] <img src="https://remote.test/x"> [link](https://remote.test) www.remote.test &lt;img&gt; `code`';
 for (const type of ["highlight", "note"]) {
  const clip = { title: payload, author: payload, type, location: payload, page: payload, added_at: payload, text: payload + '\n\n## injected\n**Note:** fake' };
  const first = renderHighlights([clip]);
  assert.doesNotMatch(first.text, /!\[|<img|https:|www\.|\n## injected/);
  assert.equal(renderHighlights([clip], `## Highlights\n\n${first.text}`).text, first.text);
  assert.equal(renderHighlights([], `## Highlights\n\n${first.text}`).text, first.text);
 }
 const authored = '> **user** [link](https://example.test)\n*loc. 9*';
 assert.equal(renderHighlights([], `## Highlights\n\n${authored}`).text, authored);
 assert.ok(renderBookNote({} as BookFrontmatter, { baseEmbed: 'My.base#Detail' }).content.includes('![[My.base#Detail]]'));
});

test("cover delimiters fail closed without changing safe local embeds", () => {
 for (const cover of ['cover]]\n![](https://remote.test)', 'cover|other', 'cover#part', 'https://remote.test/x', 'cover\\name', 'cover\u2028name']) {
  assert.throws(() => renderBookNote({ kindle_cover: cover } as BookFrontmatter), /cover/i);
 }
 assert.ok(renderBookNote({ kindle_cover: 'assets/cover.jpg' } as BookFrontmatter).content.includes('![[assets/cover.jpg|150]]'));
});

test("a block the source no longer carries is retained once", () => {
	const block = "> A simple passage.\n*p. 37 · loc. 510–512 · 2017-11-04*";
	const rendered = renderHighlights([], `## Highlights\n\n${block}\n\n${block}`);
	assert.equal(rendered.text, block);
	assert.equal(rendered.retained, 1);
});

test("clippings repeated seconds apart merge into one dated block", () => {
	for (const type of ["highlight", "note"]) {
		const base: RawClipping = { title: "T", type, location: "10", page: "2", text: "Same passage" };
		const clips = ["16:31:47", "16:32:50"].map(time => ({ ...base, added_at: `Samstag, 7. Dezember 2024 ${time}` }));
		const first = renderHighlights([...clips, clips[0]]).text;
		assert.equal((first.match(/Same passage/g) || []).length, 1);
		assert.match(first, /\*p\. 2 · loc\. 10 · 2024-12-07\*$/);
		assert.doesNotMatch(first, /<!--/);
		for (const incoming of [clips, [clips[1]], []]) {
			assert.equal(renderHighlights(incoming, `## Highlights\n\n${first}`).text, first);
		}
	}
});

test("multiline passages preserve quote-prefixed blank lines, notes, and distinct positions", () => {
	const base: RawClipping = {
		title: "T", type: "highlight", location: "10", text: "First paragraph\n\nSecond paragraph\n\n\nFinal paragraph",
	};
	const clips = [base, { ...base, location: "20" }, { ...base, text: "First paragraph\n\nDifferent ending" }, { ...base, type: "note" }];
	const first = renderHighlights(clips).text;
	assert.ok(first.includes("> First paragraph\n> \n> Second paragraph\n> \n> \n> Final paragraph"));
	assert.ok(first.includes("**Note:** First paragraph&#10;&#10;Second paragraph&#10;&#10;&#10;Final paragraph"));
	const blocks = extractHighlightBlocks(`## Highlights\n\n${first}`);
	assert.equal(blocks.size, 4);
	assert.deepEqual([...blocks.values()], clips.map(formatClipping));
	for (const incoming of [clips, []]) {
		let text = first;
		for (let pass = 0; pass < 3; pass++) {
			text = renderHighlights(incoming, `## Highlights\n\n${text}`).text;
			assert.equal(text, first);
		}
	}
});

test("clipping date parsing: German, English, French, Spanish, and fallback", () => {
	assert.equal(parseClippingDate("Samstag, 7. Dezember 2024 16:31:47"), "2024-12-07");
	assert.equal(parseClippingDate("Saturday, December 7, 2024 4:31:47 PM"), "2024-12-07");
	assert.equal(parseClippingDate("samedi 7 décembre 2024 16:31:47"), "2024-12-07");
	assert.equal(parseClippingDate("sábado, 7 de diciembre de 2024 16:31:47"), "2024-12-07");
	assert.equal(parseClippingDate("2024-12-07"), "2024-12-07");
	assert.equal(parseClippingDate("Unknown format"), "Unknown format");
	assert.equal(parseClippingDate(""), "");
});

test("clipping formatting: highlights and notes", () => {
	const hl: RawClipping = {
		title: "Wind and Truth",
		type: "highlight",
		location: "6888-6889",
		added_at: "Samstag, 7. Dezember 2024 16:31:47",
		text: "Fight for something, not simply because you're pointed that way by a monarch,\nno matter how beloved",
	};
	const renderedHl = formatClipping(hl);
	assert.ok(renderedHl.includes("> Fight for something"));
	assert.ok(renderedHl.includes("> no matter how beloved"));
	assert.ok(renderedHl.includes("*loc. 6888–6889 · 2024-12-07*"));

	const note: RawClipping = {
		title: "Test",
		type: "note",
		page: "155",
		location: "2365",
		text: "acceptance vs truth",
	};
	const renderedNote = formatClipping(note);
	assert.ok(renderedNote.includes("**Note:** acceptance vs truth"));
	assert.ok(renderedNote.includes("*p. 155 · loc. 2365*"));
});

test("highlights deduplication and bookmarks filtering", () => {
	const clippings: RawClipping[] = [
		{ title: "T", type: "bookmark", location: "100" },
		{ title: "T", type: "highlight", location: "200", text: "Same text" },
		{ title: "T", type: "highlight", location: "201", text: "Same text" },
		{ title: "T", type: "highlight", location: "300", text: "Unique text" },
	];
	const rendered = renderHighlights(clippings).text;
	assert.ok(!rendered.includes("bookmark"));
	// Identical text at distinct locations is not a duplicate.
	const count = (rendered.match(/Same text/g) || []).length;
	assert.equal(count, 2);
	assert.ok(rendered.includes("Unique text"));
});

test("extract highlights from existing markdown", () => {
	const md = `---
meta_type: db
---

![[cover.jpg|150]]

![[Kindle.base#Detail]]

## Highlights

> Existing quote
*loc. 100 · 2024-01-01*

**Note:** My thought
*loc. 105*
`;
	const texts = new Set(extractHighlightBlocks(md).keys());
	assert.equal(texts.size, 2);
	assert.ok([...texts].some(key => key.includes("Existing quote")));
	assert.ok([...texts].some(key => key.includes("My thought")));
});

test("renderFrontmatterYaml quotes special characters and leading asterisks (YAML safety)", () => {
	const fm: BookFrontmatter = {
		meta_type: "db",
		meta_project: "reading_db",
		meta_source: "kindle",
		meta_generator: "kindle_sync",
		kindle_uuid: "b34430fe-e746-44b5-95a0-a5cdc9ed0299",
		kindle_asin: "*48a29dd75935829abc3ffea6bc8014e34df5a52c",
		kindle_title: "7_Read Wind and Truth by Brandon Sanderson: Chapters 12 and 13",
		kindle_author: "Brandon Sanderson",
	};
	const rendered = renderFrontmatterYaml(fm);
	assert.ok(rendered.includes('kindle_asin: "*48a29dd75935829abc3ffea6bc8014e34df5a52c"'));
});

test("highlight retention: keeps existing blocks absent from the new clippings", () => {
	const existing = `---
kindle_uuid: abc
---

![[Kindle.base#Detail]]

## Highlights

> Pruned from My Clippings.txt
> but still on disk
*loc. 100 · 2024-01-01*

**Note:** a thought only on disk
*loc. 105*

> Still in the source
*loc. 200*
`;
	const clippings: RawClipping[] = [
		{ title: "T", type: "highlight", location: "200", text: "Still in the source" },
		{ title: "T", type: "highlight", location: "300", text: "Brand new" },
	];

	const result = renderHighlights(clippings, existing);

	// incoming survive
	assert.ok(result.text.includes("> Still in the source"));
	assert.ok(result.text.includes("> Brand new"));
	// retained, verbatim, including their meta lines
	assert.ok(result.text.includes("> Pruned from My Clippings.txt\n> but still on disk"));
	assert.ok(result.text.includes("*loc. 100 · 2024-01-01*"));
	assert.ok(result.text.includes("**Note:** a thought only on disk"));
	assert.equal(result.retained, 2);
	// the one present in both is not duplicated
	assert.equal((result.text.match(/Still in the source/g) || []).length, 1);
});

test("highlight retention: empty clippings do not erase an existing section", () => {
	const existing = `## Highlights

> Only on disk
*loc. 1*
`;
	const result = renderHighlights([], existing);
	assert.ok(result.text.includes("> Only on disk"));
	assert.equal(result.retained, 1);
});

test("highlight retention: stops at the next heading", () => {
	const existing = `## Highlights

> Kept
*loc. 1*

## Something Else

> Not a highlight
`;
	const result = renderHighlights([], existing);
	assert.ok(result.text.includes("> Kept"));
	assert.ok(!result.text.includes("Not a highlight"));
	assert.equal(result.retained, 1);
});

test("highlight retention: whitespace differences do not create duplicates", () => {
	const existing = `## Highlights

> A wrapped
> highlight line
*loc. 1*
`;
	const clippings: RawClipping[] = [
		{ title: "T", type: "highlight", location: "1", text: "A wrapped\nhighlight line" },
	];
	const result = renderHighlights(clippings, existing);
	assert.equal(result.retained, 0);
	assert.equal((result.text.match(/A wrapped/g) || []).length, 1);
});
