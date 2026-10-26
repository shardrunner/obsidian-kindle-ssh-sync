/**
 * Reading timer statistics derived from the KRDS `timer.model` and
 * `book.info.store` structures.
 *
 * On the Gaussian mixture: `timer.average.calculator` stores up to three normal
 * distributions --
 *   cluster 0: focused reading   cluster 1: skimming   cluster 2: page turning
 * -- and the true reading speed and its variance come from cluster 0 only.
 * Averaging across all three reports a wildly inflated speed (1281 instead of
 * 246 wpm on the fixture); the oracle test pins that.
 */
import type { RawBookStats } from "../types";
import { KrdsValue } from "./krds";
import { roundHalfEven } from "./normalize";

const CLUSTER_LABELS = ["Reading", "Skimming", "Page Turning"];

function isMapping(v: unknown): v is Record<string, KrdsValue> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * A missing total counts as 0. A present-but-non-numeric value is a hard error
 * rather than a silent 0: it means the KRDS decode produced something
 * structurally wrong, which must be loud, not quietly rounded away to zero hours.
 */
function totalOrZero(v: KrdsValue | undefined, field: string): number {
	if (v === undefined || v === null) return 0;
	if (typeof v !== "number") {
		throw new TypeError(
			`timer.model.${field} should be a number, got ${JSON.stringify(v)}`
		);
	}
	return v;
}

function numberOr(v: KrdsValue | undefined, fallback: number): number {
	return typeof v === "number" ? v : fallback;
}

/** Recursively flatten nested lists of numeric samples, rounding to 1 digit. */
function flattenNumbers(items: KrdsValue | undefined): number[] {
	const res: number[] = [];
	const walk = (item: KrdsValue | undefined) => {
		if (Array.isArray(item)) {
			for (const sub of item) {
				if (Array.isArray(sub)) walk(sub);
				else if (typeof sub === "number") res.push(roundHalfEven(sub, 1));
			}
		} else if (typeof item === "number") {
			res.push(roundHalfEven(item, 1));
		}
	};
	walk(items);
	return res;
}

/** Count, mean and variance of one mixture component, or null if it is empty. */
function moments(d: KrdsValue | undefined): { count: number; mean: number; variance: number } | null {
	if (!isMapping(d)) return null;
	const count = numberOr(d["count"], 0);
	if (count <= 0) return null;
	const mean = numberOr(d["sum"], 0) / count;
	const variance = Math.max(0, numberOr(d["sumOfSquares"], 0) / count - mean ** 2);
	return { count, mean, variance };
}

export function computeTimerStats(
	tm: KrdsValue | null | undefined,
	bi: KrdsValue | null | undefined
): RawBookStats {
	const out: RawBookStats = {};
	if (!isMapping(tm)) return out;

	const tt = totalOrZero(tm["totalTime"], "totalTime");
	const tw = totalOrZero(tm["totalWords"], "totalWords");
	const tp = totalOrZero(tm["totalPercent"], "totalPercent");

	const mins = tt / 60000.0;
	out.minutes = roundHalfEven(mins, 1);
	out.hours = roundHalfEven(mins / 60.0, 2);
	out.words_read = tw;
	out.percent_read = roundHalfEven(tp * 100, 1);
	out.wpm_overall = mins ? roundHalfEven(tw / mins) : 0;

	const acRaw = tm["averageCalculator"];
	const ac = isMapping(acRaw) ? acRaw : {};
	const distsRaw = ac["normalDistributions"];
	const dists = Array.isArray(distsRaw) ? distsRaw : [];

	const reading = moments(dists[0]);
	if (reading) {
		out.wpm_reading = roundHalfEven(reading.mean);
		out.speed_samples = reading.count;
		out.wpm_variance = roundHalfEven(reading.variance, 2);
		out.wpm_std_dev = roundHalfEven(Math.sqrt(reading.variance), 2);
	} else {
		out.wpm_reading = out.wpm_overall;
		out.speed_samples = 0;
		out.wpm_variance = 0.0;
		out.wpm_std_dev = 0.0;
	}

	const clusters: NonNullable<RawBookStats["clusters"]> = [];
	for (let i = 0; i < dists.length; i++) {
		const m = moments(dists[i]);
		if (m) {
			clusters.push({
				cluster: i,
				label: i < CLUSTER_LABELS.length ? CLUSTER_LABELS[i] : `Cluster ${i}`,
				count: m.count,
				wpm: roundHalfEven(m.mean),
				std_dev: roundHalfEven(Math.sqrt(m.variance), 2),
			});
		}
	}
	out.clusters = clusters;

	const flatOutliers = flattenNumbers(ac["outliers"]);
	out.outliers_count = flatOutliers.length;
	out.outliers = flatOutliers;

	const s1 = ac["samples1"];
	const s2 = ac["samples2"];
	out.samples_recorded =
		(Array.isArray(s1) ? s1.length : 0) + (Array.isArray(s2) ? s2.length : 0);

	if (isMapping(bi)) {
		out.book_words = numberOr(bi["numberOfWords"], 0);
	}

	return out;
}
