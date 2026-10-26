import * as fs from 'node:fs';
import { buildBookFrontmatter } from '../src/book-note';
import { renderBookNote } from '../src/note-render';
import type { RawBook } from '../src/types';

// Entirely invented data and prose; never read a device, cache or private fixture.
const book: RawBook = {
 uuid: 'demo-garden-of-small-ideas', title: 'The Garden of Small Ideas',
 author: 'Alex Example', language: 'en', percentFinished: 42,
 read_status: 'reading', on_device: true,
 stats: { hours: 2.5, wpm_reading: 230, words_read: 34500 },
 clippings: [{ title: 'The Garden of Small Ideas', author: 'Alex Example',
  type: 'highlight', page: 37, location: '510-512',
  added_at: '2026-01-15T12:00:00Z',
  text: 'A small idea, tended every day, can change the shape of a life.' }],
};
const fm = buildBookFrontmatter(book, { targetFolder: 'Books', assetsSubfolder: 'assets', copyCovers: false });
const content = renderBookNote(fm, { clippings: book.clippings!, baseEmbed: '' }).content;
fs.mkdirSync('docs/demo', { recursive: true });
fs.writeFileSync('docs/demo/Alex Example--The Garden of Small Ideas.md', content);
