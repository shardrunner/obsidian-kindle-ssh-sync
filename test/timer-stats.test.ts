import { test } from "node:test";

import assert from "node:assert/strict";

import * as fs from "node:fs";

import * as path from "node:path";

import { decodeKrds, KrdsValue } from "../src/decode/krds";

import { computeTimerStats } from "../src/decode/timer-stats";

import { roundHalfEven, titleKey } from "../src/decode/normalize";

const METRICS_EXTS = [".azw3f", ".yjf", ".mbs"];

interface OracleBook {
	uuid: string;
	location?: string | null;
	stats?: Record<string, unknown> | null;
}

test("the primary reading cluster alone drives wpm_reading", () => {
	// Regression guard for upstream 4c67d4f: averaging across all three Gaussian
	// components reported wpm_reading 1281 where cluster 0 alone gives 246.
	const tm = {
		totalTime: 3600000,
		totalWords: 14760,
		totalPercent: 0.5,
		averageCalculator: {
			samples1: [],
			samples2: [],
			normalDistributions: [
				{ count: 100, sum: 24600, sumOfSquares: 6100000 }, // reading, mean 246
				{ count: 10, sum: 12000, sumOfSquares: 14500000 }, // skimming, mean 1200
				{ count: 5, sum: 20000, sumOfSquares: 80500000 }, // page turning
			],
			outliers: [],
		},
	};

	const s = computeTimerStats(tm as never, { numberOfWords: 90000 } as never);
	assert.equal(s.wpm_reading, 246);
	assert.equal(s.speed_samples, 100);
	assert.equal(s.clusters?.length, 3);
	assert.deepStrictEqual(
		s.clusters?.map((c) => c.label),
		["Reading", "Skimming", "Page Turning"]
	);
	assert.equal(s.wpm_overall, 246);
});

test("a missing or empty timer.model yields no stats at all", () => {
	assert.deepStrictEqual(computeTimerStats(null, null), {});
	assert.deepStrictEqual(computeTimerStats(undefined, { numberOfWords: 10 } as never), {});
});

test("roundHalfEven breaks ties to even", () => {
	assert.equal(roundHalfEven(0.5), 0);
	assert.equal(roundHalfEven(1.5), 2);
	assert.equal(roundHalfEven(2.5), 2);
	assert.equal(roundHalfEven(3.5), 4);
	assert.equal(roundHalfEven(-2.5), -2);
	assert.equal(roundHalfEven(0.125, 2), 0.12);
	assert.equal(roundHalfEven(0.375, 2), 0.38);
	// Non-ties still round to nearest, matching the double's true value.
	// The trap: 2.675 * 100 is exactly 267.5 in floating point, but the double's
	// true value is 2.67499999..., so this is NOT a tie and must round down.
	assert.equal(roundHalfEven(2.675, 2), 2.67);
	assert.equal(roundHalfEven(8.835, 2), 8.84);
	assert.equal(roundHalfEven(1.005, 2), 1.0);
	assert.equal(roundHalfEven(2.4), 2);
	assert.equal(roundHalfEven(2.6), 3);
});

test("titleKey keeps Unicode letters, so a German library still matches by title", () => {
	assert.equal(titleKey("Die Macht des Bewusstseins"), "diemachtdesbewusstseins");
	assert.equal(titleKey("Größenwahn: Über Maß"), "größenwahnübermaß");
	assert.equal(titleKey("Mistborn: 1"), "mistborn1");
	assert.equal(titleKey(null), "");
});
