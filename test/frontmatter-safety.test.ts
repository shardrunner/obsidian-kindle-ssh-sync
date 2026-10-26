import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBookFrontmatter } from '../src/book-note';
import { renderFrontmatterYaml } from '../src/note-render';

test('custom arrays and objects survive rendering; invariants cannot be overridden', () => {
 const fm = buildBookFrontmatter({ uuid: 'synthetic', title: 'Book' }, {
  targetFolder: 'Books', assetsSubfolder: 'assets', copyCovers: false,
  existingFrontmatter: { meta_source: 'personal', tags: ['fiction'], rating: { stars: 4 }, position: { start: 0 }, 'unsafe: key': 'value' } as any,
 });
 const yaml = renderFrontmatterYaml(fm);
 assert.match(yaml, /tags: \["fiction"\]/);
 assert.match(yaml, /rating: \{"stars":4\}/);
 assert.match(yaml, /"unsafe: key": "value"/);
 assert.doesNotMatch(yaml, /position:/);
 assert.equal(fm.meta_source, 'kindle');
});
test('all string values remain strings and cannot inject YAML lines', () => {
 for (const value of ['en\ninjected: true', '123', 'TRUE', '2025-01-01', '\\escape', '']) {
  const yaml = renderFrontmatterYaml({ kindle_language: value } as any);
  assert.equal(yaml, `---\nkindle_language: ${JSON.stringify(value)}\n---`);
 }
});
test('YAML line separators are escaped and prototype-named custom keys survive', () => {
 const fm = buildBookFrontmatter({ uuid: 'synthetic', title: 'Book' }, {
  targetFolder: 'Books', assetsSubfolder: 'assets', copyCovers: false,
  existingFrontmatter: JSON.parse('{"constructor":"custom","__proto__":{"safe":true},"custom":"a\\u0085b\\u2028c\\u2029d"}'),
 });
 const yaml = renderFrontmatterYaml(fm);
 assert.match(yaml, /constructor: "custom"/);
 assert.match(yaml, /__proto__: \{"safe":true\}/);
 assert.match(yaml, /custom: "a\\u0085b\\u2028c\\u2029d"/);
});
