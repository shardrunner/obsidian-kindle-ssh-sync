/**
 * Freeze this plugin's own decode of the private fixture cache as the
 * regression baseline for `npm run test:oracle`.
 *
 * The output is test/fixtures/golden.json: the built library (source records,
 * vocabulary word layer, clippings) plus the presentation groups a sync would
 * persist. Regenerate only after an intended decode change, and review the
 * diff first -- the oracle tier passes against whatever this writes.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { buildLibrary } from "../src/decode/build";
import { groupForPresentation } from "../src/decode/archive";
import { decodeUtf8Sig, parseClippings } from "../src/decode/clippings";

if (process.env.TZ !== "Europe/Berlin") {
	throw new Error("Run with TZ=Europe/Berlin: KRDS timestamps decode to naive local time.");
}

const fixtures = path.join(__dirname, "..", "test", "fixtures");
const built = buildLibrary(path.join(fixtures, "cache"));
if (built.warnings.length) throw new Error(`Fixture build warned:\n${built.warnings.join("\n")}`);
const { groups } = groupForPresentation(built.library.books, built.archiveGroups);

const out = path.join(fixtures, "golden.json");
// The parsed clippings are the clipping-parser oracle, not part of the decode.
const clippingsFile = path.join(fixtures, "cache", "documents", "My Clippings.txt");
const { clippings } = parseClippings(decodeUtf8Sig(new Uint8Array(fs.readFileSync(clippingsFile))));
fs.writeFileSync(out, JSON.stringify({ vocabulary: built.library.vocabulary, clippings: { clippings }, books: built.library.books, groups }, null, 1) + "\n");
console.log(`wrote ${out}: ${built.library.books.length} records, ${groups.length} groups`);
