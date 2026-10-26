import { App, Modal } from "obsidian";
import { SyncStats } from "./types";

export interface SyncReport {
	stats: SyncStats;
	fromDevice: boolean;
	durationMs: number;
	cacheSummary?: string;
}

export class SyncReportModal extends Modal {
	private report: SyncReport;

	constructor(app: App, report: SyncReport) {
		super(app);
		this.report = report;
	}

	onOpen(): void {
		const { contentEl } = this;
		const { stats, fromDevice, durationMs } = this.report;

		contentEl.empty();
		contentEl.addClass("kindle-sync-report");

		this.setTitle("Kindle Sync");

		contentEl.createEl("p", {
			text:
				`${stats.total} books · ${(durationMs / 1000).toFixed(1)} s · ` +
				(fromDevice ? "from device" : "from cache"),
			cls: "setting-item-description",
		});

		if (this.report.cacheSummary) {
			contentEl.createEl("p", { text: this.report.cacheSummary, cls: "setting-item-description" });
		}

		const rows: [string, number][] = [
			["Created", stats.created],
			["Updated", stats.updated],
			["Unchanged", stats.unchanged],
			["Renamed", stats.renamed],
			["Moved", stats.moved],
			["Orphaned", stats.orphaned],
			["Covers copied", stats.coversCopied],
			["Highlights retained", stats.highlightsRetained],
		];

		const table = contentEl.createEl("table");
		const body = table.createEl("tbody");
		for (const [label, value] of rows) {
			const tr = body.createEl("tr");
			tr.createEl("td", { text: label });
			const td = tr.createEl("td", { text: String(value) });
			td.style.textAlign = "right";
			td.style.fontVariantNumeric = "tabular-nums";
			td.style.paddingLeft = "1.5em";
		}

		if (stats.highlightsRetained > 0) {
			contentEl.createEl("p", {
				text:
					`${stats.highlightsRetained} highlight(s) were kept because the source no ` +
					`longer reports them — likely a pruned My Clippings.txt.`,
				cls: "setting-item-description",
			});
		}

		if (stats.warnings.length > 0) {
			contentEl.createEl("h4", { text: `⚠ ${stats.warnings.length} warning(s)` });
			const list = contentEl.createEl("ul");
			for (const warning of stats.warnings) {
				list.createEl("li", { text: warning });
			}
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
