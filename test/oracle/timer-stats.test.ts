import { test } from "node:test";

import assert from "node:assert/strict";

import * as fs from "node:fs";

import * as path from "node:path";

import { decodeKrds, KrdsValue } from "../../src/decode/krds";

import { computeTimerStats } from "../../src/decode/timer-stats";

import { roundHalfEven, titleKey } from "../../src/decode/normalize";

import { golden } from "./golden";

const FIXTURES = path.join(__dirname, "../fixtures");

const CACHE = path.join(FIXTURES, "cache");

const METRICS_EXTS = [".azw3f", ".yjf", ".mbs"];

interface OracleBook {
	uuid: string;
	location?: string | null;
	stats?: Record<string, unknown> | null;
}

const books: OracleBook[] = golden().books as OracleBook[];

function metricsFileFor(location: string | null | undefined): string | undefined {
	if (!location || !location.startsWith("/mnt/us/")) return undefined;
	const base = location.slice("/mnt/us/".length).replace(/\.[^./]*$/, "");
	const dir = path.join(CACHE, ...(base + ".sdr").split("/"));
	if (!fs.existsSync(dir)) return undefined;
	const f = fs.readdirSync(dir).find((n) => METRICS_EXTS.some((x) => n.endsWith(x)));
	return f ? path.join(dir, f) : undefined;
}

test("timer stats reproduce book.stats for every book with a retained metrics container", () => {
	const failures: string[] = [];
	let compared = 0;

	for (const book of books) {
		const file = metricsFileFor(book.location);
		if (!file || !book.stats || Object.keys(book.stats).length === 0) continue;

		const tree = decodeKrds(new Uint8Array(fs.readFileSync(file))).value;
		const actual = computeTimerStats(
			tree["timer.model"] as KrdsValue,
			tree["book.info.store"] as KrdsValue
		);

		compared++;
		try {
			assert.deepStrictEqual(actual, book.stats);
		} catch (e) {
			failures.push(`${book.uuid}: ${(e as Error).message}`);
		}
	}

	assert.deepStrictEqual(failures.slice(0, 5), [], `${failures.length}/${compared} diverged`);
	// 94 books carry a timer.model in this fixture; pin it so a
	// pairing regression cannot quietly shrink the differential's coverage.
	assert.equal(compared, 94, "compared-book count drifted; re-measure the fixture");
});
