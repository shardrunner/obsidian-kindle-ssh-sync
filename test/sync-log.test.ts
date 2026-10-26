import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { recordSync, SyncLogEntry } from "../src/sync-log";

const entry = (outcome: SyncLogEntry["outcome"], startedAt: string): SyncLogEntry => ({
	startedAt, durationMs: 1200, source: "cache", outcome, warnings: [`${outcome} warning`],
});

test("each sync appends a log line and replaces the last report", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync-log-"));
	try {
		const first = entry("success", "2026-09-27T10:00:00.000Z");
		const second = { ...entry("failed", "2026-09-27T11:00:00.000Z"), error: "Error: boom\n    at stack" };
		recordSync(root, first);
		recordSync(root, second);
		const lines = fs.readFileSync(path.join(root, "sync-log.jsonl"), "utf8").trimEnd().split("\n");
		assert.deepEqual(lines.map(l => JSON.parse(l)), [first, second]);
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "last-sync-report.json"), "utf8")), second);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
