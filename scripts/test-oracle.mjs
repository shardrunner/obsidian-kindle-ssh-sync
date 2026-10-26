#!/usr/bin/env node
// Contributor-friendly oracle runner: the oracle tier needs the private
// test/fixtures/golden.json and cache/ fixtures. Skip with a friendly message when it
// is absent; use test:oracle:strict in CI-adjacent runs to fail hard.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const strict = process.argv.includes("--strict");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = ["golden.json", "cache"].map((f) => join(root, "test", "fixtures", f));

if (!fixtures.every(existsSync)) {
	const msg = "Skipping oracle tests: test/fixtures/{golden.json,cache} not present (private fixtures).";
	if (strict) {
		console.error(`${msg} (strict mode: failing)`);
		process.exit(1);
	}
	console.log(msg);
	process.exit(0);
}

const result = spawnSync(
	process.execPath,
	["--import", "tsx", "--test", "test/oracle/*.test.ts"],
	{ cwd: root, stdio: "inherit", env: { ...process.env, TZ: "Europe/Berlin" } }
);
process.exit(result.status ?? 1);
