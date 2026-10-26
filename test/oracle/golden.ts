import * as fs from "node:fs";
import * as path from "node:path";
import type { PresentationGroup } from "../../src/decode/archive";
import type { LibraryJson, RawClipping } from "../../src/types";

export const FIXTURES = path.join(__dirname, "../fixtures");
export const CACHE = path.join(FIXTURES, "cache");

/** `clippings` is the parser oracle, stored beside the decode. */
export type Golden = LibraryJson & { groups: PresentationGroup[]; clippings: { clippings: RawClipping[] } };

let cached: string | undefined;

/**
 * This plugin's frozen decode of the fixture cache (`npm run fixtures:golden`).
 * Returns a fresh copy each call, so tests may mutate it.
 */
export function golden(): Golden {
	cached ??= fs.readFileSync(path.join(FIXTURES, "golden.json"), "utf-8");
	return JSON.parse(cached);
}
