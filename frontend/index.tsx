import React from 'react';
import { Millennium, IconsModule, definePlugin, callable, findClassModule, findModuleExport } from '@steambrew/client';

// â”€â”€ Backend callables â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const saveMappingBackend   = callable<[{ non_steam_id: string; steam_id: string }], string>('save_mapping');
const removeMappingBackend = callable<[{ non_steam_id: string }], string>('remove_mapping');
const getAllMappings        = callable<[], string>('get_all_mappings');
const fetchGameData         = callable<[{ steam_app_id: string }], string>('fetch_game_data');
const fetchFriendPersonasBackend = callable<[{ steam_ids_csv: string }], string>('fetch_friend_personas');
const fetchCommunityContentBackend = callable<[{ steam_app_id: string }], string>('fetch_community_content');
const feLogBackend         = callable<[{ msg: string }], string>('fe_log');

/** Log to Millennium backend console so messages appear in the Millennium log */
function backendLog(msg: string): void {
	console.log('[GDL]', msg);
	feLogBackend({ msg }).catch(() => {});
}

// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
interface Mappings { [gameTitle: string]: string }
interface GameDataCache { [steamAppId: string]: SteamGameData | null }

interface FriendPersona {
	steamid: string;
	name: string;
	avatar: string;
}
const personaCache = new Map<string, FriendPersona>();

interface FriendPlayInfo {
	steamid: string;
	minutes_played: number;
	minutes_played_recently: number;
}

interface FriendCategories {
	recentlyPlayed: FriendPlayInfo[];
	previouslyPlayed: FriendPlayInfo[];
	totalCount: number;
}

interface CommunityContentItem {
	type: string;
	label?: string;
	image: string;
	title?: string;
	description?: string;
	author_name?: string;
	author_avatar?: string;
	link?: string;
}

interface SteamGameData {
	name: string;
	steam_appid: number;
	header_image: string;
	short_description: string;
	detailed_description?: string;
	about_the_game?: string;
	developers?: string[];
	publishers?: string[];
	genres?: { id: string; description: string }[];
	release_date?: { coming_soon: boolean; date: string };
	metacritic?: { score: number; url: string };
	categories?: { id: number; description: string }[];
	screenshots?: { id: number; path_thumbnail: string; path_full: string }[];
	background?: string;
	background_raw?: string;
	capsule_image?: string;
	capsule_imagev5?: string;
	website?: string;
	movies?: { id: number; name: string; thumbnail: string }[];
	achievements?: { total: number; highlighted?: { name: string; path: string }[] };
}

// â”€â”€ State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let mappings: Mappings = {};
const gameDataCache: GameDataCache = {};
let mainWindowDoc: Document | null = null;

// Persistent localStorage cache for instant load on revisit
const CACHE_PREFIX = 'gdl_cache_';
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

function cacheGet<T>(key: string): T | null {
	try {
		const raw = localStorage.getItem(CACHE_PREFIX + key);
		if (!raw) return null;
		const entry = JSON.parse(raw);
		if (Date.now() - entry.ts > CACHE_TTL) {
			localStorage.removeItem(CACHE_PREFIX + key);
			return null;
		}
		return entry.data as T;
	} catch { return null; }
}

function cacheSet(key: string, data: any): void {
	try {
		localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ ts: Date.now(), data }));
	} catch {}
}

async function loadMappings(): Promise<void> {
	try {
		const json = await getAllMappings();
		mappings = JSON.parse(json);
		backendLog('Loaded mappings: ' + JSON.stringify(mappings));
	} catch (e) {
		backendLog('Failed to load mappings: ' + e);
		mappings = {};
	}
}

async function getGameData(steamAppId: string): Promise<SteamGameData | null> {
	if (gameDataCache[steamAppId] !== undefined) return gameDataCache[steamAppId];
	const cached = cacheGet<SteamGameData>('gamedata_' + steamAppId);
	if (cached) {
		gameDataCache[steamAppId] = cached;
		return cached;
	}
	try {
		const json = await fetchGameData({ steam_app_id: steamAppId });
		const data = JSON.parse(json);
		if (data.error) { gameDataCache[steamAppId] = null; return null; }
		gameDataCache[steamAppId] = data;
		cacheSet('gamedata_' + steamAppId, data);
		return data;
	} catch (e) {
		backendLog('Fetch failed for ' + steamAppId + ': ' + e);
		gameDataCache[steamAppId] = null;
		return null;
	}
}

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function escapeHtml(str: string): string {
	const d = document.createElement('div');
	d.appendChild(document.createTextNode(str));
	return d.innerHTML;
}

/** Normalize a game title for use as a mapping key */
function normalizeTitle(title: string): string {
	return title.trim().toLowerCase();
}

/** Find mapping for a game title (case-insensitive) */
function findMappingForTitle(title: string): string | null {
	const key = normalizeTitle(title);
	if (mappings[key]) return mappings[key];
	for (const k of Object.keys(mappings)) {
		if (normalizeTitle(k) === key) return mappings[k];
	}
	return null;
}

// ── Localization ────────────────────────────────────────────────────────
// Steam's UI text changes with the client language, so DOM anchors must be
// looked up through Steam's own LocalizationManager (window global in the
// SharedJSContext) instead of hardcoded English strings.

/** Get a localized Steam UI string by token name (no '#' prefix), falling back to English */
function loc(token: string, fallbackEnglish: string): string {
	try {
		const lm = (window as any).LocalizationManager;
		const s = lm?.m_mapTokens?.get?.(token) ?? lm?.m_mapFallbackTokens?.get?.(token);
		if (typeof s === 'string' && s.length > 0) return s;
	} catch {}
	return fallbackEnglish;
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build a regex from a localized template containing %1$s substitution markers.
 *  Each %1$s becomes a capture group; whitespace is matched loosely.
 *  `anchored` pins the match to the whole string (needed when the template
 *  ends with %1$s, otherwise the lazy group would only capture one char). */
function templateToRegex(template: string, anchored = false): RegExp | null {
	const parts = template.split('%1$s');
	if (parts.length < 2) return null;
	const escaped = parts.map(p => escapeRegex(p.trim()).replace(/\s+/g, '\\s+'));
	const body = escaped.join('\\s*(.+?)\\s*');
	return new RegExp(anchored ? `^\\s*${body}$` : body);
}

// ── Native CSS modules ──────────────────────────────────────────────────
// Injected DOM uses Steam's own (hashed) CSS-module class names so it renders
// pixel-identical to native pages. Hashes are resolved at runtime via
// findClassModule; the literals below are fallbacks from the current build.

type CssClasses = { [name: string]: string };

const FEED_CLASSES_FALLBACK: CssClasses = {
	ActivityFeedContainer: '_3yTl3RiWfo-Itg-xp967wP',
	FetchMoreContainer: '_39ZurKJQex6v69aXzvc_nj',
	ViewLastNews: '_1EC1xjjUGqI7fqX6PVzJA3',
	AddToFeed: '_2bqRppbRWGNAZV5lfubW7-',
	PostTextEntry: 'YFAtL5H6txGXk5T_IhpUF',
	StatusInputBox: '_3NofiExBJn85uwEhca2dy7',
	StatusInputTextArea: '_10oyYsgiC5Hvnoieb7sHLI',
	StatusControlsRow: '_1HHZQHn8xe900jZYphjUlF',
	StatusControlsActive: '_3UJUKf-LVdVvYTGS51dmj',
	FormattingSpacer: '_3RowZ5DsqhGgvCelRGSZf2',
	FormattingButton: '_2Whi7Nrn2fmTSPtrf9jNFV',
};

const EVENT_CLASSES_FALLBACK: CssClasses = {
	AppActivityDay: 'S2Fu9HxHCA5MaCLGrN2ib',
	AppActivityDate: '_19LfMT7PFWg2xHOqNjR99q',
	Rule: '_3pcPRPvuGH7hEM33zLknZO',
	Event: 'UVeN0kaD3zv1feMj_mMw5',
	EventBody: 'NEMXhMlqXOCJwfgWlHXhT',
	UserStatus: 'Yo3XX_JHkn0gKBlBhDvyg',
	EventHeadline: 'QCKBqF2k_sRLcXJ5qQIEl',
	EventActorAvatar: '_1gVy5n_zNp3tXpwU2aV9k8',
	SpanEvent: '_3Nxqyyt2ilotu5ci553y82',
	ActorName: '_1t1iyV4uBG9M9tTM7rCFNu',
	HeadlineGameName: 'Gy1Y7lb4Y47vK8odzSru2',
	ActivityAchievementUnlocked: 'yJLy7HDLJT44C1fcm6lPI',
	PrimaryAchievement: '_26QliGU0MSP6WN4r-RtI5q',
	OneAchievementRow: '_3XupbOaQR2IshnGoougLm2',
	TwoAchievementRow: '_2pdPx3x3zdBcv4K2Wx9AlT',
	PartnerEvent: '_1AYE16384J_ecLpN0sEYc5',
	PartnerEventLargeUpdate: '_39Zk32AvV5cr6g-83IVRVS',
	LeftSideMajorUpdateBar: '_3oMUSjOFNB0E9LWcL2sE7',
	PartnerEventMediumImage_Container: '_1HZy7BvOZuPT8feUwadL4W',
	MediumImageContainer: 'ddB5GVHCwLezhshXUMCNL',
	PartnerEventMediumImage_Image: 'VytJzt3Z_t6332-n24Yrc',
	PartnerEventMediumImage_Contents: '_2gv3EsHSu5dMQyMqaz-W9t',
	PartnerEventMediumImage_TextColumn: '_3dJ4Bq6Msivz5-UIHzSEQu',
	PartnerEventMediumImage_Title: '_1gljEIuhbsQpFCWuVhdKTJ',
	PartnerEventMediumImage_Summary: 'Ru7OBQzSxqIo3jIsbtV9g',
	PartnerEventType: '_1ujzuoxGhLunHZQqHAqRgg',
	PartnerEventFeatured: '_3xi-HLpFVHaakihoqhQ_6C',
	PartnerEventLargeImage_Container: 'LibriMVXcLl1HB60ZUp78',
	PartnerEventLargeImage_Contents: '_2tDv0EeJIdDmZLyfUE63t1',
	ImageContainer: '_1XpBItdUymdlwPZzvvOnyW',
	PartnerEventLargeImage_Image: 'fGDsmh9vz8h0RMEoRoAvF',
	PartnerEventLargeImage_Title: '_3fsjzvni7TQ1NphLHM_5r3',
	PartnerEventLargeImage_Summary: '_3zwBRDW1egliiT4pKYIXap',
	PartnerEventLargeImage_TextColumn: '_2HzKE96Sc4z6KHN68gr4DS',
};

// The desktop "Say something..." post entry component's own CSS module
const POST_CLASSES_FALLBACK: CssClasses = {
	PostTextEntry: '_3x31AgESSlUqX3D4MTHv2m',
	PostTextEntryArea: '_1JlC29Ic6L-QvL-39X_d-X',
	Controls: '_37e7DrDNmf1FmsMGA5y0A0',
	Active: '_1_KMhJX-BZ-bohjsJ7i3w3',
	FormattingSpacer: '_33rj8CoAI3J6C0dO_aOwIS',
	EmoticonButton: 'bACIuqv-b_9TztCczFK19',
	PostButton: '_2JSyABqFEh-v_dwaTnBydR',
	Label: '_3jvEkfXhmZjvEbkpEv5EsH',
	Enabled: 'bGfjajFo4DI-ULSQxw1KY',
};

const ACH_CLASSES_FALLBACK: CssClasses = {
	AchievementHoverContainer: '_2CK1m9x0gtA_oSAQa2FpS3',
	Icon: 'zcasgBSVIteabq-j_3g1m',
	TextSection: '_1s_9cSxUjb4609MSH0EjWH',
	Name: '_39Y01uSRcLiDg5DneTTR0m',
	Desc: '_2gLHbXukQBdrIKhqEYVvOe',
	Featured: '_1j_gja8bHXjiS-BeSQk8hb',
	Achieved: 'MGoYUyIslJerluzgnU7z9',
	HighlightDiv: '_2xTb6N-jUUQ-mIkMB6OVMm',
	UnlockedLabel: '_3jC8om-5Sci_dkUB-6VYiU',
	UnlockedLabelPercent: '_14kZVEyaz7WX57N47z4Yr1',
	AchievementProgressContainer: '_3ns9185LizH61StaAXuAp6',
	AchievementProgress: '_3Rm36_oeAhvIg6ZYP9l1Jj',
	SingleAchievementProgressBar: '_1OIatPEED_bSmd_CNyMv7C',
};

function resolveClasses(predicate: (m: any) => boolean, fallback: CssClasses): CssClasses {
	try {
		const m = findClassModule(predicate) as CssClasses | undefined;
		if (m) return m;
	} catch {}
	return fallback;
}

let _feedClasses: CssClasses | null = null;
let _eventClasses: CssClasses | null = null;
let _achClasses: CssClasses | null = null;

const FEED_CLASSES = (): CssClasses =>
	(_feedClasses ||= resolveClasses(m => m.ActivityFeedContainer && m.FetchMoreContainer && m.ViewLastNews, FEED_CLASSES_FALLBACK));
const EVENT_CLASSES = (): CssClasses =>
	(_eventClasses ||= resolveClasses(m => m.AppActivityDay && m.EventHeadline && m.ActivityAchievementUnlocked, EVENT_CLASSES_FALLBACK));
const ACH_CLASSES = (): CssClasses =>
	(_achClasses ||= resolveClasses(m => m.AchievementHoverContainer && m.UnlockedLabel && m.SingleAchievementProgressBar, ACH_CLASSES_FALLBACK));

let _postClasses: CssClasses | null = null;
const POST_CLASSES = (): CssClasses =>
	(_postClasses ||= resolveClasses(m => m.PostTextEntryArea && m.EmoticonButton && m.PostButton, POST_CLASSES_FALLBACK));

// ── Achievement progress ────────────────────────────────────────────────
// Steam tracks per-app achievement progress for the logged-in user in
// appAchievementProgressCache - works for the LINKED appid when the user
// actually owns that game, so real progress (e.g. 18/29) shows up.

interface AchProgress { unlocked: number; total: number }

async function getAchievementProgress(appid: number, fallbackTotal: number): Promise<AchProgress | null> {
	try {
		const cache = (window as any).appAchievementProgressCache;
		const read = (): AchProgress | null => {
			try {
				const e = cache?.m_achievementProgress?.mapCache?.get?.(appid);
				return e && e.total > 0 ? { unlocked: e.unlocked || 0, total: e.total } : null;
			} catch { return null; }
		};
		let r = read();
		if (!r && cache?.QueueCacheUpdate) {
			try { cache.QueueCacheUpdate(appid); } catch {}
			for (let i = 0; i < 6 && !r; i++) {
				await new Promise(res => setTimeout(res, 500));
				r = read();
			}
		}
		if (r) {
			backendLog('Achievement progress for ' + appid + ': ' + r.unlocked + '/' + r.total);
			return r;
		}
	} catch (e) {
		backendLog('Achievement progress error: ' + e);
	}
	return fallbackTotal > 0 ? { unlocked: 0, total: fallbackTotal } : null;
}

/** Native percent formatting: (0%), (<1%), (>99%), (100%) */
function achievementPercentText(unlocked: number, total: number): string {
	const pct = Math.round((100 * unlocked) / total);
	if (pct === 0 && unlocked > 0) return '(<1%)';
	if (pct === 100 && unlocked < total) return '(>99%)';
	return `(${pct}%)`;
}

// ── Status posting (native "Say something..." box) ─────────────────────
// Mirrors the native flow: CPlayer_PostStatusToFriends_Request sent through
// the PlayerService client over the CM transport.

let _protoMsgCache: Map<string, any> | null = null;

function findProtoMsgClass(className: string): any {
	if (!_protoMsgCache) _protoMsgCache = new Map();
	if (_protoMsgCache.has(className)) return _protoMsgCache.get(className);
	let found: any = null;
	try {
		found = findModuleExport((m: any) => {
			try {
				return typeof m === 'function'
					&& typeof m.deserializeBinary === 'function'
					&& typeof m.prototype?.getClassName === 'function'
					&& new m().getClassName() === className;
			} catch { return false; }
		});
	} catch {}
	_protoMsgCache.set(className, found);
	return found;
}

let _msgWrapper: any = null;
let _playerService: any = null;

async function postStatusUpdate(appid: number, text: string): Promise<boolean> {
	try {
		if (!_msgWrapper) {
			_msgWrapper = findModuleExport((m: any) =>
				typeof m?.Init === 'function' && typeof m?.InitFromPacket === 'function' && typeof m?.InitFromObject === 'function');
		}
		if (!_playerService) {
			_playerService = findModuleExport((m: any) => typeof m?.PostStatusToFriends === 'function');
		}
		const MsgClass = findProtoMsgClass('CPlayer_PostStatusToFriends_Request');
		const transport = (window as any).appAchievementProgressCache?.m_CMInterface?.GetServiceTransport?.();
		if (!_msgWrapper || !_playerService || !MsgClass || !transport) {
			backendLog('Post status: missing internals (wrapper=' + !!_msgWrapper + ' service=' + !!_playerService + ' msg=' + !!MsgClass + ' transport=' + !!transport + ')');
			return false;
		}
		const msg = _msgWrapper.Init(MsgClass);
		msg.Body().set_appid(appid);
		msg.Body().set_status_text(text);
		const resp = await _playerService.PostStatusToFriends(transport, msg);
		const result = resp?.GetEResult?.();
		backendLog('PostStatusToFriends result: ' + result);
		return result === undefined || result === 1;
	} catch (e) {
		backendLog('Post status error: ' + e);
		return false;
	}
}

/** Sidebar achievements panel body - mirrors the native HighlightDiv structure */
function renderAchievementsPanel(unlocked: number, total: number): string {
	const c = ACH_CLASSES();
	const pct = Math.round((100 * unlocked) / total);
	const token = unlocked >= total ? 'AppDetails_PlayerUnlockedPercentAll' : 'AppDetails_PlayerUnlockedPercent';
	const text = loc(token, "You've unlocked %1$s/%2$s")
		.replace('%1$s', String(unlocked))
		.replace('%2$s', String(total));
	// Explicit font-size required: the sidebar section chain zeroes inherited
	// font-size, which invisibly collapsed this label in earlier builds
	return `<div class="${c.HighlightDiv}">
		<div class="${c.UnlockedLabel}" style="font-size:13px;line-height:18px;"><span>${escapeHtml(text)}</span><span class="${c.UnlockedLabelPercent}"> ${achievementPercentText(unlocked, total)}</span></div>
		<div class="${c.AchievementProgressContainer}"><div class="${c.AchievementProgress}" style="width:${pct}%;"></div></div>
	</div>`;
}

const GDL_PROP = 'gdl-properties-injected';

/** Find an element by its visible text content (case-insensitive, partial match) */
function findElementByText(root: Element | Document, text: string): Element | null {
	const ownerDoc = root instanceof Document ? root : (root.ownerDocument || document);
	const startNode = root instanceof Document ? (root.body || root.documentElement) : root;
	if (!startNode) return null;
	const walker = ownerDoc.createTreeWalker(startNode, NodeFilter.SHOW_TEXT, null);
	const lowerText = text.toLowerCase();
	let node: Text | null;
	while ((node = walker.nextNode() as Text | null)) {
		if (node.textContent && node.textContent.trim().toLowerCase().includes(lowerText)) {
			return node.parentElement;
		}
	}
	return null;
}

/** Find an element by its exact trimmed text content */
function findElementByExactText(root: Element | Document, text: string): Element | null {
	const ownerDoc = root instanceof Document ? root : (root.ownerDocument || document);
	const startNode = root instanceof Document ? (root.body || root.documentElement) : root;
	if (!startNode) return null;
	const walker = ownerDoc.createTreeWalker(startNode, NodeFilter.SHOW_TEXT, null);
	let node: Text | null;
	while ((node = walker.nextNode() as Text | null)) {
		if (node.textContent && node.textContent.trim() === text) {
			return node.parentElement;
		}
	}
	return null;
}

// â”€â”€ 1. PROPERTIES WINDOW â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Uses the GAME TITLE as the mapping key â€” this is always available in
// the Properties dialog header. No need to find an obscure appId.

function tryInjectPropertiesField(doc: Document, popupTitle: string): void {
	if (doc.querySelector(`.${GDL_PROP}`)) return;

	// Confirm we're on the Shortcut tab (localized - labels change with Steam language).
	// "Launch Options"/"Target" use exact matching: as substrings they show up
	// inside ordinary page text (news, reviews) and cause false positives.
	const vrLibEl = findElementByText(doc, loc('AppProperties_Shortcut_InVR', 'Include in VR Library'));
	const launchOptsEl = findElementByExactText(doc, loc('AppProperties_LaunchOptionsSection', 'Launch Options'));
	const targetEl = findElementByExactText(doc, loc('AppProperties_Shortcut_TargetExecutable', 'Target'));
	const anchor = vrLibEl || launchOptsEl || targetEl;
	if (!anchor) return;

	// Walk up to scrollable container
	let container: Element | null = anchor;
	for (let i = 0; i < 15; i++) {
		if (!container.parentElement) break;
		container = container.parentElement;
		const style = (container.ownerDocument.defaultView || window).getComputedStyle(container);
		if (style.overflowY === 'auto' || style.overflowY === 'scroll') break;
	}
	if (!container) return;

	// ── Extract game title ─────────────────────────────────────────────
	let gameTitle: string | null = null;

	// Window title template is localized, e.g. "Properties - %1$s" / "Eigenschaften: %1$s"
	const propsTitleRx = templateToRegex(loc('AppProperties_Title', 'Properties - %1$s'), true);
	const extractTitle = (raw: string | null | undefined): string | null => {
		const t = raw?.trim();
		if (!t || t === 'Steam') return null;
		const m = propsTitleRx ? t.match(propsTitleRx) : null;
		if (m && m[1]) return m[1].trim();
		if (/properties/i.test(t)) return null;
		return t;
	};

	// 1. Popup title - for Properties windows this is typically the game name
	gameTitle = extractTitle(popupTitle);

	// 2. Document title
	if (!gameTitle) gameTitle = extractTitle(doc.title);

	// 3. Search the dialog for the game name header text
	// The game name appears above the tabs (Shortcut, Controller, etc.)
	if (!gameTitle) {
		const tabNames = [
			loc('AppProperties_ShortcutPage', 'Shortcut'),
			loc('AppProperties_ControllerPage', 'Controller'),
			loc('AppProperties_GameRecording', 'Game Recording'),
			loc('AppProperties_Customization', 'Customization'),
		];
		const shortcutTab = findElementByText(doc, tabNames[0]);
		if (shortcutTab) {
			let nav = shortcutTab.parentElement;
			if (nav?.parentElement) {
				const tw = doc.createTreeWalker(nav.parentElement, NodeFilter.SHOW_TEXT, null);
				let textNode: Text | null;
				while ((textNode = tw.nextNode() as Text | null)) {
					const t = textNode.textContent?.trim();
					if (t && t.length > 1 && !tabNames.includes(t)) {
						gameTitle = t;
						break;
					}
				}
			}
		}
	}

	backendLog('Properties detected â€” gameTitle: ' + gameTitle + ', popupTitle: ' + popupTitle);

	if (!gameTitle) return;

	const titleKey = normalizeTitle(gameTitle);
	const currentLinked = findMappingForTitle(gameTitle) || '';

	// Build UI section
	const section = doc.createElement('div');
	section.className = GDL_PROP;
	section.style.cssText = 'padding: 20px 24px; margin-top: 16px; border-top: 1px solid rgba(255,255,255,0.08);';

	section.innerHTML = `
		<div style="font-size: 12px; font-weight: 500; color: #8f98a0; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px;">
			Linked Steam AppID
		</div>
		<div style="font-size: 11px; color: #6c7580; margin-bottom: 12px;">
			Enter a Steam AppID or store page link to display that game's info on this game's library page.
		</div>
		<div style="display: flex; gap: 8px; align-items: center;">
			<input class="gdl-appid-input" type="text" placeholder="e.g. 2947440 or store link"
				value="${escapeHtml(currentLinked)}"
				style="flex:1; padding:8px 12px; background:rgba(0,0,0,0.25); border:1px solid rgba(255,255,255,0.1); border-radius:3px; color:#dcdedf; font-size:13px; outline:none;" />
			<button class="gdl-save-btn" style="padding:8px 18px; background:#1a9fff; border:none; border-radius:3px; color:#fff; font-size:12px; font-weight:500; cursor:pointer; white-space:nowrap;">Save</button>
			<button class="gdl-clear-btn" style="padding:8px 14px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.06); border-radius:3px; color:#8f98a0; font-size:12px; cursor:pointer; white-space:nowrap;">Clear</button>
		</div>
		<div class="gdl-status" style="font-size: 11px; color: #8f98a0; margin-top: 8px; min-height: 16px;"></div>
	`;

	container.appendChild(section);

	const input = section.querySelector('.gdl-appid-input') as HTMLInputElement;
	const saveBtn = section.querySelector('.gdl-save-btn') as HTMLButtonElement;
	const clearBtn = section.querySelector('.gdl-clear-btn') as HTMLButtonElement;
	const statusEl = section.querySelector('.gdl-status') as HTMLElement;

	if (saveBtn && input && statusEl) {
		saveBtn.addEventListener('click', async () => {
			let val = input.value.trim();
			if (!val) { statusEl.textContent = 'Please enter an AppID or store link.'; return; }
			// Accept store/community links (e.g. https://store.steampowered.com/app/2947440/Name/)
			const urlMatch = val.match(/(?:store\.steampowered\.com|steamcommunity\.com|steamdb\.info)\/app\/(\d+)/i)
				|| val.match(/s\.team\/a\/(\d+)/i);
			if (urlMatch) {
				val = urlMatch[1];
				input.value = val;
			}
			if (!/^\d+$/.test(val)) { statusEl.textContent = 'Enter a numeric AppID or a store page link.'; return; }

			statusEl.textContent = 'Verifying on Steam...';
			statusEl.style.color = '#8f98a0';

			const data = await getGameData(val);
			if (!data) {
				statusEl.textContent = `AppID ${val} not found on Steam.`;
				statusEl.style.color = '#ff6b6b';
				return;
			}

			try {
				await saveMappingBackend({ non_steam_id: titleKey, steam_id: val });
				mappings[titleKey] = val;
				statusEl.textContent = `âœ“ Linked to "${data.name}". Setting artwork...`;
				statusEl.style.color = '#5ba32b';

				// Immediately set all artwork for this game
				const shortcutId = findShortcutAppIdByName(titleKey);
				if (shortcutId) {
					spoofArtwork(shortcutId, val, true).then(() => {
						statusEl.textContent = `âœ“ Linked to "${data.name}". All artwork saved.`;
					}).catch(() => {
						statusEl.textContent = `âœ“ Linked to "${data.name}". Some artwork may not have been set.`;
					});
				} else {
					statusEl.textContent = `âœ“ Linked to "${data.name}". Navigate to the game's library page to apply artwork.`;
				}

				// Auto-refresh the library page if it's currently showing this game
				if (mainWindowDoc) {
					currentInjectedAppId = null;
					cleanupInjection(mainWindowDoc);
					tryInjectLibraryData(mainWindowDoc);
				}
			} catch (e) {
				statusEl.textContent = 'Failed to save.';
				statusEl.style.color = '#ff6b6b';
				backendLog('Save error: ' + e);
			}
		});
	}

	if (clearBtn && input && statusEl) {
		clearBtn.addEventListener('click', async () => {
			try {
				await removeMappingBackend({ non_steam_id: titleKey });
				delete mappings[titleKey];
				input.value = '';
				statusEl.textContent = 'Mapping cleared.';
				statusEl.style.color = '#8f98a0';
				// Clear artwork persistence marker so it can be re-applied later
				const shortcutId = findShortcutAppIdByName(titleKey);
				if (shortcutId) {
					clearArtworkSaved(shortcutId);
					// Clear all 4 artwork types via Steam API (must call on object to preserve IPC binding)
					const apps = (window as any).SteamClient?.Apps;
					if (typeof apps?.ClearCustomArtworkForApp === 'function') {
						for (let t = 0; t < 4; t++) apps.ClearCustomArtworkForApp(shortcutId, t);
					}
				}
				// Auto-refresh the library page to remove injected content
				if (mainWindowDoc) {
					currentInjectedAppId = null;
					cleanupInjection(mainWindowDoc);
				}
			} catch (e) {
				statusEl.textContent = 'Failed to clear.';
				statusEl.style.color = '#ff6b6b';
			}
		});
	}
}

// ── 2. LIBRARY PAGE - DOM INJECTION ────────────────────────────────────
// Replicate the native Steam library page layout exactly.
// SetCustomArtworkForApp handles hero/logo/grid; DOM injection handles content.

const GDL_INJECTED = 'gdl-game-data';
const fetchNewsBackend = callable<[{ steam_app_id: string }], string>('fetch_news');
const fetchPartnerEventsBackend = callable<[{ steam_app_id: string; language: string }], string>('fetch_partner_events');
const fetchPublishedPreviewsBackend = callable<[{ file_ids_csv: string }], string>('fetch_published_file_previews');
const fetchFriendReviewBackend = callable<[{ steam_id64: string; steam_app_id: string }], string>('fetch_friend_review');

interface NewsItem {
	gid: string;
	title: string;
	url: string;
	contents: string;
	date: number;
	feedlabel?: string;
	feed_type?: number;
	event_type?: number;
	image?: string;
}

/** Steam UI language name (e.g. 'english', 'german') for store API calls */
const LOCALE_TO_STEAM_LANG: Record<string, string> = {
	en: 'english', de: 'german', fr: 'french', it: 'italian', ko: 'koreana',
	es: 'spanish', 'es-419': 'latam', 'zh-cn': 'schinese', 'zh-tw': 'tchinese',
	ru: 'russian', th: 'thai', ja: 'japanese', pt: 'portuguese', 'pt-br': 'brazilian',
	pl: 'polish', da: 'danish', nl: 'dutch', fi: 'finnish', no: 'norwegian',
	sv: 'swedish', hu: 'hungarian', cs: 'czech', ro: 'romanian', tr: 'turkish',
	ar: 'arabic', bg: 'bulgarian', el: 'greek', uk: 'ukrainian', vi: 'vietnamese',
	id: 'indonesian',
};

// Fingerprint table: the localized value of AppDetails_SectionTitle_Achievements
// identifies the UI language (ambiguous values resolved via the Friends title).
// This works even when client APIs don't, because the localization tokens are
// by definition loaded in the user's language.
const LANG_FINGERPRINT: Record<string, string> = {
	'الإنجازات': 'arabic', 'Conquistas': 'brazilian', 'Постижения': 'bulgarian',
	'Achievementy': 'czech', 'Præstationer': 'danish', 'Prestaties': 'dutch',
	'Achievements': 'english', 'Saavutukset': 'finnish', 'Succès': 'french',
	'Errungenschaften': 'german', 'Επιτεύγματα': 'greek', 'Teljesítmények': 'hungarian',
	'Achievement': 'italian', '実績': 'japanese', '도전 과제': 'koreana',
	'Prestasjoner': 'norwegian', 'Osiągnięcia': 'polish', 'Proezas': 'portuguese',
	'Realizări': 'romanian', 'Достижения': 'russian', 'Prestationer': 'swedish',
	'รางวัลความสำเร็จ': 'thai', 'Başarımlar': 'turkish', 'Досягнення': 'ukrainian',
	'Thành tựu': 'vietnamese',
};
const LANG_TIEBREAK: Record<string, Record<string, string>> = {
	'Logros': { 'Amigos que juegan a este juego': 'spanish', 'Amigos que juegan': 'latam' },
	'成就': { '玩过的好友': 'schinese', '遊玩過的好友': 'tchinese' },
	'Pencapaian': { 'Teman yang bermain': 'indonesian', 'Rakan yang bermain': 'malay' },
};

let _steamLanguage: string | null = null;

/** Synchronous access to the detected language (null until first detection) */
function steamLanguageSync(): string | null {
	return _steamLanguage;
}

async function getSteamLanguage(): Promise<string> {
	if (_steamLanguage) return _steamLanguage;
	let lang = '';

	// 1. Ask the client directly
	try {
		const sc = (window as any).SteamClient;
		if (typeof sc?.Settings?.GetCurrentLanguage === 'function') {
			const l = await sc.Settings.GetCurrentLanguage();
			if (typeof l === 'string' && /^[a-z_]+$/.test(l)) lang = l;
		}
	} catch {}

	// 2. Fingerprint the loaded localization tokens
	if (!lang) {
		const ach = loc('AppDetails_SectionTitle_Achievements', '');
		if (ach) {
			const tie = LANG_TIEBREAK[ach];
			if (tie) {
				lang = tie[loc('AppDetails_SectionTitle_Friends', '')] || Object.values(tie)[0];
			} else {
				lang = LANG_FINGERPRINT[ach] || '';
			}
		}
	}

	// 3. Browser locale mapping
	if (!lang) {
		try {
			const locales: string[] = (window as any).LocalizationManager?.m_rgLocalesToUse || [];
			for (const raw of locales) {
				const lc = String(raw).toLowerCase();
				if (LOCALE_TO_STEAM_LANG[lc]) { lang = LOCALE_TO_STEAM_LANG[lc]; break; }
				const base = lc.split('-')[0];
				if (LOCALE_TO_STEAM_LANG[base]) { lang = LOCALE_TO_STEAM_LANG[base]; break; }
			}
		} catch {}
	}

	if (lang) {
		_steamLanguage = lang;
		backendLog('Steam language detected: ' + lang);
		return lang;
	}
	// Last resort: not memoized, so a later call can still detect properly
	return 'english';
}

/** Human label for a partner event type (uppercased by the native class) */
function eventTypeLabel(t: number): string {
	switch (t) {
		case 10: return 'Game Release';
		case 12: return loc('AppActivity_EventType_GameUpdate', 'Game Update');
		case 13: case 14: return loc('MajorUpdate_Type14', 'Major Update');
		case 15: return 'DLC Release';
		case 20: case 21: return 'Sale';
		case 22: case 23: case 24: case 25: case 26: case 35: return 'In-Game Event';
		case 28: return 'News';
		case 29: return 'Beta Release';
		case 30: return 'Content Release';
		case 31: return 'Free Trial';
		case 32: return 'Season Release';
		default: return 'Community Announcements';
	}
}

async function getCommunityContent(steamAppId: string): Promise<CommunityContentItem[]> {
	// v2: v1 entries carry off-by-one links from the old card parser
	const cached = cacheGet<CommunityContentItem[]>('community3_' + steamAppId);
	if (cached) return cached;
	try {
		const json = await fetchCommunityContentBackend({ steam_app_id: steamAppId });
		const parsed = JSON.parse(json);
		const items = parsed.items || [];
		if (items.length > 0) cacheSet('community3_' + steamAppId, items);
		return items;
	} catch (e) {
		backendLog('Community content fetch error: ' + e);
		return [];
	}
}

async function getNews(steamAppId: string): Promise<NewsItem[]> {
	// Cache is per-language: switching the Steam language must refetch
	// instead of serving the old language for 24h
	const lang = await getSteamLanguage();
	const cacheKey = 'events4_' + lang + '_' + steamAppId;
	const cached = cacheGet<NewsItem[]>(cacheKey);
	if (cached) return cached;

	// Primary source: partner events - same source the native page uses,
	// with per-event cover images, event types, and the user's language
	try {
		const json = await fetchPartnerEventsBackend({ steam_app_id: steamAppId, language: lang });
		const parsed = JSON.parse(json);
		if (Array.isArray(parsed.items) && parsed.items.length > 0) {
			const items: NewsItem[] = parsed.items.map((e: any) => ({
				gid: String(e.gid || ''),
				title: e.title || '',
				url: `https://store.steampowered.com/news/app/${steamAppId}/view/${e.gid || ''}`,
				contents: e.contents || '',
				date: e.date || 0,
				event_type: e.event_type || 0,
				image: e.image || '',
			}));
			cacheSet(cacheKey, items);
			return items;
		}
		backendLog('Partner events empty for ' + steamAppId + ', falling back to news feed');
	} catch (e) {
		backendLog('Partner events fetch error: ' + e);
	}

	// Fallback: classic GetNewsForApp feed
	try {
		const json = await fetchNewsBackend({ steam_app_id: steamAppId });
		const parsed = JSON.parse(json);
		if (parsed.error || !parsed.items) {
			backendLog('News result: ' + json.substring(0, 200));
			return [];
		}
		// Deliberately NOT cached: a transient partner-events failure should
		// retry next visit instead of pinning the fallback for 24h
		return parsed.items;
	} catch (e) {
		backendLog('News fetch error: ' + e);
		return [];
	}
}

function formatNewsDate(ts: number): string {
	// Native date headers are uppercased by their CSS class; use the client locale
	return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
}

function groupNewsByDate(items: NewsItem[]): { date: string; items: NewsItem[] }[] {
	const groups: { date: string; items: NewsItem[] }[] = [];
	const map = new Map<string, NewsItem[]>();
	for (const item of items) {
		const label = formatNewsDate(item.date);
		if (!map.has(label)) {
			map.set(label, []);
			groups.push({ date: label, items: map.get(label)! });
		}
		map.get(label)!.push(item);
	}
	return groups;
}

function stripTags(str: string): string {
	return str
		.replace(/\[\/?\w+[^\]]*\]/g, '')
		.replace(/<[^>]+>/g, '')
		.replace(/\{STEAM_CLAN_IMAGE\}[^\s]*/g, '')
		.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
		.trim();
}

/** Find a non-Steam shortcut's internal app ID by display name.
 *  Non-Steam shortcuts have appid > 2^31 (e.g. 3814912052). */
function findShortcutAppIdByName(title: string): number | null {
	const appStore = (window as any).appStore;
	if (!appStore?.m_mapApps) return null;
	const normalized = normalizeTitle(title);
	const SHORTCUT_THRESHOLD = 2147483648; // 2^31
	for (const [id, app] of appStore.m_mapApps) {
		const numId = parseInt(id, 10);
		if (numId < SHORTCUT_THRESHOLD) continue; // skip real games
		const name = app?.display_name || app?.m_strDisplayName || '';
		if (name && normalizeTitle(name) === normalized) {
			return numId;
		}
	}
	return null;
}

/** Fetch an image URL and return as base64 data URL string */
async function imageUrlToBase64(url: string): Promise<string | null> {
	try {
		const resp = await fetch(url);
		if (!resp.ok) return null;
		const blob = await resp.blob();
		return new Promise((resolve) => {
			const reader = new FileReader();
			reader.onloadend = () => resolve(reader.result as string || null);
			reader.onerror = () => resolve(null);
			reader.readAsDataURL(blob);
		});
	} catch { return null; }
}

/** Artwork persistence key prefix in localStorage (v3 = uses file extension not mime type) */
const ART_STORAGE_PREFIX = 'gdl_artwork4_';

function artworkAlreadySaved(shortcutAppId: number, steamAppId: string): boolean {
	try {
		return localStorage.getItem(ART_STORAGE_PREFIX + shortcutAppId) === steamAppId;
	} catch { return false; }
}

function markArtworkSaved(shortcutAppId: number, steamAppId: string): void {
	try { localStorage.setItem(ART_STORAGE_PREFIX + shortcutAppId, steamAppId); } catch {}
}

/** Clear saved artwork marker (when mapping is removed) */
function clearArtworkSaved(shortcutAppId: number): void {
	try { localStorage.removeItem(ART_STORAGE_PREFIX + shortcutAppId); } catch {}
}

/** Set ALL artwork for a shortcut using SetCustomArtworkForApp.
 *  Signature: SteamClient.Apps.SetCustomArtworkForApp(appId, base64Data, fileExtension, imageType)
 *  The extension param is a FILE EXTENSION like ".jpg" or ".png" (not a MIME type).
 *  IMPORTANT: Must call directly on the SteamClient.Apps object - extracting the function
 *  breaks Steam's IPC proxy and produces "Unknown method" errors. */
const artworkSpoofed = new Set<string>();
async function spoofArtwork(shortcutAppId: number, steamAppId: string, force = false): Promise<void> {
	const key = shortcutAppId + ':' + steamAppId;
	if (!force && artworkSpoofed.has(key)) return;

	// Skip if artwork was already downloaded and saved for this exact pairing
	if (!force && artworkAlreadySaved(shortcutAppId, steamAppId)) {
		artworkSpoofed.add(key);
		backendLog('Artwork already saved for ' + shortcutAppId + ' -> ' + steamAppId);
		return;
	}
	artworkSpoofed.add(key);

	const sc = (window as any).SteamClient;
	if (typeof sc?.Apps?.SetCustomArtworkForApp !== 'function') {
		backendLog('SetCustomArtworkForApp not available');
		return;
	}

	const cdnBase = `https://cdn.akamai.steamstatic.com/steam/apps/${steamAppId}`;
	// [url, imageType, label]
	const sources: [string, number, string][] = [
		[`${cdnBase}/library_600x900.jpg`, 0, 'Portrait Grid'],
		[`${cdnBase}/library_hero.jpg`, 1, 'Hero'],
		[`${cdnBase}/logo.png`, 2, 'Logo'],
		[`${cdnBase}/header.jpg`, 3, 'Wide Capsule'],
	];

	// Extension map WITHOUT dots - Steam API expects 'png'/'jpg', not '.png'/'.jpg'
	const extMap: Record<string, string> = { '.jpg': 'jpg', '.jpeg': 'jpg', '.png': 'png' };

	// Download all images in parallel
	const downloads = await Promise.all(
		sources.map(async ([url, imageType, label]) => {
			try {
				const dataUrl = await imageUrlToBase64(url);
				return { url, dataUrl, imageType, label };
			} catch { return { url, dataUrl: null, imageType, label }; }
		})
	);

	let successCount = 0;
	for (const { url, dataUrl, imageType, label } of downloads) {
		if (!dataUrl) {
			backendLog('Artwork not available: ' + label + ' for ' + steamAppId);
			continue;
		}
		try {
			// Parse data URL: "data:image/jpeg;base64,/9j/4AAQ..."
			const commaIdx = dataUrl.indexOf(',');
			const base64Data = dataUrl.substring(commaIdx + 1);

			const rawExt = url.substring(url.lastIndexOf('.')).toLowerCase();
			const ext = extMap[rawExt] || 'jpg';

			backendLog('Artwork download: ' + label + ' ext=' + ext + ' b64len=' + base64Data.length + ' first20=' + base64Data.substring(0, 20));

			// Clear existing artwork first, then set new (matches decky-steamgriddb pattern)
			try { await sc.Apps.ClearCustomArtworkForApp(shortcutAppId, imageType); } catch {}
			await new Promise(r => setTimeout(r, 200));

			const result = await sc.Apps.SetCustomArtworkForApp(shortcutAppId, base64Data, ext, imageType);
			successCount++;
			backendLog('Artwork set: ' + label + ' (type ' + imageType + ') for ' + shortcutAppId + ' result=' + JSON.stringify(result));
		} catch (e) {
			backendLog('Artwork error (' + label + '): ' + e);
		}
	}

	if (successCount > 0) {
		markArtworkSaved(shortcutAppId, steamAppId);
		backendLog('Applied ' + successCount + '/4 artwork images for ' + steamAppId);
	}
}





/** Use SteamClient.Apps.GetFriendsWhoPlay to get the list of friend SteamIDs */
async function getFriendData(steamAppId: string): Promise<{ html: string; data: FriendCategories | null }> {
	const cachedFriends = cacheGet<FriendCategories>('friends_' + steamAppId);
	if (cachedFriends) return { html: '', data: cachedFriends };
	const sc = (window as any).SteamClient;
	if (!sc?.Apps?.GetFriendsWhoPlay) return { html: '', data: null };

	try {
		// ── Explore available SteamClient APIs for richer friend data ──
		const enumMethods = (obj: any, prefix: string) => {
			try {
				const proto = Object.getPrototypeOf(obj);
				const names = new Set([...Object.getOwnPropertyNames(obj), ...(proto ? Object.getOwnPropertyNames(proto) : [])]);
				const relevant = [...names].filter(k => /friend|play|social|recent|wishlist/i.test(k));
				if (relevant.length > 0) backendLog(prefix + ' relevant methods: ' + relevant.join(', '));
			} catch (_) {}
		};
		enumMethods(sc.Apps, 'SteamClient.Apps');
		for (const ns of ['Friends', 'Social', 'User', 'GameSessions', 'PlayerClient', 'Community']) {
			if (sc[ns]) {
				enumMethods(sc[ns], 'SteamClient.' + ns);
			}
		}

		const result = await sc.Apps.GetFriendsWhoPlay(parseInt(steamAppId));
		backendLog('GetFriendsWhoPlay raw type: ' + typeof result + ', isArray: ' + Array.isArray(result));
		if (result && typeof result === 'object') {
			backendLog('GetFriendsWhoPlay keys: ' + Object.keys(result).slice(0, 20).join(','));
			if (Array.isArray(result) && result.length > 0) {
				backendLog('First item type: ' + typeof result[0] + (typeof result[0] === 'object' ? ', keys: ' + Object.keys(result[0]).join(',') : ', val: ' + String(result[0])));
			}
		}

		const tryParseFriends = (arr: any[]): FriendPlayInfo[] =>
			arr.map((f: any) => ({
				steamid: String(f.steamid || f.m_steamid || f.accountid || f),
				minutes_played: f.minutes_played || f.m_nMinutesPlayed || f.minutesPlayed || f.minutes_played_forever || 0,
				minutes_played_recently: f.minutes_played_recently || f.m_nMinutesPlayedRecently || f.minutesPlayedRecently || 0,
			}));

		let friends: FriendPlayInfo[] = [];

		if (Array.isArray(result)) {
			if (result.length > 0 && typeof result[0] === 'object' && result[0] !== null) {
				friends = tryParseFriends(result);
			} else {
				friends = result.map(v => ({ steamid: String(v), minutes_played: 0, minutes_played_recently: 0 }));
			}
		} else if (result && typeof result === 'object') {
			const friendsArr = result.friends || result.rgFriends || result.m_rgFriends;
			if (Array.isArray(friendsArr)) {
				friends = tryParseFriends(friendsArr);
			} else {
				friends = Object.values(result).filter(Boolean).map((v: any) => ({
					steamid: String(v), minutes_played: 0, minutes_played_recently: 0,
				}));
			}
		}

		// Split into recently played vs previously played
		const hasPlayTime = friends.some(f => f.minutes_played_recently > 0);
		let recentlyPlayed: FriendPlayInfo[];
		let previouslyPlayed: FriendPlayInfo[];

		if (hasPlayTime) {
			recentlyPlayed = friends.filter(f => f.minutes_played_recently > 0)
				.sort((a, b) => b.minutes_played_recently - a.minutes_played_recently);
			previouslyPlayed = friends.filter(f => f.minutes_played_recently === 0);
		} else {
			recentlyPlayed = [];
			previouslyPlayed = friends;
		}

		backendLog('Friends parsed: ' + friends.length + ' total, ' + recentlyPlayed.length + ' recent, ' + previouslyPlayed.length + ' previous');

		const friendResult = { recentlyPlayed, previouslyPlayed, totalCount: friends.length };
		if (friends.length > 0) cacheSet('friends_' + steamAppId, friendResult);
		return {
			html: '',
			data: friendResult
		};
	} catch (e) {
		backendLog('GetFriendsWhoPlay error: ' + e);
		return { html: '', data: null };
	}
}

// ── Real activity feed via Steam's own appActivityStore ────────────────
// appActivityStore.GetAppActivity(appid) restores cached activity and fetches
// friend news (achievement unlocks etc.) from Steam's GetUserNews service -
// this works for the LINKED appid, so the fake page shows the real feed.

async function getRealActivity(appid: number): Promise<any | null> {
	try {
		const store = (window as any).appActivityStore;
		if (!store?.GetAppActivity) return null;
		let activity = store.GetAppActivity(appid); // undefined on first call; triggers restore
		for (let i = 0; i < 12 && !activity; i++) {
			await new Promise(r => setTimeout(r, 400));
			activity = store.GetAppActivity(appid);
		}
		if (!activity) {
			backendLog('No activity object for appid ' + appid);
			return null;
		}
		return activity;
	} catch (e) {
		backendLog('Activity store error: ' + e);
		return null;
	}
}

/** Achievement icon URLs in activity events may be bare filenames */
function achievementIconUrl(icon: string, appid: string): string {
	if (!icon) return '';
	if (/^https?:\/\//.test(icon)) return icon;
	return `https://cdn.steamstatic.com/steamcommunity/public/images/apps/${appid}/${icon}`;
}

/** One achievement card, using native classes (icon + optional name/description) */
function renderAchievementCard(a: any, featured: boolean, appid: string): string {
	if (!a) return '';
	const c = ACH_CLASSES();
	const icon = achievementIconUrl(a.strImage || '', appid);
	return `<div class="${c.Achieved}${featured ? ' ' + c.Featured : ''}" style="display:flex;align-items:center;min-width:0;">
		<div class="${c.AchievementHoverContainer}" style="flex-shrink:0;">
			<img class="${c.Icon}" src="${escapeHtml(icon)}" style="display:block;width:64px;height:64px;" onerror="this.style.display='none'" />
		</div>
		${featured ? `<div class="${c.TextSection}">
			<div class="${c.Name}">${escapeHtml(a.strName || '')}</div>
			<div class="${c.Desc}">${escapeHtml(a.strDescription || '')}</div>
		</div>` : ''}
	</div>`;
}

// EUserNewsType values (extracted from Steam's own enum)
const NEWS_TYPE = {
	AchievementUnlocked: 2,
	ReceivedNewGame: 3,
	AddedGameToWishlist: 9,
	RecommendedGame: 10,
	Screenshot: 13,
	Video: 14,
	UserStatus: 16,
	ScreenshotTagged: 21,
	Art: 22,
	PlayedGameFirstTime: 30,
};
const RENDERABLE_EVENT_TYPES = new Set(Object.values(NEWS_TYPE));
const SCREENSHOT_TYPES = new Set([NEWS_TYPE.Screenshot, NEWS_TYPE.ScreenshotTagged, NEWS_TYPE.Art]);

const REVIEW_THUMB_UP = 'https://community.akamai.steamstatic.com/public/shared/images/userreviews/icon_thumbsUp_v6.png';
const REVIEW_THUMB_DOWN = 'https://community.akamai.steamstatic.com/public/shared/images/userreviews/icon_thumbsDown_v6.png';

function eventActorId(event: any): string {
	try { return event.steamIDActor?.ConvertTo64BitString?.() || ''; } catch { return ''; }
}

/** Substitute %1$s with the game name wrapped in the native white game-name span */
function verbWithGameName(template: string, gameName: string): string {
	const parts = template.split('%1$s');
	if (parts.length < 2) return escapeHtml(template);
	return escapeHtml(parts[0])
		+ `<span class="${EVENT_CLASSES().HeadlineGameName}">${escapeHtml(gameName)}</span>`
		+ escapeHtml(parts.slice(1).join('%1$s'));
}

/** Common event frame: avatar + "<name> <verb>" headline, then the body */
function renderEventShell(event: any, verbHtml: string, bodyHtml: string): string {
	const ev = EVENT_CLASSES();
	const sid64 = eventActorId(event);
	const p = sid64 ? personaCache.get(sid64) : undefined;
	const name = p?.name || 'A friend';
	const avatar = p?.avatar || DEFAULT_AVATAR;
	return `<div class="${ev.Event}">
		<div class="${ev.EventHeadline}">
			<a href="steam://url/SteamIDPage/${sid64}"><img class="${ev.EventActorAvatar}" src="${escapeHtml(avatar)}" onerror="this.src='${DEFAULT_AVATAR}'" /></a>
			<div class="${ev.SpanEvent}"><a class="${ev.ActorName}" href="steam://url/SteamIDPage/${sid64}" style="color:#fff;text-decoration:none;cursor:pointer;">${escapeHtml(name)}</a><span>${verbHtml}</span></div>
		</div>
		${bodyHtml}
	</div>`;
}

/** Achievement unlock event (featured card + extra icon cards) */
function renderAchievementEvent(event: any, appid: string): string {
	const achs: any[] = event.achievements || [];
	if (achs.length === 0) return '';
	const primary = renderAchievementCard(achs[0], true, appid);
	const rest = achs.slice(1, 7).map(a => renderAchievementCard(a, false, appid)).join('');
	const body = `<div class="${EVENT_CLASSES().EventBody}">
		<div style="padding:12px;display:flex;flex-direction:column;gap:8px;">
			${primary}
			${rest ? `<div style="display:flex;flex-wrap:wrap;gap:8px;">${rest}</div>` : ''}
		</div>
	</div>`;
	return renderEventShell(event, escapeHtml(loc('AppActivity_Achieved', ' achieved')), body);
}

/** Shared screenshots/videos: large active image + swappable thumbnails */
function renderScreenshotEvent(event: any, previews: Map<string, string>, isVideo: boolean): string {
	const ids: string[] = (event.publishedfileids || []).map(String);
	const imgs = ids.map(id => ({ id, img: previews.get(id) || '' })).filter(x => x.img);
	if (imgs.length === 0) return '';

	const count = ids.length;
	const verb = isVideo
		? (count === 1
			? loc('AppActivity_PostedVideo', ' shared a video')
			: loc('AppActivity_PostedVideo_Plural', ' shared %1$s videos').replace('%1$s', String(count)))
		: (count === 1
			? loc('AppActivity_PostedScreenshot', ' shared a screenshot')
			: loc('AppActivity_PostedScreenshot_Plural', ' shared %1$s screenshots').replace('%1$s', String(count)));

	const uid = 'gdlss' + String(event.unUniqueID || Math.floor(Math.random() * 1e9));
	const fileUrl = (id: string) => `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`;
	const main = imgs[0];
	const thumbs = imgs.slice(1, 5);
	const ts = event.rtEventTime || 0;
	const uploaded = ts
		? 'Uploaded: ' + new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
			+ ' at ' + new Date(ts * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
		: '';

	// Clicking a thumb swaps it with the main image (src + target url)
	const swap = `var m=document.getElementById('${uid}-main'),l=document.getElementById('${uid}-link');`
		+ `if(m&&l){var s=m.src,u=l.getAttribute('href');m.src=this.src;l.setAttribute('href',this.getAttribute('data-url'));this.src=s;this.setAttribute('data-url',u);}`
		+ `event.stopPropagation();`;

	const body = `<div class="${EVENT_CLASSES().EventBody}">
		<div style="padding:12px;">
			<div style="display:flex;gap:8px;align-items:flex-start;">
				<a id="${uid}-link" href="${fileUrl(main.id)}" onclick="window.gdlOpen(this.getAttribute('href'));return false;" style="flex:0 1 ${thumbs.length ? '56%' : '80%'};min-width:0;">
					<img id="${uid}-main" src="${escapeHtml(main.img)}" style="width:100%;display:block;" onerror="this.style.display='none'" />
				</a>
				${thumbs.length ? `<div style="flex:1;display:grid;grid-template-columns:repeat(2,1fr);gap:8px;align-content:start;">
					${thumbs.map(t => `<img src="${escapeHtml(t.img)}" data-url="${fileUrl(t.id)}" style="width:100%;display:block;cursor:pointer;" onclick="${swap}" onerror="this.style.display='none'" />`).join('')}
				</div>` : ''}
			</div>
			${uploaded ? `<div style="color:hsla(0,0%,100%,0.33);margin-top:8px;font-size:12px;">${escapeHtml(uploaded)}</div>` : ''}
		</div>
	</div>`;
	return renderEventShell(event, escapeHtml(verb), body);
}

/** Game capsule body used by "now owns" / "played first time" / wishlist events.
 *  Native uses a 200x94 header-image carousel item. */
function renderCapsuleBody(appid: string, fallbackHeader: string): string {
	return `<div class="${EVENT_CLASSES().EventBody}"><div style="padding:12px;">
		<a href="#" onclick="window.gdlOpen('https://store.steampowered.com/app/${appid}');return false;">
			<img src="https://cdn.akamai.steamstatic.com/steam/apps/${appid}/header.jpg" style="display:block;width:200px;height:94px;object-fit:cover;" onerror="this.src='${escapeHtml(fallbackHeader)}'" />
		</a>
	</div></div>`;
}

interface FriendReview {
	found: boolean;
	voted_up?: boolean;
	rating?: string;
	hours?: string;
	text?: string;
	url: string;
}

/** "reviewed this game" event with the scraped review content */
function renderReviewEvent(event: any, review: FriendReview | undefined, appid: string): string {
	const verb = escapeHtml(loc('AppActivity_RecommendedGame', ' reviewed this game'));
	const url = review?.url || `https://steamcommunity.com/profiles/${eventActorId(event)}/recommended/${appid}/`;
	const readMore = `<a href="#" onclick="window.gdlOpen('${url}');return false;" style="display:inline-block;margin-top:8px;color:#8c9193;font-size:12px;text-decoration:none;">${escapeHtml(loc('AppActivity_RecommendedGame_ReadMore', 'Read More'))}</a>`;

	let inner: string;
	if (review && review.found) {
		inner = `<div style="padding:12px;display:flex;gap:12px;align-items:flex-start;">
			<img src="${review.voted_up ? REVIEW_THUMB_UP : REVIEW_THUMB_DOWN}" style="width:40px;height:40px;flex-shrink:0;" onerror="this.style.display='none'" />
			<div style="min-width:0;">
				<div style="color:#dcdedf;font-size:16px;">${escapeHtml(review.rating || '')}</div>
				${review.hours ? `<div style="color:#8f98a0;font-size:11px;margin-top:2px;">${escapeHtml(review.hours)}</div>` : ''}
				${review.text ? `<div style="color:#acb2b8;font-size:13px;line-height:1.5;margin-top:10px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;white-space:pre-line;">${escapeHtml(review.text)}</div>` : ''}
				${readMore}
			</div>
		</div>`;
	} else {
		inner = `<div style="padding:12px;">${readMore}</div>`;
	}
	return renderEventShell(event, verb, `<div class="${EVENT_CLASSES().EventBody}">${inner}</div>`);
}

/** Fetch real activity and render all supported friend events into the feed */
async function populateActivityFeed(doc: Document, steamAppId: string, gameName: string, headerImage: string): Promise<void> {
	const activity = await getRealActivity(parseInt(steamAppId));
	if (!activity || currentInjectedAppId !== steamAppId) return;

	// Collect days (native store groups events per day)
	const days: any[] = [];
	try {
		activity.m_mapActivityByDay?.forEach?.((d: any) => days.push(d));
	} catch {}
	if (days.length === 0) {
		backendLog('Activity: no day groups for ' + steamAppId);
		return;
	}
	days.sort((a, b) => (b.GetLatestEventTime?.() || 0) - (a.GetLatestEventTime?.() || 0));

	// Gather renderable events per day + everything we need to prefetch
	const dayEvents: { day: any; events: any[] }[] = [];
	const actorIds = new Set<string>();
	const fileIds = new Set<string>();
	const reviewActors: string[] = [];
	for (const day of days) {
		let events: any[] = [];
		try {
			events = (day.events || []).filter((e: any) => {
				if (!RENDERABLE_EVENT_TYPES.has(e.eEventType)) return false;
				if (e.eEventType === NEWS_TYPE.AchievementUnlocked) return Array.isArray(e.achievements) && e.achievements.length > 0;
				return true;
			}).slice(0, 5);
		} catch {}
		if (events.length === 0) continue;
		for (const e of events) {
			const sid = eventActorId(e);
			if (sid && !personaCache.has(sid)) actorIds.add(sid);
			if (SCREENSHOT_TYPES.has(e.eEventType) || e.eEventType === NEWS_TYPE.Video) {
				for (const id of (e.publishedfileids || []).slice(0, 5)) fileIds.add(String(id));
			}
			if (e.eEventType === NEWS_TYPE.RecommendedGame && sid && reviewActors.length < 3) {
				reviewActors.push(sid);
			}
		}
		dayEvents.push({ day, events });
		if (dayEvents.length >= 8) break;
	}
	if (dayEvents.length === 0) {
		backendLog('Activity: no renderable events for ' + steamAppId);
		return;
	}

	// Prefetch personas, screenshot previews, and reviews in parallel
	const previews = new Map<string, string>();
	const reviews = new Map<string, FriendReview>();
	await Promise.all([
		actorIds.size > 0
			? fetchFriendPersonasBackend({ steam_ids_csv: [...actorIds].join(',') })
				.then(json => { for (const p of JSON.parse(json) as FriendPersona[]) personaCache.set(p.steamid, p); })
				.catch(e => backendLog('Activity persona fetch error: ' + e))
			: Promise.resolve(),
		fileIds.size > 0
			? fetchPublishedPreviewsBackend({ file_ids_csv: [...fileIds].join(',') })
				.then(json => { for (const f of JSON.parse(json) as { id: string; image: string }[]) if (f.image) previews.set(f.id, f.image); })
				.catch(e => backendLog('Preview fetch error: ' + e))
			: Promise.resolve(),
		...reviewActors.map(sid =>
			fetchFriendReviewBackend({ steam_id64: sid, steam_app_id: steamAppId })
				.then(json => { reviews.set(sid, JSON.parse(json) as FriendReview); })
				.catch(e => backendLog('Review fetch error: ' + e))
		),
	]);
	if (currentInjectedAppId !== steamAppId) return;

	const renderEvent = (e: any): string => {
		switch (e.eEventType) {
			case NEWS_TYPE.AchievementUnlocked:
				return renderAchievementEvent(e, steamAppId);
			case NEWS_TYPE.Video:
				return renderScreenshotEvent(e, previews, true);
			case NEWS_TYPE.ReceivedNewGame:
				return renderEventShell(e,
					verbWithGameName(loc('AppActivity_ReceivedNewGameList', ' added %1$s to their library'), gameName),
					renderCapsuleBody(steamAppId, headerImage));
			case NEWS_TYPE.AddedGameToWishlist:
				return renderEventShell(e,
					verbWithGameName(loc('AppActivity_AddedGameToWishlist', ' added %1$s to their %2$s.')
						.replace('%2$s', loc('AppActivity_Wishlist', 'wishlist')), gameName),
					renderCapsuleBody(steamAppId, headerImage));
			case NEWS_TYPE.PlayedGameFirstTime:
				return renderEventShell(e,
					verbWithGameName(loc('AppActivity_PlayedGameFirstTime', ' played %1$s for the first time'), gameName),
					renderCapsuleBody(steamAppId, headerImage));
			case NEWS_TYPE.RecommendedGame:
				return renderReviewEvent(e, reviews.get(eventActorId(e)), steamAppId);
			case NEWS_TYPE.UserStatus: {
				const text = e.statusText || e.strStatusText || e.status_text || e.strStatus || '';
				if (!text) {
					backendLog('UserStatus event fields: ' + Object.keys(e).slice(0, 40).join(','));
					return '';
				}
				const ev2 = EVENT_CLASSES();
				return renderEventShell(e,
					escapeHtml(loc('AppActivity_UserStatus', ' posted a status update')),
					`<div class="${ev2.EventBody} ${ev2.UserStatus}"><div style="font-size:14px;color:#dcdedf;line-height:1.5;white-space:pre-line;">${escapeHtml(String(text))}</div></div>`);
			}
			default:
				if (SCREENSHOT_TYPES.has(e.eEventType)) return renderScreenshotEvent(e, previews, false);
				return '';
		}
	};

	const ev = EVENT_CLASSES();
	let html = '';
	for (const { day, events } of dayEvents) {
		const rendered = events.map(renderEvent).join('');
		if (!rendered) continue;
		const ts = day.GetLatestEventTime?.() || 0;
		const dateLabel = ts
			? new Date(ts * 1000).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })
			: '';
		html += `<div class="${ev.AppActivityDay}" role="region">
			<h4 class="${ev.AppActivityDate}" style="margin:0 0 4px;">${escapeHtml(dateLabel)}<div class="${ev.Rule}"></div></h4>
			${rendered}
		</div>`;
	}

	const feedEl = doc.getElementById('gdl-activity-feed');
	if (feedEl) {
		feedEl.innerHTML = html;
		// Native pages only show "View Latest News" when friend activity
		// sits above the news feed
		const viewNews = doc.getElementById('gdl-view-latest-news');
		if (viewNews && html) viewNews.style.display = 'flex';
		backendLog('Activity feed rendered: ' + dayEvents.length + ' day group(s)');
	}
}

// ── Play bar achievements stat ──────────────────────────────────────────
// Clones the native PLAY TIME stat and rewrites it into ACHIEVEMENTS "X/Y"
// with the native 4px mini progress bar, exactly like real installed games.

async function injectPlayBarAchievements(doc: Document, steamAppId: string, fallbackTotal: number): Promise<void> {
	const progress = await getAchievementProgress(parseInt(steamAppId), fallbackTotal);
	if (!progress || progress.total <= 0) return;
	if (currentInjectedAppId !== steamAppId) return;
	if (doc.getElementById('gdl-playbar-achievements')) return;

	// Case-insensitive exact text lookup - some builds store stat labels
	// already uppercased in the DOM rather than via CSS text-transform
	const findLabel = (text: string): HTMLElement | null => {
		const lower = text.trim().toLowerCase();
		const walker = doc.createTreeWalker(doc.body || doc.documentElement, NodeFilter.SHOW_TEXT, null);
		let node: Text | null;
		while ((node = walker.nextNode() as Text | null)) {
			if (node.textContent && node.textContent.trim().toLowerCase() === lower) {
				return node.parentElement;
			}
		}
		return null;
	};

	const labelEl = findLabel(loc('AppDetails_SectionTitle_PlayTime', 'Play Time'));
	if (!labelEl) {
		backendLog('Play bar: PLAY TIME label not found');
		return;
	}
	const valueEl = labelEl.nextElementSibling as HTMLElement | null;
	if (!valueEl) {
		backendLog('Play bar: PLAY TIME value not found next to label');
		return;
	}

	// The stat cell is the highest ancestor of the PLAY TIME label that does
	// not contain the LAST PLAYED stat; its parent is the stats row.
	const lastPlayedEl = findLabel(loc('AppDetails_SectionTitle_LastPlayed', 'Last Played'));
	let statRoot: HTMLElement = labelEl;
	if (lastPlayedEl && !labelEl.contains(lastPlayedEl)) {
		while (statRoot.parentElement && !statRoot.parentElement.contains(lastPlayedEl)) {
			statRoot = statRoot.parentElement;
		}
	} else if (labelEl.parentElement?.parentElement) {
		statRoot = labelEl.parentElement.parentElement;
	}
	const statsRow = statRoot.parentElement;
	if (!statsRow) return;
	backendLog('Play bar: statRoot class="' + statRoot.className + '" row class="' + statsRow.className + '"');

	// Build a fresh stat cell copying the live class names (cloning the whole
	// subtree proved fragile against Steam's own re-renders)
	const c = ACH_CLASSES();
	const pct = Math.round((100 * progress.unlocked) / progress.total);
	const stat = doc.createElement('div');
	stat.id = 'gdl-playbar-achievements';
	stat.className = statRoot.className;

	const inner = `
		<div class="${labelEl.className}">${escapeHtml(loc('AppDetails_SectionTitle_Achievements', 'Achievements'))}</div>
		<div class="${valueEl.className}" style="display:flex;align-items:center;gap:8px;">
			<span>${progress.unlocked}/${progress.total}</span>
			<div class="${c.SingleAchievementProgressBar}" style="width:96px;">
				<div class="${c.AchievementProgress}" style="width:${pct}%;"></div>
			</div>
		</div>`;
	const labelWrap = labelEl.parentElement;
	stat.innerHTML = labelWrap && labelWrap !== statRoot
		? `<div class="${labelWrap.className}">${inner}</div>`
		: inner;

	// Open the user's achievements page for the linked game on click
	stat.style.cursor = 'pointer';
	stat.addEventListener('click', () => {
		const url = `https://steamcommunity.com/my/stats/${steamAppId}/achievements`;
		const opener = (doc.defaultView as any)?.gdlOpen;
		if (typeof opener === 'function') opener(url);
		else doc.defaultView?.open('steam://openurl/' + url);
	});

	statsRow.insertBefore(stat, statRoot.nextSibling);
	backendLog('Play bar achievements stat injected: ' + progress.unlocked + '/' + progress.total);
}

/** Resolve real achievement progress, then update sidebar panel + play bar */
async function finalizeAchievements(doc: Document, steamAppId: string, fallbackTotal: number): Promise<void> {
	await injectPlayBarAchievements(doc, steamAppId, fallbackTotal);
	const progress = await getAchievementProgress(parseInt(steamAppId), fallbackTotal);
	if (!progress || currentInjectedAppId !== steamAppId) return;
	const el = doc.getElementById('gdl-achievements-content');
	if (el) el.innerHTML = renderAchievementsPanel(progress.unlocked, progress.total);
}

const DEFAULT_AVATAR = 'https://avatars.cloudflare.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg';

/** Format playtime: >= 120 min as hours, < 120 min as minutes */
function formatPlayTime(minutes: number): string {
	if (minutes >= 120) return (minutes / 60).toFixed(1) + ' hrs played recently';
	if (minutes > 0) return minutes + ' mins played recently';
	return '';
}

/** Render avatar grid helper */
function renderAvatarGrid(friends: FriendPlayInfo[], personas?: FriendPersona[]): string {
	return friends.map(friend => {
		const p = personas?.find(x => x.steamid === friend.steamid);
		const avatar = p?.avatar || DEFAULT_AVATAR;
		const name = p?.name || friend.steamid;
		const profileUrl = 'steam://url/SteamIDPage/' + friend.steamid;
		return `<a href="${profileUrl}" style="display:block;width:33px;height:33px;overflow:hidden;flex-shrink:0;" title="${escapeHtml(name)}">` +
			`<img src="${avatar}" style="width:100%;height:100%;display:block;" onerror="this.src='${DEFAULT_AVATAR}'" /></a>`;
	}).join('');
}

/** Render detailed friend entry (avatar + name + hours) */
function renderFriendEntry(friend: FriendPlayInfo, personas?: FriendPersona[]): string {
	const p = personas?.find(x => x.steamid === friend.steamid);
	const name = p?.name || friend.steamid;
	const avatar = p?.avatar || DEFAULT_AVATAR;
	const profileUrl = 'steam://url/SteamIDPage/' + friend.steamid;
	const playTime = formatPlayTime(friend.minutes_played_recently);
	return `<a href="${profileUrl}" style="display:flex;align-items:center;gap:8px;padding:4px 0;text-decoration:none;overflow:hidden;">
		<img src="${avatar}" style="width:32px;height:32px;flex-shrink:0;" onerror="this.src='${DEFAULT_AVATAR}'" />
		<div style="min-width:0;overflow:hidden;">
			<div style="font-size:13px;font-weight:500;color:#57cbde;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(name)}</div>
			${playTime ? `<div style="font-size:11px;color:#8f98a0;white-space:nowrap;">${playTime}</div>` : ''}
		</div>
	</a>`;
}

/** Render the FRIENDS WHO PLAY inner content with multiple sections matching native Steam layout */
function renderFriendsSection(friendResult: FriendCategories | null, steamAppId: string, _gameName: string, personas?: FriendPersona[]): string {
	if (!friendResult || friendResult.totalCount === 0) return '';
	const { recentlyPlayed, previouslyPlayed } = friendResult;
	let html = '';

	// ── Section 1: Recently played (detailed 2-column view) ──
	if (recentlyPlayed.length > 0) {
		const SHOW_RECENT = 10;
		const visibleRecent = recentlyPlayed.slice(0, SHOW_RECENT);
		const hiddenRecent = recentlyPlayed.slice(SHOW_RECENT);

		html += `<div style="font-size:13px;font-weight:bold;color:#dcdedf;margin-bottom:10px;">
			${recentlyPlayed.length} ${recentlyPlayed.length === 1 ? 'friend has' : 'friends have'} played recently
		</div>`;

		html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 16px;">`;
		for (const friend of visibleRecent) {
			html += renderFriendEntry(friend, personas);
		}
		html += `</div>`;

		if (hiddenRecent.length > 0) {
			html += `<div id="gdl-recent-extra" style="display:none;"><div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 16px;">`;
			for (const friend of hiddenRecent) {
				html += renderFriendEntry(friend, personas);
			}
			html += `</div></div>`;
			html += `<div id="gdl-recent-toggle" style="margin-top:6px;cursor:pointer;font-size:12px;color:#8f98a0;" onclick="var e=document.getElementById('gdl-recent-extra');if(e){e.style.display='';this.style.display='none';}">Show all recently played (${hiddenRecent.length} more)</div>`;
		}
	}

	// ── Section 2: Previously played / all friends (avatar grid) ──
	if (previouslyPlayed.length > 0) {
		const hasRecentSection = recentlyPlayed.length > 0;
		const SHOW_PREV = 18;
		const visiblePrev = previouslyPlayed.slice(0, SHOW_PREV);
		const hiddenPrev = previouslyPlayed.slice(SHOW_PREV);

		const headerText = hasRecentSection
			? `${previouslyPlayed.length} ${previouslyPlayed.length === 1 ? 'friend has' : 'friends have'} played previously`
			: `${previouslyPlayed.length} ${previouslyPlayed.length === 1 ? 'friend plays' : 'friends play'} this game`;
		html += `<div style="font-size:13px;font-weight:bold;color:#dcdedf;margin:${hasRecentSection ? '16' : '0'}px 0 10px;">
			${headerText}
		</div>`;

		html += `<div style="display:flex;flex-wrap:wrap;gap:3px;">`;
		html += renderAvatarGrid(visiblePrev, personas);
		html += `</div>`;

		if (hiddenPrev.length > 0) {
			html += `<div id="gdl-prev-extra" style="display:none;"><div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:3px;">`;
			html += renderAvatarGrid(hiddenPrev, personas);
			html += `</div></div>`;
			html += `<div id="gdl-prev-toggle" style="margin-top:6px;cursor:pointer;font-size:12px;color:#8f98a0;" onclick="var e=document.getElementById('gdl-prev-extra');if(e){e.style.display='';this.style.display='none';}">Show all previously played (${hiddenPrev.length} more)</div>`;
		}
	}

	// "View all friends who play" link at bottom right
	html += `<div style="text-align:right;margin-top:12px;">
		<a href="#" onclick="window.gdlOpen('https://steamcommunity.com/app/${steamAppId}');return false;" style="font-size:12px;color:#8f98a0;text-decoration:none;">View all friends who play</a>
	</div>`;

	return html;
}

/** Build and inject layout matching native Steam library structure.
 *  Uses NOTES section as anchor to detect sidebar, two-column row, and content column.
 *  Clones native CSS classes from NOTES for pixel-perfect friends section. */
function injectGameData(
	doc: Document,
	noticeElement: Element,
	data: SteamGameData,
	steamAppId: string,
	newsItems: NewsItem[],
	friendResult: any,
	communityItems?: CommunityContentItem[]
): void {
	// Cleanup previous injections
	for (const id of [GDL_INJECTED, 'gdl-skeleton', 'gdl-friends-section', 'gdl-achievements-section', 'gdl-playbar-achievements', 'gdl-link-bar', 'gdl-community-content']) {
		const el = doc.getElementById(id);
		if (el) el.remove();
	}

	const noticeParent = noticeElement.closest('div');

	// In-client link opener for injected content: the native pages open web
	// links in the client's own browser view, not the system browser
	(doc.defaultView as any).gdlOpen = (u: string) => {
		if (!u) return;
		try {
			const mgr = (doc.defaultView as any).MainWindowBrowserManager || (window as any).MainWindowBrowserManager;
			if (mgr && typeof mgr.ShowURL === 'function') {
				mgr.ShowURL(u);
				return;
			}
		} catch {}
		try { doc.defaultView?.open('steam://openurl/' + u); } catch {}
	};

	// ── Detect native layout structure using NOTES as anchor ──
	// Native structure: Panel > [play area] > [link bar zone] > twoColRow(flex) > [sidebarCol, contentCol]
	const notesTextEl = findElementByExactText(doc, loc('AppDetails_SectionTitle_GameNotes', 'Notes'));
	const recordingsTextEl = findElementByExactText(doc, loc('AppDetails_SectionTitle_Media', 'Recordings and Screenshots'));
	const layoutAnchor = notesTextEl || recordingsTextEl;

	let anchorRegion: HTMLElement | null = null;
	let sidebarColumn: HTMLElement | null = null;
	let twoColRow: HTMLElement | null = null;
	let contentColumn: HTMLElement | null = null;

	if (layoutAnchor) {
		// Walk up to the role="region" container (Notes region)
		let el = layoutAnchor as HTMLElement;
		for (let i = 0; i < 8 && el.parentElement; i++) {
			el = el.parentElement;
			if (el.getAttribute('role') === 'region') {
				anchorRegion = el;
				break;
			}
		}

		// Find the two-column layout using lowest-common-ancestor of notice (content col) and anchor (sidebar col)
		if (anchorRegion) {
			const getChain = (e: Element): HTMLElement[] => {
				const c: HTMLElement[] = [e as HTMLElement];
				let cur = e as HTMLElement;
				while (cur.parentElement) { c.push(cur.parentElement); cur = cur.parentElement; }
				return c;
			};
			const noticeChain = getChain(noticeElement);
			const anchorChain = getChain(anchorRegion);
			for (let ai = 1; ai < anchorChain.length; ai++) {
				const ni = noticeChain.indexOf(anchorChain[ai]);
				if (ni > 0) {
					twoColRow = anchorChain[ai];
					sidebarColumn = anchorChain[ai - 1];
					contentColumn = noticeChain[ni - 1];
					break;
				}
			}
		}
	}

	backendLog('Layout: sidebar=' + !!sidebarColumn + ' twoCol=' + !!twoColRow + ' content=' + !!contentColumn + ' region=' + !!anchorRegion);

	// ── Hide the notice and its single-child wrapper chain ──
	// The wrappers around the notice carry padding that pushed our content
	// ~50px lower than the native page. Climb through wrappers that contain
	// nothing else, but never hide the content column / two-column row, and
	// stop at anything another plugin injected into (e.g. Non Steam Playtimes).
	let hideEl: HTMLElement | null = noticeElement as HTMLElement;
	for (let i = 0; i < 4 && hideEl; i++) {
		if (hideEl === contentColumn || hideEl === twoColRow) break;
		if (i > 0 && hideEl.querySelector('[data-nsp]')) break;
		hideEl.style.display = 'none';
		hideEl.setAttribute('data-gdl-hidden', '1');
		const parent = hideEl.parentElement;
		if (!parent || parent.childElementCount > 1) break;
		hideEl = parent;
	}

	// ── Sidebar section builder - clones native classes from the NOTES region ──
	const buildSidebarSection = (sectionId: string, headerText: string, innerId: string, innerHtml: string, cloneInnerClass = true): HTMLElement | null => {
		if (!anchorRegion) return null;
		const regionChildren = Array.from(anchorRegion.children);
		const sourceH2 = regionChildren.find(c => c.tagName === 'H2') as HTMLElement | undefined;
		const sourceBody = regionChildren.find(c => c.tagName === 'DIV') as HTMLElement | undefined;

		const region = doc.createElement('div');
		region.className = anchorRegion.className;
		region.setAttribute('role', 'region');

		// Clone and modify header from NOTES
		if (sourceH2) {
			const h2 = sourceH2.cloneNode(true) as HTMLElement;
			const innerTxt = h2.querySelector('div div') || h2.querySelector('div') || h2;
			innerTxt.textContent = headerText;
			region.appendChild(h2);
		}

		// Clone body panel structure and fill with content
		if (sourceBody) {
			const body = doc.createElement('div');
			body.className = sourceBody.className;
			const sourceInner = sourceBody.firstElementChild as HTMLElement | null;
			const inner = doc.createElement('div');
			inner.id = innerId;
			// The NOTES inner class carries note-editor layout; skip it for
			// sections that bring their own native classes
			if (cloneInnerClass && sourceInner) inner.className = sourceInner.className;
			inner.innerHTML = innerHtml;
			body.appendChild(inner);
			region.appendChild(body);
		}

		// Wrap in the same slot wrapper class used by NOTES parent.
		// The section id goes on the OUTERMOST node so cleanup removes the wrapper too.
		const anchorWrap = anchorRegion.parentElement;
		let outer: HTMLElement = region;
		if (anchorWrap && anchorWrap.parentElement === sidebarColumn) {
			const wrap = doc.createElement('div');
			wrap.className = anchorWrap.className;
			wrap.appendChild(region);
			outer = wrap;
		}
		outer.id = sectionId;
		return outer;
	};

	// ── Build sidebar sections in native order: Friends who play, Achievements ──
	let lastSidebarInsert: HTMLElement | null = null;
	const hasFriends = friendResult && friendResult.totalCount > 0;
	if (hasFriends && anchorRegion && sidebarColumn) {
		const node = buildSidebarSection(
			'gdl-friends-section',
			loc('AppDetails_SectionTitle_Friends', 'Friends who play'),
			'gdl-friends-content',
			renderFriendsSection(friendResult, steamAppId, data.name)
		);
		if (node) {
			sidebarColumn.insertBefore(node, sidebarColumn.firstChild);
			lastSidebarInsert = node;
		}
	}

	// ── Achievements section - native HighlightDiv markup; starts at 0/N and
	// is updated with the user's real progress by finalizeAchievements() ──
	const achTotal = data.achievements?.total || 0;
	if (achTotal > 0 && anchorRegion && sidebarColumn) {
		const node = buildSidebarSection(
			'gdl-achievements-section',
			loc('AppDetails_SectionTitle_Achievements', 'Achievements'),
			'gdl-achievements-content',
			renderAchievementsPanel(0, achTotal),
			false
		);
		if (node) {
			sidebarColumn.insertBefore(node, lastSidebarInsert ? lastSidebarInsert.nextSibling : sidebarColumn.firstChild);
		}
	}

	// ── Build news cards - native partner-event styling, 3 newest stories ──
	const grouped = groupNewsByDate(newsItems.slice(0, 3));
	let newsHtml = '';

	if (grouped.length > 0) {
		const n = EVENT_CLASSES();
		let isFirstCard = true;
		for (const group of grouped) {
			// AppActivityDay wrapper scopes the native date-header styling
			newsHtml += `<div class="${n.AppActivityDay}" style="margin-top:24px;">
				<h4 class="${n.AppActivityDate}" style="margin:0 0 4px;">${group.date}<div class="${n.Rule}"></div></h4>`;
			for (const item of group.items) {
				const isMajor = item.event_type === 13 || item.event_type === 14;
				const label = item.event_type !== undefined
					? eventTypeLabel(item.event_type)
					: (item.feedlabel || 'News');
				const preview = stripTags(item.contents).substring(0, 220);
				const thumbUrl = item.image || data.header_image;
				const typeHtml = `<div class="${n.PartnerEventType}"${isMajor ? ' style="color:#1a9fff;"' : ''}><div>${escapeHtml(label)}</div></div>`;

				if (isFirstCard) {
					// Newest story renders in the native large/featured layout
					newsHtml += `
						<div class="${n.Event} ${n.PartnerEvent} ${n.PartnerEventLargeImage_Container}${isMajor ? ' ' + n.PartnerEventFeatured : ''}" style="position:relative;margin-bottom:16px;" onclick="window.gdlOpen('${item.url}')">
							<div class="${n.PartnerEventLargeImage_Contents}">
								<div class="${n.ImageContainer}">
									<img class="${n.PartnerEventLargeImage_Image}" src="${escapeHtml(thumbUrl)}" onerror="this.src='${escapeHtml(data.header_image || '')}'" />
								</div>
								<div class="${n.PartnerEventLargeImage_TextColumn}" style="min-width:0;overflow:hidden;">
									${typeHtml}
									<div class="${n.PartnerEventLargeImage_Title}">${escapeHtml(item.title)}</div>
									<div class="${n.PartnerEventLargeImage_Summary}">${escapeHtml(preview)}</div>
								</div>
							</div>
						</div>
					`;
				} else {
					newsHtml += `
						<div class="${n.Event} ${n.PartnerEvent} ${n.PartnerEventMediumImage_Container}${isMajor ? ' ' + n.PartnerEventLargeUpdate : ''}" style="position:relative;margin-bottom:16px;" onclick="window.gdlOpen('${item.url}')">
							${isMajor ? `<div class="${n.LeftSideMajorUpdateBar}"></div>` : ''}
							<div class="${n.PartnerEventMediumImage_Contents}">
								<div class="${n.MediumImageContainer}">
									<img class="${n.PartnerEventMediumImage_Image}" src="${escapeHtml(thumbUrl)}" style="width:100%;height:100%;object-fit:cover;display:block;" onerror="this.src='${escapeHtml(data.header_image || '')}'" />
								</div>
								<div class="${n.PartnerEventMediumImage_TextColumn}" style="min-width:0;overflow:hidden;">
									${typeHtml}
									<div class="${n.PartnerEventMediumImage_Title}">${escapeHtml(item.title)}</div>
									<div class="${n.PartnerEventMediumImage_Summary}">${escapeHtml(preview)}</div>
								</div>
							</div>
						</div>
					`;
				}
				isFirstCard = false;
			}
			newsHtml += `</div>`;
		}
	} else {
		newsHtml = `<div style="color:#4a5562;font-size:13px;padding:20px 0;">${escapeHtml(loc('AppActivity_NoActivity', "There's no recent activity from the developers of this title or from your friends."))}</div>`;
	}

	// ── Build community content section (matching native 5-col grid) ──
	let communityHtml = '';
	const ccItems = communityItems && communityItems.length > 0 ? communityItems : [];
	// Fallback to store screenshots if no community content was fetched
	const fallbackScreenshots = ccItems.length === 0 && data.screenshots && data.screenshots.length > 0;
	const displayItems: CommunityContentItem[] = fallbackScreenshots
		? data.screenshots!.slice(0, 15).map(s => ({ type: 'screenshot', image: s.path_thumbnail, link: s.path_full }))
		: ccItems;

	if (displayItems.length > 0) {
		// Separate screenshots and guides
		const screenshots = displayItems.filter(i => i.type !== 'guide');
		const guides = displayItems.filter(i => i.type === 'guide');

		// Author strip under the card (dark bar, 32px avatar) - native anatomy
		const authorBar = (item: CommunityContentItem) => {
			if (!item.author_name && !item.author_avatar) return '';
			return `<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:rgba(0,0,0,0.25);margin-top:auto;min-height:32px;">
				${item.author_avatar ? `<img src="${item.author_avatar}" style="width:32px;height:32px;flex-shrink:0;" onerror="this.style.display='none'" />` : ''}
				<span style="font-size:13px;color:#8f98a0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(item.author_name || '')}</span>
			</div>`;
		};

		// Cards are slightly LIGHTER than the page background, like native
		const CARD_BG = 'rgba(103,112,128,0.12)';

		const screenshotCard = (item: CommunityContentItem) => {
			const click = item.link ? ` onclick="window.gdlOpen('${item.link}')"` : '';
			return `<div style="background:${CARD_BG};overflow:hidden;cursor:pointer;display:flex;flex-direction:column;min-width:0;"${click}>
				<div style="position:relative;overflow:hidden;">
					<img src="${item.image || ''}" style="width:100%;max-width:100%;aspect-ratio:16/9;object-fit:cover;display:block;" onerror="this.style.display='none'" />
					${item.title ? `<div style="position:absolute;bottom:0;left:0;right:0;padding:8px 10px;font-size:13px;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,0.8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(item.title)}</div>` : ''}
				</div>
				${authorBar(item)}
			</div>`;
		};

		const guideCard = (item: CommunityContentItem) => {
			const click = item.link ? ` onclick="window.gdlOpen('${item.link}')"` : '';
			return `<div style="background:${CARD_BG};overflow:hidden;cursor:pointer;display:flex;flex-direction:column;min-width:0;"${click}>
				<div style="padding:8px 12px;background:rgba(0,0,0,0.25);font-size:11px;letter-spacing:0.5px;font-weight:500;color:#8f98a0;text-transform:uppercase;">${escapeHtml((item.label ? 'Community ' + item.label : 'Community Guide').toUpperCase())}</div>
				<div style="display:flex;gap:12px;padding:12px;align-items:flex-start;">
					<img src="${item.image || ''}" style="width:92px;height:92px;object-fit:cover;flex-shrink:0;" onerror="this.style.display='none'" />
					<div style="font-size:15px;font-weight:500;color:#dcdedf;line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;min-width:0;">${escapeHtml(item.title || '')}</div>
				</div>
				${item.description ? `<div style="font-size:13px;color:#8f98a0;line-height:1.5;padding:0 12px 12px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;">${escapeHtml(item.description)}</div>` : ''}
				${authorBar(item)}
			</div>`;
		};

		// Main grid: 3 columns like the native section - screenshots first,
		// then guides, backfilled with more screenshots (max 6 cards)
		const mainCards: string[] = [];
		let ssUsed = 0;
		for (; ssUsed < screenshots.length && mainCards.length < 3; ssUsed++) mainCards.push(screenshotCard(screenshots[ssUsed]));
		for (let gi = 0; gi < guides.length && mainCards.length < 6; gi++) mainCards.push(guideCard(guides[gi]));
		for (; ssUsed < screenshots.length && mainCards.length < 6; ssUsed++) mainCards.push(screenshotCard(screenshots[ssUsed]));
		// minmax(0,1fr): plain 1fr lets intrinsic image widths blow the grid
		// out past the content column and under the sidebar
		const mainGrid = mainCards.length
			? `<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:38px 30px;align-items:stretch;">${mainCards.join('')}</div>`
			: '';

		// Thumbnail strip: remaining screenshots, image-only, 5 per row
		const thumbItems = screenshots.slice(ssUsed, ssUsed + 5);
		const thumbRow = thumbItems.length
			? `<div style="display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin-top:24px;">${thumbItems.map(t => {
				const tclick = t.link ? ` onclick="window.gdlOpen('${t.link}')"` : '';
				return `<div style="position:relative;overflow:hidden;cursor:pointer;"${tclick}>
					<img src="${t.image || ''}" style="width:100%;aspect-ratio:16/9;object-fit:cover;display:block;" onerror="this.style.display='none'" />
					${t.title ? `<div style="position:absolute;bottom:0;left:0;right:0;padding:6px 8px;font-size:12px;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,0.8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(t.title)}</div>` : ''}
				</div>`;
			}).join('')}</div>`
			: '';

		communityHtml = `<div style="padding:4px 0;">${mainGrid}${thumbRow}</div>`;
	}

	// ── Assemble content wrapper (Activity + News + Community) ──
	// Native ActivityFeedContainer class provides color:#fff, max-width:66%
	// and the 64px bottom margin the real page uses.
	const wrapper = doc.createElement('div');
	wrapper.id = GDL_INJECTED;
	// 12px matches the native DefaultActivityPadding variable
	wrapper.className = FEED_CLASSES().ActivityFeedContainer;
	wrapper.style.cssText = 'font-family:inherit;padding:0 12px 24px;overflow:hidden;';

	wrapper.innerHTML = `
		<div style="font-size:11px;font-weight:600;letter-spacing:1.5px;color:#8f98a0;margin-bottom:16px;">${escapeHtml(loc('AppDetails_SectionTitle_Activity', 'Activity').toUpperCase())}</div>

		<div class="${FEED_CLASSES().AddToFeed} ${FEED_CLASSES().PostTextEntry} ${POST_CLASSES().PostTextEntry}">
			<textarea id="gdl-status-text" class="${POST_CLASSES().PostTextEntryArea}" rows="1" placeholder="${escapeHtml(loc('AppActivity_StatusUpdate_Post', 'Say something about this game to your friends...'))}"></textarea>
			<div id="gdl-status-controls" class="${POST_CLASSES().Controls}">
				<div class="${POST_CLASSES().FormattingSpacer}"></div>
				<button type="button" class="${POST_CLASSES().EmoticonButton}" tabindex="-1">
					<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="9" stroke-width="1.5"></circle><circle cx="9" cy="10" r="1.2" fill="currentColor" stroke="none"></circle><circle cx="15" cy="10" r="1.2" fill="currentColor" stroke="none"></circle><path d="M8 14c1 1.6 2.4 2.4 4 2.4s3-.8 4-2.4" stroke-width="1.5" stroke-linecap="round"></path></svg>
				</button>
				<button type="button" id="gdl-status-post" class="${POST_CLASSES().PostButton}">
					<div class="${POST_CLASSES().Label}">${escapeHtml(loc('AppActivity_PostStatusUpdate', 'Post'))}</div>
				</button>
			</div>
		</div>

		<div id="gdl-view-latest-news" style="display:none;flex-direction:column;margin-bottom:10px;">
			<div class="${FEED_CLASSES().ViewLastNews}" onclick="var n=document.getElementById('gdl-news-section');if(n)n.scrollIntoView({behavior:'smooth'});">${escapeHtml(loc('AppActivity_ViewLatestNews', 'View Latest News'))}</div>
		</div>

		<div id="gdl-activity-feed"></div>

		<div id="gdl-news-section">${newsHtml}</div>

		<div style="display:flex;justify-content:center;margin-top:24px;">
			<a href="#" onclick="window.gdlOpen('https://steamcommunity.com/app/${steamAppId}');return false;" class="${FEED_CLASSES().FetchMoreContainer}"
			   style="text-decoration:none;cursor:pointer;">${escapeHtml(loc('AppActivity_FetchMore', 'Load More Activity'))}</a>
		</div>
	`;

	// ── Build link bar ──
	const linkBar = doc.createElement('div');
	linkBar.id = 'gdl-link-bar';
	linkBar.style.cssText = 'display:flex;align-items:center;padding:6px 16px;';
	linkBar.innerHTML = [
		['Store Page', `https://store.steampowered.com/app/${steamAppId}`],
		['Community Hub', `https://steamcommunity.com/app/${steamAppId}`],
		['Points Shop', `https://store.steampowered.com/points/shop/app/${steamAppId}`],
		['Discussions', `https://steamcommunity.com/app/${steamAppId}/discussions/`],
		['Guides', `https://steamcommunity.com/app/${steamAppId}/guides/`],
		['Workshop', `https://steamcommunity.com/app/${steamAppId}/workshop/`],
		['Support', `https://help.steampowered.com/en/wizard/HelpWithGame/?appid=${steamAppId}`],
	].map(([label, url]) =>
		`<a href="#" onclick="window.gdlOpen('${url}');return false;" style="color:#8f98a0;text-decoration:none;font-size:13px;padding:6px 16px;transition:color 0.1s;"
		    onmouseover="this.style.color='#fff'" onmouseout="this.style.color='#8f98a0'">${label}</a>`
	).join('');

	// If we found the native Notes region, use its classes for the link bar outer wrapper too
	if (anchorRegion) {
		const linkBarOuter = doc.createElement('div');
		linkBarOuter.className = anchorRegion.className;
		// The borrowed sidebar-region class carries section margins that push
		// the whole two-column row ~24px lower than the native page
		linkBarOuter.style.margin = '0';
		const regionChildren = Array.from(anchorRegion.children);
		const sourceBody = regionChildren.find(c => c.tagName === 'DIV') as HTMLElement | undefined;
		if (sourceBody) {
			const linkBarPanel = doc.createElement('div');
			linkBarPanel.className = sourceBody.className;
			linkBarPanel.appendChild(linkBar);
			linkBarOuter.appendChild(linkBarPanel);
		} else {
			linkBarOuter.appendChild(linkBar);
		}
		// Replace linkBar reference with the wrapped version for insertion
		linkBar.id = '';
		linkBarOuter.id = 'gdl-link-bar';

		// Insert before the two-column row (so it spans full width, below play area)
		if (twoColRow && twoColRow.parentElement) {
			twoColRow.parentElement.insertBefore(linkBarOuter, twoColRow);
		}
	} else {
		// Fallback: simple inline-styled link bar
		linkBar.style.cssText = 'display:flex;align-items:center;padding:8px 16px;background:#2a3040;border-bottom:1px solid rgba(255,255,255,0.06);';
	}

	// ── INSERT content wrapper ──
	if (contentColumn) {
		// Insert into the native left content column
		contentColumn.appendChild(wrapper);
	} else if (noticeParent && noticeParent.parentElement) {
		// Fallback: insert after notice
		noticeParent.parentElement.insertBefore(wrapper, noticeParent.nextSibling);
		// Also insert link bar before wrapper if it wasn't placed yet
		if (!doc.getElementById('gdl-link-bar') && wrapper.parentElement) {
			wrapper.parentElement.insertBefore(linkBar, wrapper);
		}
	}

	// ── Wire the status post box ──
	const statusArea = wrapper.querySelector('#gdl-status-text') as HTMLTextAreaElement | null;
	const statusRow = wrapper.querySelector('#gdl-status-controls') as HTMLElement | null;
	const postBtn = wrapper.querySelector('#gdl-status-post') as HTMLButtonElement | null;
	if (statusArea && statusRow && postBtn) {
		const activeClass = POST_CLASSES().Active;
		const enabledClass = POST_CLASSES().Enabled;
		const setActive = (on: boolean) => {
			statusRow.classList.toggle(activeClass, on);
			statusArea.rows = on ? 2 : 1;
		};
		statusArea.addEventListener('input', () => {
			postBtn.classList.toggle(enabledClass, statusArea.value.trim().length > 0);
		});
		statusArea.addEventListener('focus', () => setActive(true));
		statusArea.addEventListener('blur', () => {
			// Delay so a Post click still lands before the row collapses
			setTimeout(() => { if (!statusArea.value.trim() && doc.activeElement !== statusArea) setActive(false); }, 200);
		});
		statusArea.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) postBtn.click();
		});
		postBtn.addEventListener('click', async () => {
			const text = statusArea.value.trim();
			if (!text) return;
			postBtn.disabled = true;
			const ok = await postStatusUpdate(parseInt(steamAppId), text);
			postBtn.disabled = false;
			if (ok) {
				statusArea.value = '';
				postBtn.classList.remove(enabledClass);
				setActive(false);
				// Pull the fresh activity (including our post) once the server has it
				try { (window as any).appActivityStore?.FetchLatestActivity?.(parseInt(steamAppId), true); } catch {}
				setTimeout(() => populateActivityFeed(doc, steamAppId, data.name, data.header_image || '').catch(() => {}), 2000);
				setTimeout(() => populateActivityFeed(doc, steamAppId, data.name, data.header_image || '').catch(() => {}), 6000);
			}
		});
	}

	// ── INSERT community content - native section panel inside the content column ──
	if (communityHtml) {
		const node = buildSidebarSection(
			'gdl-community-content',
			loc('AppDetails_SectionTitle_Community', 'Community Content'),
			'gdl-community-inner',
			communityHtml,
			false
		);
		if (node && wrapper.parentElement) {
			node.style.marginTop = '16px';
			wrapper.parentElement.insertBefore(node, wrapper.nextSibling);
			// Help "?" bubble in the header like the native section
			const h2 = node.querySelector('h2');
			const txt = (h2?.querySelector('div div') || h2?.querySelector('div') || h2) as HTMLElement | null;
			if (txt) {
				const help = doc.createElement('span');
				help.textContent = '?';
				help.title = 'Community screenshots, artwork & guides';
				help.style.cssText = 'width:16px;height:16px;border-radius:50%;border:1px solid #8f98a0;display:inline-flex;align-items:center;justify-content:center;font-size:10px;color:#8f98a0;cursor:help;margin-inline-start:8px;vertical-align:middle;';
				txt.appendChild(help);
			}
		} else if (wrapper.parentElement) {
			// Fallback: plain container after the main wrapper
			const ccWrapper = doc.createElement('div');
			ccWrapper.id = 'gdl-community-content';
			ccWrapper.style.cssText = 'color:#acb2b8;font-family:inherit;padding:0 12px 24px;overflow:hidden;';
			ccWrapper.innerHTML = communityHtml;
			wrapper.parentElement.insertBefore(ccWrapper, wrapper.nextSibling);
		}
	}

	backendLog('Injected layout for: ' + data.name + ' (' + newsItems.length + ' news items)');
}

/** Remove all GDL-injected elements and restore hidden notices */
function cleanupInjection(doc: Document): void {
	for (const id of [GDL_INJECTED, 'gdl-skeleton', 'gdl-friends-section', 'gdl-achievements-section', 'gdl-playbar-achievements', 'gdl-link-bar', 'gdl-community-content', 'gdl-activity-feed']) {
		const el = doc.getElementById(id);
		if (el) el.remove();
	}
	// Restore any hidden notice elements
	doc.querySelectorAll('[data-gdl-hidden]').forEach(el => {
		(el as HTMLElement).style.display = '';
		el.removeAttribute('data-gdl-hidden');
	});
}

/** Track which game is currently injected so we can detect navigation */
let currentInjectedAppId: string | null = null;

const NON_STEAM_NOTICE_FALLBACK =
	'Some detailed information on %1$s is unavailable because it is a non-Steam game or mod. ' +
	'Steam will still manage launching the game for you and in most cases the in-game overlay will be available.';

/** Find the localized "non-Steam game" notice on the library page and extract the game title */
function findNonSteamNotice(doc: Document): { element: Element; title: string } | null {
	const template = loc('AppDetails_Shortcut_Explanation', NON_STEAM_NOTICE_FALLBACK);
	// Locate the notice text node via the longest literal chunk of the template
	// (the game name is substituted for %1$s, so literal chunks surround it)
	const anchorText = template
		.split('%1$s')
		.reduce((a, b) => (b.trim().length > a.trim().length ? b : a), '')
		.trim()
		.slice(0, 60);
	if (!anchorText) return null;
	const element = findElementByText(doc, anchorText);
	if (!element) return null;
	const rx = templateToRegex(template);
	const m = rx ? (element.textContent || '').match(rx) : null;
	if (!m || !m[1]) return null;
	return { element, title: m[1].trim() };
}

/** Check the library page for a mapped non-Steam game and inject data */
/** Guards against duplicate concurrent fetch passes for the same app */
let injectionInFlight: string | null = null;

/** Hide the notice + up to two single-child wrappers, without layout info */
function hideNoticeQuick(noticeElement: Element): void {
	let el: HTMLElement | null = noticeElement as HTMLElement;
	for (let i = 0; i < 2 && el; i++) {
		if (i > 0 && el.querySelector('[data-nsp]')) break;
		el.style.display = 'none';
		el.setAttribute('data-gdl-hidden', '1');
		const parent = el.parentElement;
		if (!parent || parent.childElementCount > 1) break;
		el = parent;
	}
}

/** Instant placeholder shown on first (uncached) visits while data loads */
function insertSkeleton(doc: Document, noticeElement: Element): void {
	if (doc.getElementById(GDL_INJECTED) || doc.getElementById('gdl-skeleton')) return;
	const host = noticeElement.closest('div')?.parentElement;
	if (!host) return;
	const sk = doc.createElement('div');
	sk.id = 'gdl-skeleton';
	sk.className = FEED_CLASSES().ActivityFeedContainer;
	sk.style.cssText = 'font-family:inherit;padding:0 12px 24px;overflow:hidden;';
	sk.innerHTML = `
		<div style="font-size:11px;font-weight:600;letter-spacing:1.5px;color:#8f98a0;margin-bottom:16px;">${escapeHtml(loc('AppDetails_SectionTitle_Activity', 'Activity').toUpperCase())}</div>
		<div class="${FEED_CLASSES().AddToFeed} ${FEED_CLASSES().PostTextEntry} ${POST_CLASSES().PostTextEntry}">
			<textarea class="${POST_CLASSES().PostTextEntryArea}" rows="1" placeholder="${escapeHtml(loc('AppActivity_StatusUpdate_Post', 'Say something about this game to your friends...'))}"></textarea>
		</div>`;
	host.appendChild(sk);
}

async function tryInjectLibraryData(doc: Document): Promise<void> {
	const noticeInfo = findNonSteamNotice(doc);

	// If no notice found, we navigated away from a non-Steam game - clean up
	if (!noticeInfo) {
		if (currentInjectedAppId) {
			cleanupInjection(doc);
			currentInjectedAppId = null;
		}
		return;
	}

	const notice = noticeInfo.element;
	const gameTitle = noticeInfo.title;
	const steamAppId = findMappingForTitle(gameTitle);
	if (!steamAppId) return;

	// Already injected for this exact game - but Steam's React re-renders can
	// evict just the play-bar stat while the rest survives, so re-heal it
	if (currentInjectedAppId === steamAppId && doc.getElementById(GDL_INJECTED)) {
		if (!doc.getElementById('gdl-playbar-achievements')) {
			const cachedTotal = gameDataCache[steamAppId]?.achievements?.total || 0;
			finalizeAchievements(doc, steamAppId, cachedTotal).catch(() => {});
		}
		return;
	}

	// Clean up previous injection if switching between non-Steam games
	if (currentInjectedAppId && currentInjectedAppId !== steamAppId) {
		cleanupInjection(doc);
	}
	currentInjectedAppId = steamAppId;

	backendLog('Library page: "' + gameTitle + '" -> injecting data for ' + steamAppId);

	// ── Instant path: render synchronously from caches so the native
	// "non-Steam game" notice never flashes on revisits ──
	const cachedData: SteamGameData | null =
		(gameDataCache[steamAppId] !== undefined ? gameDataCache[steamAppId] : cacheGet<SteamGameData>('gamedata_' + steamAppId)) || null;
	let renderedFromCache = false;
	let cacheMissedSections = false;
	if (cachedData && !doc.getElementById(GDL_INJECTED)) {
		gameDataCache[steamAppId] = cachedData;
		// News cache is per-language; readable synchronously only once detected
		const lang = steamLanguageSync();
		const cNews = lang ? (cacheGet<NewsItem[]>('events4_' + lang + '_' + steamAppId) || []) : [];
		const cFriends = cacheGet<FriendCategories>('friends_' + steamAppId) || null;
		const cCommunity = cacheGet<CommunityContentItem[]>('community3_' + steamAppId) || [];
		injectGameData(doc, notice, cachedData, steamAppId, cNews, cFriends, cCommunity);
		renderedFromCache = true;
		cacheMissedSections = cNews.length === 0 || !cFriends || cCommunity.length === 0;
	} else if (!cachedData) {
		// First visit: hide the notice and show a skeleton while data loads
		hideNoticeQuick(notice);
		insertSkeleton(doc, notice);
	}

	// Avoid duplicate concurrent fetch passes (leading + trailing observer runs)
	if (injectionInFlight === steamAppId) return;
	injectionInFlight = steamAppId;
	let data: SteamGameData | null = null;
	let newsItems: NewsItem[] = [];
	let friendData: { html: string; data: FriendCategories | null } = { html: '', data: null };
	let communityItems: CommunityContentItem[] = [];
	try {
		// Fetch in parallel - instant when the 24h caches are fresh
		[data, newsItems, friendData, communityItems] = await Promise.all([
			getGameData(steamAppId),
			getNews(steamAppId),
			getFriendData(steamAppId),
			getCommunityContent(steamAppId),
		]);
	} finally {
		injectionInFlight = null;
	}

	if (!data) {
		backendLog('No game data for: ' + steamAppId);
		return;
	}
	if (currentInjectedAppId !== steamAppId) return;

	// Full render - skipped when the cached render already produced identical
	// output; re-run if sections the cache lacked have now arrived
	if (!renderedFromCache || (cacheMissedSections && (newsItems.length > 0 || friendData.data?.totalCount || communityItems.length > 0))) {
		injectGameData(doc, notice, data, steamAppId, newsItems, friendData.data, communityItems);
	}

	// ── Background: fetch friend personas and update sidebar ──
	const hasFriendsData = friendData.data && friendData.data.totalCount > 0;
	if (hasFriendsData) {
		const recentIds = friendData.data!.recentlyPlayed.map((f: FriendPlayInfo) => f.steamid);
		const prevIds = friendData.data!.previouslyPlayed.map((f: FriendPlayInfo) => f.steamid);
		const idsToFetch = [...recentIds.slice(0, 12), ...prevIds.slice(0, 18)];
		const allCached = idsToFetch.every((s: string) => personaCache.has(s));
		if (allCached) {
			const personas = idsToFetch.map((s: string) => personaCache.get(s)!);
			const el = doc.getElementById('gdl-friends-content');
			if (el) el.innerHTML = renderFriendsSection(friendData.data, steamAppId, data!.name, personas);
		} else {
			backendLog('Fetching personas for ' + idsToFetch.length + ' friends...');
			fetchFriendPersonasBackend({ steam_ids_csv: idsToFetch.join(',') })
				.then(json => {
					const personas: FriendPersona[] = JSON.parse(json);
					for (const p of personas) personaCache.set(p.steamid, p);
					const el = doc.getElementById('gdl-friends-content');
					if (el) el.innerHTML = renderFriendsSection(friendData.data, steamAppId, data!.name, personas);
				})
				.catch(err => { backendLog('Persona fetch error: ' + String(err)); });
		}
	}

	// ── Background: real activity feed (achievements, screenshots, reviews, new owners) ──
	populateActivityFeed(doc, steamAppId, data.name, data.header_image || '').catch(e => backendLog('Activity feed error: ' + e));

	// ── Background: real achievement progress → play bar stat + sidebar panel ──
	finalizeAchievements(doc, steamAppId, data.achievements?.total || 0).catch(e => backendLog('Achievements error: ' + e));
}

// ── Window create hook ─────────────────────────────────────────────────

const observedDocs = new Set<Document>();

function windowCreated(context: any): void {
	const popupWin: Window | undefined = context?.window;
	const popupDoc: Document | undefined = popupWin?.document;
	const popupName: string = context?.m_strName || '';
	const popupTitle: string = context?.m_strTitle || '';

	if (!popupDoc?.body) return;

	if (observedDocs.has(popupDoc)) return;
	observedDocs.add(popupDoc);

	const isMainWindow = popupName.includes('SP Desktop') && !popupName.includes('Login');

	if (isMainWindow) mainWindowDoc = popupDoc;

	let mutationTimer: ReturnType<typeof setTimeout> | null = null;
	const runInjection = () => {
		// Properties dialogs are their own popup windows - never scan the main
		// window for them, or loose text matches can plant the form in the library
		if (isMainWindow) tryInjectLibraryData(popupDoc);
		else tryInjectPropertiesField(popupDoc, popupTitle);
	};
	const observer = new MutationObserver(() => {
		if (mutationTimer) return;
		// Leading edge: react to page changes instantly, then settle with a
		// trailing pass after the debounce window
		runInjection();
		mutationTimer = setTimeout(() => {
			mutationTimer = null;
			runInjection();
		}, 300);
	});
	observer.observe(popupDoc.body, { childList: true, subtree: true });

	setTimeout(() => {
		tryInjectPropertiesField(popupDoc, popupTitle);
		if (isMainWindow) tryInjectLibraryData(popupDoc);
	}, 500);
}

// ── Plugin entry point ─────────────────────────────────────────────────

const SettingsContent = () => (
	<div style={{ fontSize: '13px', color: '#acb2b8', lineHeight: '1.6' }}>
		<div style={{ marginBottom: '8px', fontWeight: 600, color: '#dcdedf' }}>
			Game Data Linker
		</div>
		<div>
			Right-click any non-Steam game &rarr; <b>Properties</b> &rarr; enter a Steam
			AppID in the <b>Linked Steam AppID</b> section. The library page will show
			that game's description, screenshots, and metadata.
		</div>
	</div>
);

export default definePlugin(() => {
	console.log('[GDL] definePlugin callback executing - frontend initialized successfully');

	loadMappings()
		.then(() => {
			backendLog('Loaded ' + Object.keys(mappings).length + ' mapping(s)');
		})
		.catch((e) => {
			console.error('[GDL] Failed to load mappings from backend:', e);
			// Continue anyway - the UI should still work, just without saved mappings
		});

	// Detect the UI language early so cached news can be read synchronously
	getSteamLanguage().catch(() => {});

	Millennium.AddWindowCreateHook(windowCreated);
	console.log('[GDL] Window create hook registered');

	return {
		title: 'Game Data Linker',
		icon: <IconsModule.Settings />,
		content: <SettingsContent />,
	};
});
