import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type KindleSyncPlugin from "./main";
import { DEFAULT_SETTINGS, KindleSyncSettings } from "./types";
import { defaultCachePath } from "./device/cache";

type TextSettingKey = {
	[K in keyof KindleSyncSettings]: KindleSyncSettings[K] extends string ? K : never;
}[keyof KindleSyncSettings];

export class KindleSyncSettingTab extends PluginSettingTab {
	plugin: KindleSyncPlugin;

	constructor(app: App, plugin: KindleSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/** A trimmed text setting saved on every change. */
	private text(
		name: string,
		desc: string,
		key: TextSettingKey,
		placeholder: string,
		normalize: (value: string) => string = (value) => value.trim()
	): void {
		new Setting(this.containerEl)
			.setName(name)
			.setDesc(desc)
			.addText((text) =>
				text
					.setPlaceholder(placeholder)
					.setValue(this.plugin.settings[key])
					.onChange(async (value) => {
						this.plugin.settings[key] = normalize(value);
						await this.plugin.saveSettings();
					})
			);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.text(
			"Raw cache folder",
			"Where the immutable raw archive lives, outside the vault. " +
				"Leave blank for $XDG_DATA_HOME/kindle-ssh-sync/. Nothing here is ever pruned.",
			"cachePath",
			defaultCachePath()
		);

		new Setting(containerEl).setName("Vault layout").setHeading();

		this.text("Target folder", "Vault folder where Kindle book notes are created (e.g. Kindle)", "targetFolder", "Kindle");
		this.text(
			"Inactive subfolder",
			"Subfolder for unopened/inactive books (leave blank for a single flat folder)",
			"inactiveSubfolder",
			DEFAULT_SETTINGS.inactiveSubfolder
		);
		this.text(
			"Assets subfolder",
			"Subfolder inside the target folder that holds cover thumbnails",
			"assetsSubfolder",
			DEFAULT_SETTINGS.assetsSubfolder,
			(value) => value.trim() || DEFAULT_SETTINGS.assetsSubfolder
		);
		this.text(
			"Base view to embed",
			"Embedded in every generated note, e.g. Kindle.base#Detail. " +
				"Create a .base file in your vault and use its filename and view name. " +
				"Leave blank to omit the embed.",
			"baseEmbed",
			DEFAULT_SETTINGS.baseEmbed
		);

		new Setting(containerEl)
			.setName("Copy covers")
			.setDesc("Copy cover thumbnails from the raw cache into the assets folder")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.copyCovers)
					.onChange(async (value) => {
						this.plugin.settings.copyCovers = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName("Device connection").setHeading();

		containerEl.createEl("p", {
			text: "Blank host and username use 192.168.15.244 and root; the password defaults to kindle. The Kindle's host key is trusted on the first connection and checked afterwards.",
			cls: "setting-item-description",
		});

		this.text("Kindle host / IP", "Kindle IP address on USB network (default: 192.168.15.244)", "kindleHost", "192.168.15.244");
		this.text("Kindle SSH username", "SSH username (default: root)", "kindleUser", "root");

		new Setting(containerEl)
			.setName("Kindle SSH password")
			.setDesc("Saved with the plugin settings in this vault. Default: kindle.")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setValue(this.plugin.settings.kindlePassword)
					.onChange(async (value) => {
						this.plugin.settings.kindlePassword = value;
						await this.plugin.saveSettings();
					});
			});

		this.text(
			"Kindle host fingerprint",
			"Recorded automatically on the first sync. Clear it after resetting or re-jailbreaking the Kindle to trust its new key.",
			"kindleHostFingerprint",
			"Set on first sync"
		);

		new Setting(containerEl)
			.setName("SSH operation timeout (seconds)")
			.setDesc("Maximum seconds for each SSH operation; not a total sync or local build deadline. Connecting gives up after 15 s at most.")
			.addText((text) =>
				text
					.setPlaceholder(String(DEFAULT_SETTINGS.syncTimeoutSeconds))
					.setValue(String(this.plugin.settings.syncTimeoutSeconds))
					.onChange(async (value) => {
						const num = Number(value.trim());
						if (!Number.isInteger(num) || num <= 0) {
							// Say so rather than silently keeping the old value while
							// the field shows something else.
							new Notice(
								`SSH operation timeout must be a positive whole number of seconds. ` +
									`Keeping ${this.plugin.settings.syncTimeoutSeconds}.`
							);
							return;
						}
						this.plugin.settings.syncTimeoutSeconds = num;
						await this.plugin.saveSettings();
					})
			);
	}
}
