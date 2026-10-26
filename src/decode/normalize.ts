/**
 * Rounding and title normalisation shared by the decoders. Changes here
 * surface only as golden-diff deltas that are easy to misattribute to the
 * archive or merge logic, so they are isolated and tested on their own.
 */

/** A SQLite/JSON cell as a string, keeping absence as null. */
export const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
/** A numeric cell, or null for anything that is not already a number. */
export const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

/**
 * Round half to even, which keeps stored stats stable across builds.
 * JS `Math.round` breaks ties upward and `toFixed` breaks them away from zero.
 *
 *   roundHalfEven(2.5)      -> 2      Math.round(2.5)     -> 3
 *   roundHalfEven(0.125, 2) -> 0.12   (0.125).toFixed(2)  -> "0.13"
 *
 * Away from an exact tie, `toFixed` already rounds the double's true value
 * correctly, so only the tie itself needs handling.
 *
 * Detecting the tie is the subtle part. Testing `x * 10**digits` does not work:
 * `2.675 * 100` rounds to exactly `267.5`, inventing a tie where the double's
 * true value (2.67499999...) has none, and would round 2.675 up to 2.68
 * instead of 2.67. Instead, note that a true tie needs
 * `x === (2k+1) / (2 * 10**digits)`, and a double is always `p / 2**q`, which
 * together force `x === m / 2**(digits+1)` with `m` odd. So the exact test is
 * "`x * 2**(digits+1)` is an odd integer" -- and scaling by a power of two is
 * lossless in binary floating point.
 */
export function roundHalfEven(x: number, digits = 0): number {
	if (!Number.isFinite(x)) return x;

	const dyadic = x * 2 ** (digits + 1);
	const isTie = Number.isInteger(dyadic) && Math.abs(dyadic % 2) === 1;

	if (isTie) {
		const factor = 10 ** digits;
		const scaled = x * factor; // exactly a half-integer, given a real tie
		const floor = Math.floor(scaled);
		const even = floor % 2 === 0 ? floor : floor + 1;
		return digits === 0 ? even : even / factor;
	}

	if (digits === 0) return Math.round(x);
	return Number(x.toFixed(digits));
}

/**
 * Title matching key: lowercase, keeping only Unicode letters and numbers. A
 * naive `/[^a-z0-9]/g` would strip every umlaut and eszett and destroy title
 * matching in a German library. The key is stored implicitly in synthetic
 * uuids, so changing it re-keys those records.
 */
export function titleKey(text: string | null | undefined): string {
	if (!text) return "";
	return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}
