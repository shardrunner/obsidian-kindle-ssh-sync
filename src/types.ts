export interface KindleSyncSettings {
	/** Blank means `$XDG_DATA_HOME/kindle-ssh-sync/`. */
	cachePath: string;
	/** Vault folder where book notes are created. Default `Kindle`. */
	targetFolder: string;
	/** Subfolder of targetFolder for inactive books; blank = flat layout. */
	inactiveSubfolder: string;
	/** Subfolder of targetFolder holding cover thumbnails. */
	assetsSubfolder: string;
	/** Base view embed in every note; empty omits the embed. */
	baseEmbed: string;
	copyCovers: boolean;
	kindleHost: string;
	kindleUser: string;
	/** Recorded on the first connection; cleared by the user to trust a new key. */
	kindleHostFingerprint: string;
	/** Stored in the plugin's data.json; defaults to the jailbreak's preset. */
	kindlePassword: string;
	syncTimeoutSeconds: number;
}

export const DEFAULT_SETTINGS: KindleSyncSettings = {
	cachePath: "",
	targetFolder: "Kindle",
	inactiveSubfolder: "inactive",
	assetsSubfolder: "assets",
	baseEmbed: "",
	copyCovers: true,
	kindleHost: "",
	kindleUser: "",
	kindleHostFingerprint: "",
	kindlePassword: "kindle",
	syncTimeoutSeconds: 600,
};

export interface RawClipping {
	title: string;
	author?: string | null;
	type: string; // 'highlight' | 'note' | 'bookmark'
	page?: number | string | null;
	location?: string | null;
	added_at?: string | null;
	text?: string | null;
}

export interface RawBookStats {
	hours?: number;
	wpm_overall?: number;
	wpm_reading?: number;
	wpm_std_dev?: number;
	percent_read?: number;
	words_read?: number;
	book_words?: number;
	minutes?: number;
	/** A COUNT of samples in the primary cluster, not the samples themselves. */
	speed_samples?: number;
	wpm_variance?: number;
	outliers?: number[];
	outliers_count?: number;
	samples_recorded?: number;
	clusters?: Array<{
		cluster: number;
		label: string;
		count: number;
		wpm: number;
		std_dev: number;
	}>;
}

export interface RawAzw3fPosition {
	position?: string | number | null;
	time?: string | null;
	timeZoneOffset?: string | null;
	country?: string | null;
	device?: string | null;
}

export interface RawAzw3f {
	lpr?: RawAzw3fPosition | null;
	fpr?: RawAzw3fPosition | null;
	"book.info.store"?: {
		numberOfWords?: number;
		percentOfBook?: number;
	} | null;
	"page.history.store"?: any[] | null;
	"timer.model"?: any | null;
}

export interface RawAzw3rApnx {
	asin?: string | null;
	cdeType?: string | null;
	sidecarAvailable?: boolean | null;
	oPNToPosition?: number[] | null;
	first?: number | null;
	pageMap?: string | null;
}

export interface RawAzw3r {
	"apnx.key"?: RawAzw3rApnx | null;
	sync_lpr?: RawAzw3fPosition | null;
	"font.prefs"?: any;
	"annotation.cache.object"?: any;
	ReaderMetrics?: any;
	StartActions?: any;
}

export interface RawBook {
	/** Stable source identity; the first catalogue p_uuid this record had. */
	uuid: string;
	/** The current cc.db p_uuid, when the catalogue has since reassigned it. */
	catalogueUuid?: string;
	title: string;
	author?: string | null;
	cdeKey?: string | null;
	cdeType?: string | null;
	guid?: string | null;
	publisher?: string | null;
	language?: string | null;
	publicationDate?: number | string | null;
	addedDate?: number | null;
	originType?: number | null;
	isDRMProtected?: boolean | null;
	isIndexed?: number | boolean | null;
	diskUsage?: number | null;
	contentSize?: number | null;
	watermark?: string | null;
	mimeType?: string | null;
	thumbnail?: string | null;
	percentFinished?: number | null;
	readState?: number | null;
	read_status?: string | null;
	fm_read_state?: string | null;
	dictionary_override?: string | null;
	device_sessions?: any[] | null;
	lastAccess?: number | null;
	location?: string | null;
	isArchived?: number | boolean | null;
	on_device?: number | boolean | null;
	/**
	 * An object, not a string. Carried in the archive but not
	 * rendered -- the frontmatter schema has no series key.
	 */
	series?: {
		label?: string | null;
		name?: string | null;
		seriesId?: string | null;
	} | null;
	stats?: RawBookStats | null;
	annotations?: any[] | null;
	vocabulary?: any[] | null;
	clippings?: RawClipping[] | null;
	has_sidecar?: number | boolean | null;
	azw3f?: RawAzw3f | null;
	azw3r?: RawAzw3r | null;
}

export interface LibraryJson {
	vocabulary?: Record<string, any>;
	books: RawBook[];
}

export interface BookFrontmatter {
	meta_type: "db";
	meta_project: "reading_db";
	meta_source: "kindle";
	meta_generator: "kindle_sync";
	kindle_uuid: string;
	kindle_asin?: string;
	kindle_title: string;
	kindle_author: string;
	kindle_publisher?: string;
	kindle_published?: string;
	kindle_language?: string;
	kindle_format?: string;
	kindle_drm?: boolean;
	kindle_type?: string;
	kindle_origin?: string;
	kindle_progress_derived?: number;
	kindle_percent_finished?: number;
	kindle_page?: number;
	kindle_total_pages?: number;
	kindle_text_read?: number;
	kindle_words_read?: number;
	kindle_book_words?: number;
	kindle_finished?: boolean;
	kindle_read_status?: string;
	kindle_hours?: number;
	kindle_wpm?: number;
	kindle_wpm_reading?: number;
	kindle_wpm_std_dev?: number;
	kindle_annotations?: number;
	kindle_clippings?: number;
	kindle_vocabulary?: number;
	kindle_added?: string;
	kindle_last_read?: string;
	kindle_last_access?: string;
	kindle_amazon_archived?: boolean;
	kindle_on_device?: boolean;
	kindle_cover?: string;
}

export interface SyncStats {
	created: number;
	updated: number;
	renamed: number;
	moved: number;
	unchanged: number;
	orphaned: number;
	total: number;
	/** Highlight blocks kept because the source no longer reports them. */
	highlightsRetained: number;
	coversCopied: number;
	/** Non-fatal problems worth showing the user; never thrown away silently. */
	warnings: string[];
}
