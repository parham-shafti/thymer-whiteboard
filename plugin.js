// Whiteboard — an infinite canvas for Thymer.
// Boards are records in a "Boards" collection; the scene is JSON in the Scene file property.
// Rendering is DOM + SVG inside one transformed layer (no <canvas>), so text is real text.
// See PLAN.md / RESEARCH.md / HANDOVER.md in Thymer_plugins/whiteboard.

const WB_VERSION = '1.0.0';
const WB_PANEL = 'whiteboard-board';
const WB_BOARDS = 'Boards';
const WB_SCENE_FILE = 'whiteboard.json';
const WB_F = {
	scene: { id: 'FWBSCENE0000001', label: 'Scene', type: 'file', icon: 'ti-layout-board' },
	page: { id: 'FWBPAGE00000001', label: 'Page', type: 'record', icon: 'ti-file-text' },
	rev: { id: 'FWBREV000000001', label: 'Revision', type: 'text', icon: 'ti-history' }, // the save counter, read before every save so two devices never overwrite each other blindly
};
// ---- local safety net: the last 20 saved versions of every board, kept in the app's IndexedDB before each upload ----
const WB_BACKUP_KEEP = 20;
const WB_SAVE_MAX = 4000;
const WB_LISTENERS = (window.__wbListenerDisposers = window.__wbListenerDisposers || []); // survives a code reload on purpose
const WB_GEN = (window.__wbGen = (window.__wbGen || 0) + 1); // this code load's generation; older loads go quiet // a save is never postponed longer than this, however long the user keeps working
// These two live on window on purpose: a plugin code reload creates a NEW Plugin object, and everything on the old one is
// lost. Without them a reload mounts a fresh board that reads the SERVER copy while the old board's last save is still
// in flight, and the next save writes the older scene back over it. That is how work was lost across updates.
const WB_CACHE = (window.__wbSceneCache = window.__wbSceneCache || new Map()); // guid -> {rev, json, at, pending}
const WB_INFLIGHT = (window.__wbSceneSaving = window.__wbSceneSaving || new Map()); // guid -> the save promise still running
// DATA LOSS #2 (2026-09-25): the web client opened a large board from a local store that had not synced since mid-September and uploaded
// that copy over 417 items. Every revision check compared against the same stale store, so none of them could see it. Nothing is
// uploaded until this page has evidence that its store caught up with the server. Two kinds count:
// (1) the sync worker's status on the app root (prevStatus) saying it has had a reply and has no delta pages left. It is posted
//     only when it stayed unchanged for 100 ms, so it often stays at the start-up snapshot ("syncing, no reply") for hours: good
//     as a yes, useless as a no (0.37.0 used it alone and froze every board on the phone and on a restarted desktop, 2026-09-26);
// (2) the worker's "sync/Processed" event, sent after EVERY processed sync reply, heard through the app root's own event
//     subscription; ready once one has come and 4 s pass without another (delta pages arrive back to back), or 30 s after the
//     first if the traffic never pauses.
// Offline is the browser's word (navigator.onLine), because a stale status can claim either way. Offline un-latches, and only
// evidence from after it counts. No evidence = not ready: a stalled save keeps its copy on the device, a stale save destroys work.
const WB_SYNC = (window.__wbSync = window.__wbSync || { ok: false, lostAt: 0 });
const WB_LOADINFO = (window.__wbLoadInfo = window.__wbLoadInfo || new Map()); // board guid -> {src, serverJson}: what the last load chose, and the server copy it read (the merge base)
const WB_SYNC_COL = 'Whiteboard sync';
function wbSyncStatus() { try { const r = wbRoot(); return (r && r.prevStatus) || null; } catch (e) { return null; } }
function wbSyncReady() {
	if (navigator.onLine === false) { WB_SYNC.ok = false; WB_SYNC.lostAt = Date.now(); WB_SYNC.firstProcessedAt = 0; return false; }
	if (WB_SYNC.ok) return true;
	const s = wbSyncStatus();
	if (s && s.isOnline === true && s.hasWebsocket === true && !s.needsLogin && !s.isFatal && !s.isAirplaneMode && s.lastSyncReplyTime != null && !s.isSyncing && !s.isDownloadingInitialWorkspaces && (!WB_SYNC.lostAt || s.lastSyncReplyTime > WB_SYNC.lostAt)) { WB_SYNC.ok = true; WB_SYNC.why = 'status'; return true; }
	const p = WB_SYNC.processedAt || 0, f = WB_SYNC.firstProcessedAt || 0;
	if (p && f && p > (WB_SYNC.lostAt || 0)) { const now = Date.now(); if (now - p >= 4000 || now - f >= 30000) { WB_SYNC.ok = true; WB_SYNC.why = 'processed'; return true; } }
	return false;
}
// Subscribes to the worker's "sync/Processed" through the app root's own subscription method. Its minified name changes between
// builds, so it is found by what it does: the one method that pushes {appEventName, eventHandlerId} onto _appEventHandlers.
// The handler of an older code load stays registered (no removal is reachable) and goes quiet on the generation check.
function wbHookSyncProcessed() {
	if (WB_SYNC.hookGen === WB_GEN) return true;
	const root = wbRoot(); if (!root) return false;
	let fn = null; for (let p = root; p && !fn; p = Object.getPrototypeOf(p)) { for (const k of Object.getOwnPropertyNames(p)) { if (k === 'constructor') continue; let f; try { f = p[k]; } catch (e) { continue; } if (typeof f !== 'function') continue; const src = Function.prototype.toString.call(f); if (src.length < 600 && /_appEventHandlers\.push\(\{appEventName/.test(src)) { fn = f; break; } } }
	if (!fn) { if (!WB_SYNC.hookMissing) { WB_SYNC.hookMissing = true; console.warn('[Whiteboard] cannot subscribe to sync/Processed; boards save only once the sync status says caught up'); wbTrace('sync hook missing'); } return false; }
	try { fn.call(root, 'sync/Processed', () => { if (WB_GEN !== window.__wbGen) return; const now = Date.now(); WB_SYNC.processedAt = now; if (!WB_SYNC.firstProcessedAt) WB_SYNC.firstProcessedAt = now; }); } catch (e) { return false; }
	WB_SYNC.hookGen = WB_GEN; WB_SYNC.hookMissing = false; return true;
}
// Opening with NO version number is the only safe way here: a version number can trigger an upgrade, an upgrade is
// blocked whenever any other connection to the database is open (the pre-reload plugin instance always holds one), and a
// blocked upgrade request QUEUES EVERY LATER OPEN on that database for the life of the page. That is what wedged the
// local safety net on 2026-09-06. The store is created only when it is genuinely missing, on a fresh database.
function wbBackupDb() {
	if (wbBackupDb._p) return wbBackupDb._p;
	if (wbBackupDb._cool && Date.now() < wbBackupDb._cool) return Promise.resolve(null); // a wedged database is retried at most once a minute
	const open = (ver) => new Promise((res) => {
		try {
			const rq = ver ? indexedDB.open('wb-board-backups', ver) : indexedDB.open('wb-board-backups');
			rq.onupgradeneeded = () => { const db = rq.result; if (!db.objectStoreNames.contains('scenes')) { const st = db.createObjectStore('scenes', { keyPath: 'key' }); st.createIndex('board', 'board'); } };
			rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null); rq.onblocked = () => res(null);
			setTimeout(() => res(null), 3000);
		} catch (e) { res(null); }
	});
	const p = (async () => {
		let db = await open(null);
		if (db && !db.objectStoreNames.contains('scenes')) { const v = db.version + 1; try { db.close(); } catch (e) {} db = await open(v); }
		if (!db) { wbBackupDb._p = null; wbBackupDb._cool = Date.now() + 60000; }
		return db;
	})();
	wbBackupDb._p = p;
	return p;
}
async function wbBackupPut(board, rev, json, count) {
	const db = await wbBackupDb(); if (!db) return false;
	return new Promise((res) => { try { const tx = db.transaction('scenes', 'readwrite'); const st = tx.objectStore('scenes'); st.put({ key: board + ':' + String(rev).padStart(8, '0'), board, rev, t: Date.now(), count, json });
		const idx = st.index('board'); const keys = []; idx.openKeyCursor(IDBKeyRange.only(board)).onsuccess = (ev) => { const c = ev.target.result; if (c) { keys.push(c.primaryKey); c.continue(); } else { keys.sort(); while (keys.length > WB_BACKUP_KEEP) st.delete(keys.shift()); } };
		tx.oncomplete = () => res(true); tx.onerror = () => res(false); } catch (e) { res(false); } });
}
// The work-in-progress copy: written every half second while the user works, read back when a board is opened.
// It survives a reload of the app itself, which the in-memory cache does not.
function wbCachePut(guid, v) { WB_CACHE.set(guid, v); if (WB_CACHE.size > 8) { const k = WB_CACHE.keys().next().value; if (k !== guid) WB_CACHE.delete(k); } }
const wbPendKey = (board) => board + ':pending'; // sorts after the ':00000042' backup keys, so the trim in wbBackupPut never eats it
async function wbPendingPut(board, rev, json, count) {
	const db = await wbBackupDb(); if (!db) return false;
	return new Promise((res) => { try { const tx = db.transaction('scenes', 'readwrite'); tx.objectStore('scenes').put({ key: wbPendKey(board), board, rev, t: Date.now(), at: Date.now(), count, json, pending: true }); tx.oncomplete = () => res(true); tx.onerror = () => res(false); } catch (e) { res(false); } });
}
async function wbPendingDel(board) {
	const db = await wbBackupDb(); if (!db) return false;
	return new Promise((res) => { try { const tx = db.transaction('scenes', 'readwrite'); tx.objectStore('scenes').delete(wbPendKey(board)); tx.oncomplete = () => res(true); tx.onerror = () => res(false); } catch (e) { res(false); } });
}
async function wbPendingGet(board) {
	const db = await wbBackupDb(); if (!db) return null;
	return new Promise((res) => { try { const rq = db.transaction('scenes').objectStore('scenes').get(wbPendKey(board)); rq.onsuccess = () => res(rq.result || null); rq.onerror = () => res(null); } catch (e) { res(null); } });
}
async function wbBackupList(board) {
	const db = await wbBackupDb(); if (!db) return [];
	return new Promise((res) => { try { const out = []; const idx = db.transaction('scenes').objectStore('scenes').index('board'); idx.openCursor(IDBKeyRange.only(board), 'prev').onsuccess = (ev) => { const c = ev.target.result; if (c) { const v = c.value; if (!v.pending) out.push({ key: v.key, rev: v.rev, t: v.t, count: v.count, json: v.json }); c.continue(); } else res(out); }; } catch (e) { res([]); } });
}
// ---- images are shrunk before upload: a phone photo is 3-8 MB, the board needs at most 2048 px ----
const WB_IMG_MAX = 2048;
async function wbShrinkImage(file) {
	if (!/^image\/(jpeg|png|webp|heic|heif|bmp|tiff?)$/i.test(file.type)) return file; // gif (animation) and svg stay as they are
	try {
		const bmp = await createImageBitmap(file); const k = Math.min(1, WB_IMG_MAX / Math.max(bmp.width, bmp.height));
		if (k === 1 && file.size < 900 * 1024) { bmp.close(); return file; }
		const cv = document.createElement('canvas'); cv.width = Math.max(1, Math.round(bmp.width * k)); cv.height = Math.max(1, Math.round(bmp.height * k));
		cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height); bmp.close();
		const png = /png$/i.test(file.type); const out = await new Promise((res) => cv.toBlob(res, png ? 'image/png' : 'image/jpeg', 0.86));
		if (!out) return file; const name = (file.name || 'image').replace(/\.[a-z0-9]+$/i, '') + (png ? '.png' : '.jpg');
		return new File([out], name, { type: out.type });
	} catch (e) { return file; }
}
const WB_F_BOARDS = { id: 'FWBBOARDS000001', label: 'Boards', icon: 'ti-layout-board' }; // added to a PAGE's collection: the boards that belong to the page
const WB_F_KIND_OLD = 'FWBKIND00000001';
// Thymer's shortcut store: `activeUser.acct_json.kbd[<platform>]` is the user's own "action": "Chord" text (comments allowed),
// defaults per platform below (from the app bundle). A chord is compared as modifier SET + key, so order never matters.
const WB_IS_MAC = /Mac OS/.test(navigator.userAgent);
const WB_KBD_DEFAULTS = WB_IS_MAC
	? { 'panel.history_back': 'Meta+[', 'panel.history_forward': 'Meta+]', 'global.journal_gohome': 'Meta+J' }
	: { 'panel.history_back': 'Alt+Left', 'panel.history_forward': 'Alt+Right', 'global.journal_gohome': 'Ctrl+J' };
function wbNavCopy(nav) { try { if (!nav || typeof nav !== 'object') return null; const c = JSON.parse(JSON.stringify(nav)); if (c.type === 'custom') return null; return c; } catch (e) { return null; } }
function wbKbdPlatform() { const el = !!(window.thymerDesktopAPI || /Electron/i.test(navigator.userAgent)); return (WB_IS_MAC ? 'mac' : 'win') + (el ? '_electron' : '_web'); }
function wbChordNorm(str) {
	const parts = String(str || '').split('+').map((x) => x.trim()).filter(Boolean); if (!parts.length) return null;
	const mods = new Set(); let key = '';
	for (const p of parts) { const l = p.toLowerCase(); if (l === 'meta' || l === 'cmd' || l === 'command') mods.add('Meta'); else if (l === 'ctrl' || l === 'control') mods.add('Ctrl'); else if (l === 'alt' || l === 'option') mods.add('Alt'); else if (l === 'shift') mods.add('Shift'); else key = p; }
	key = key.replace(/^Arrow/, ''); if (key.length === 1) key = key.toUpperCase();
	return { mods: [...mods].sort().join('+'), key };
}
function wbUserChords(plugin) {
	const out = Object.assign({}, WB_KBD_DEFAULTS);
	try {
		const user = (plugin && plugin.user) || (window.g_universe && window.g_universe.activeUser) || null;
		const txt = user && user.acct_json && user.acct_json.kbd && user.acct_json.kbd[wbKbdPlatform()];
		if (typeof txt === 'string' && txt.trim()) {
			for (const raw of txt.split('\n')) {
				const n = raw.trim(); if (!n || n.startsWith('//') || n === '{' || n === '}') continue;
				const m = n.match(/^(?:"([^"]*)"|'([^']*)')\s*:\s*(?:"([^"]*)"|'([^']*)')\s*,?/); if (!m) continue;
				const action = (m[1] != null ? m[1] : m[2]) || ''; const key = (m[3] != null ? m[3] : m[4]) || '';
				if (!action) { for (const a in out) if (out[a] && wbSameChord(out[a], key)) out[a] = ''; continue; } // "": "Chord" unbinds that chord
				if (action.toLowerCase() in out) out[action.toLowerCase()] = key; // "" = unbound
			}
		}
	} catch (e) {}
	return out;
}
function wbSameChord(a, b) { const x = wbChordNorm(a), y = wbChordNorm(b); return !!(x && y && x.mods === y.mods && x.key === y.key); }
function wbEventChord(e) {
	const mods = []; if (e.metaKey) mods.push('Meta'); if (e.ctrlKey) mods.push('Ctrl'); if (e.altKey) mods.push('Alt'); if (e.shiftKey) mods.push('Shift');
	let key = e.code === 'BracketLeft' ? '[' : e.code === 'BracketRight' ? ']' : e.code === 'Space' ? 'Space' : (e.key || '');
	if (key.length === 1) { if (e.altKey || e.metaKey) { const c = String(e.code || ''); if (/^Key[A-Z]$/.test(c)) key = c.slice(3); else if (/^Digit\d$/.test(c)) key = c.slice(5); } key = key.toUpperCase(); }
	return { mods: mods.sort().join('+'), key: key.replace(/^Arrow/, '') };
}
function wbMatchAction(e, plugin) { const ev = wbEventChord(e); if (!ev.mods && ev.key.length === 1) return null; const table = wbUserChords(plugin); for (const a in table) { const c = wbChordNorm(table[a]); if (c && c.mods === ev.mods && c.key === ev.key) return a; } return null; } // retired 0.2.7: a board is a collection board iff Mirrors is set
const WB_STICKY_COLORS = [
	{ id: 'yellow', hex: '#F2DF73' }, { id: 'orange', hex: '#F5B36B' }, { id: 'red', hex: '#F08A80' },
	{ id: 'pink', hex: '#F0A0C8' }, { id: 'purple', hex: '#C9A8F0' }, { id: 'blue', hex: '#9DB9F2' },
	{ id: 'cyan', hex: '#8FDCE6' }, { id: 'green', hex: '#A6E3A1' }, { id: 'lime', hex: '#D4EB8E' },
	{ id: 'gray', hex: '#D5D5D8' }, { id: 'white', hex: '#F7F7F5' }, { id: 'black', hex: '#2A2A2E', fg: '#F2F2F2' },
	// deeper tones, mostly for board and frame backgrounds
	{ id: 'navy', hex: '#2F4A6D', fg: '#F2F2F2' }, { id: 'forest', hex: '#3F6B4A', fg: '#F2F2F2' }, { id: 'plum', hex: '#6B3F6B', fg: '#F2F2F2' }, { id: 'brown', hex: '#7A5A3A', fg: '#F2F2F2' }, { id: 'charcoal', hex: '#3A3A3F', fg: '#F2F2F2' },
];
const WB_SHAPES = ['rect', 'rounded', 'ellipse', 'diamond', 'pill', 'triangle', 'arrow'];
const WB_STACK_SIZES = { s: 120, m: 170, l: 240 }; // the notes a sticky stack hands out (note width)
// A stack's box wraps the note it hands out: 12 % of the width as air on every side, a title strip 20 % tall on top.
// Only the width is free (corners resize proportionally); the height follows the note's shape (square or wide).
function wbStackGeom(n) { const pad = n.w * 0.12, th = n.w * 0.2, nw = n.w - 2 * pad, nh = nw * (n.shape === 'wide' ? 150 / 260 : 1); return { pad, th, nw: Math.round(nw), nh: Math.round(nh), h: Math.round(th + nh + 2 * pad) }; }
function wbStickyPad(n) { return Math.max(4, Math.min(14, Math.round(Math.min(n.w, n.h) * 0.1))); }
function wbStackSizeKey(n) { const nw = wbStackGeom(n).nw; for (const k in WB_STACK_SIZES) if (Math.abs(WB_STACK_SIZES[k] - nw) <= 2) return k; return 'custom'; }
function wbStackWidthFor(noteW) { return Math.round(noteW / 0.76); }
// Frame formats (Miro's set). w/h are the default size when a frame is placed; ratio = h / w for reformatting.
const WB_FRAME_FORMATS = [
	{ id: 'custom', label: 'Custom', w: 600, h: 400, ratio: null, icon: '<path d="M7 3v18M17 3v18M3 7h18M3 17h18"></path>' },
	{ id: 'a4', label: 'A4', w: 480, h: 679, ratio: 1.4142, icon: '<path d="M6 3h8l4 4v14H6z"></path><path d="M14 3v4h4"></path>' },
	{ id: 'letter', label: 'Letter', w: 480, h: 621, ratio: 1.2941, icon: '<path d="M6 3h8l4 4v14H6z"></path><path d="M14 3v4h4"></path>' },
	{ id: '16:9', label: '16 : 9', w: 640, h: 360, ratio: 0.5625, icon: '<rect x="3" y="7" width="18" height="10" rx="1"></rect>' },
	{ id: '4:3', label: '4 : 3', w: 640, h: 480, ratio: 0.75, icon: '<rect x="4" y="6" width="16" height="12" rx="1"></rect>' },
	{ id: '1:1', label: '1 : 1', w: 480, h: 480, ratio: 1, icon: '<rect x="6" y="6" width="12" height="12" rx="1"></rect>' },
	{ id: 'mobile', label: 'Mobile', w: 360, h: 780, ratio: 2.1667, icon: '<rect x="7" y="3" width="10" height="18" rx="2"></rect><path d="M10 18h4"></path>' },
	{ id: 'tablet', label: 'Tablet', w: 600, h: 800, ratio: 1.3333, icon: '<rect x="5" y="3" width="14" height="18" rx="2"></rect><path d="M10 18h4"></path>' },
	{ id: 'desktop', label: 'Desktop', w: 800, h: 500, ratio: 0.625, icon: '<rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M6 8h1M9 8h1M12 8h1"></path>' },
];
let wbIconNames = null;
function wbIconList() {
	if (wbIconNames) return wbIconNames; const names = new Set();
	try { for (const ss of [...document.styleSheets]) { let rules = null; try { rules = ss.cssRules; } catch (e) { continue; } for (const r of rules) { if (!r.selectorText || !r.style || !r.style.content || r.style.content === 'none') continue; for (const sel of r.selectorText.split(',')) { const m = sel.trim().match(/^\.(ti-[a-z0-9-]+)::?before$/); if (m) names.add(m[1]); } } } } catch (e) {}
	wbIconNames = [...names].sort(); return wbIconNames;
}
function wbFrameFormat(id) { return WB_FRAME_FORMATS.find((f) => f.id === id) || WB_FRAME_FORMATS[0]; }
const WB_GRID = 12;
const WB_MIN_ZOOM = 0.1, WB_MAX_ZOOM = 4;

// Inline stroke icons (Tabler-style, 24 grid). Kept as strings; no backticks anywhere in this file's CSS/HTML.
const WB_SVG = (paths, extra) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"' + (extra || '') + '>' + paths + '</svg>';
const WB_I = {
	frame: WB_SVG('<path d="M4 8h16v12H4z"></path><path d="M4 8V5h7v3"></path>'),
	strike: WB_SVG('<path d="M5 12h14"></path><path d="M16 6.5A4 4 0 0 0 12 5c-2.5 0-4 1.3-4 3 0 1 .5 1.8 1.5 2.4"></path><path d="M8.5 17.5A4.5 4.5 0 0 0 12 19c2.5 0 4-1.3 4-3 0-.9-.4-1.6-1.2-2.2"></path>'),
	stack: WB_SVG('<path d="M6 8h12v11H6z"></path><path d="M8 5h11v11"></path>'),
	tag: WB_SVG('<path d="M4 4h7l9 9-7 7-9-9z"></path><circle cx="8.5" cy="8.5" r="1"></circle>'),
	moveTo: WB_SVG('<path d="M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5"></path><path d="M3 12h11"></path><path d="M10 8l4 4-4 4"></path>'),
	subboard: WB_SVG('<rect x="3" y="3" width="18" height="18" rx="2"></rect><rect x="8" y="8" width="8" height="8" rx="1"></rect>'),
	focus: WB_SVG('<circle cx="12" cy="12" r="3"></circle><path d="M12 3v3M12 18v3M3 12h3M18 12h3"></path>'),
	lock: WB_SVG('<rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path>'),
	lockOpen: WB_SVG('<rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 7.5-2"></path>'),
	select: WB_SVG('<path d="M4 4l7.07 17 2.51-7.39L21 11.07z"></path>'),
	sticky: WB_SVG('<path d="M4 4h16v10l-6 6H4z"></path><path d="M14 20v-6h6"></path>'),
	stickyWide: WB_SVG('<path d="M2 6h20v8l-4 4H2z"></path><path d="M18 18v-4h4"></path>'),
	text: WB_SVG('<path d="M6 5h12"></path><path d="M12 5v14"></path><path d="M9 19h6"></path>'),
	shape: WB_SVG('<path d="M3 3h8v8H3z"></path><circle cx="17" cy="17" r="4"></circle>'),
	image: WB_SVG('<path d="M4 5h16v14H4z"></path><path d="M4 16l4-4 4 4 3-3 5 5"></path><circle cx="15.5" cy="9.5" r="1.5"></circle>'),
	note: WB_SVG('<rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M7 10h10"></path><path d="M7 14h6"></path>'),
	card: WB_SVG('<path d="M6 3h9l4 4v14H6z"></path><path d="M15 3v4h4"></path><path d="M9 12h6"></path><path d="M9 16h6"></path>'),
	connect: WB_SVG('<path d="M5 19l14-14"></path><path d="M14 5h5v5"></path>'),
	comment: WB_SVG('<path d="M21 12a8 8 0 0 1-8 8H8l-4 3V12a8 8 0 0 1 8-8h1a8 8 0 0 1 8 8z"></path>'),
	bold: WB_SVG('<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7z"></path><path d="M7 12h7a3.5 3.5 0 0 1 0 7H7z"></path>', ' style="stroke-width:2"'),
	italic: WB_SVG('<path d="M11 5h6"></path><path d="M7 19h6"></path><path d="M14 5l-4 14"></path>'),
	alignL: WB_SVG('<path d="M4 6h16"></path><path d="M4 12h10"></path><path d="M4 18h14"></path>'),
	alignC: WB_SVG('<path d="M4 6h16"></path><path d="M8 12h8"></path><path d="M6 18h12"></path>'),
	alignR: WB_SVG('<path d="M4 6h16"></path><path d="M10 12h10"></path><path d="M6 18h14"></path>'),
	more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6"></circle><circle cx="12" cy="12" r="1.6"></circle><circle cx="19" cy="12" r="1.6"></circle></svg>',
	chev: WB_SVG('<path d="M6 9l6 6 6-6"></path>', ' style="width:11px;height:11px"'),
	trash: WB_SVG('<path d="M4 7h16"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M5 7l1 12h12l1-12"></path><path d="M9 7V4h6v3"></path>'),
	dup: WB_SVG('<rect x="8" y="8" width="12" height="12" rx="2"></rect><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path>'),
	fit: WB_SVG('<path d="M4 8V4h4"></path><path d="M16 4h4v4"></path><path d="M4 16v4h4"></path><path d="M16 20h4v-4"></path>'),
	minus: WB_SVG('<path d="M5 12h14"></path>'),
	plus: WB_SVG('<path d="M12 5v14"></path><path d="M5 12h14"></path>'),
	straight: WB_SVG('<path d="M4 18L20 6"></path>'),
	underline: WB_SVG('<path d="M7 4v6a5 5 0 0 0 10 0V4"></path><path d="M5 20h14"></path>'),
	curved: WB_SVG('<path d="M4 18C10 18 14 6 20 6"></path>'),
	elbow: WB_SVG('<path d="M4 18h8V6h8"></path>'),
	arrowEnd: WB_SVG('<path d="M4 12h14"></path><path d="M14 8l4 4-4 4"></path>'),
	arrowStart: WB_SVG('<path d="M20 12H6"></path><path d="M10 8l-4 4 4 4"></path>'),
	dash: WB_SVG('<path d="M4 12h4"></path><path d="M10 12h4"></path><path d="M16 12h4"></path>'),
	label: WB_SVG('<path d="M6 5h12"></path><path d="M12 5v14"></path>'),
	board: WB_SVG('<path d="M4 4h16v16H4z"></path><path d="M9 4v16"></path>'),
	objAlign: WB_SVG('<path d="M4 4v16"></path><rect x="7" y="7" width="12" height="4" fill="currentColor" stroke="none"></rect><rect x="7" y="13" width="8" height="4" fill="currentColor" stroke="none"></rect>'),
	gear: WB_SVG('<path d="M10.3 4.3a1.7 1.7 0 0 1 3.4 0l.1.6a1.7 1.7 0 0 0 2.6 1.1l.5-.3a1.7 1.7 0 0 1 2.4 2.4l-.3.5a1.7 1.7 0 0 0 1.1 2.6l.6.1a1.7 1.7 0 0 1 0 3.4l-.6.1a1.7 1.7 0 0 0-1.1 2.6l.3.5a1.7 1.7 0 0 1-2.4 2.4l-.5-.3a1.7 1.7 0 0 0-2.6 1.1l-.1.6a1.7 1.7 0 0 1-3.4 0l-.1-.6a1.7 1.7 0 0 0-2.6-1.1l-.5.3a1.7 1.7 0 0 1-2.4-2.4l.3-.5a1.7 1.7 0 0 0-1.1-2.6l-.6-.1a1.7 1.7 0 0 1 0-3.4l.6-.1a1.7 1.7 0 0 0 1.1-2.6l-.3-.5a1.7 1.7 0 0 1 2.4-2.4l.5.3a1.7 1.7 0 0 0 2.6-1.1z"></path><circle cx="12" cy="12" r="3"></circle>'),
	open: WB_SVG('<path d="M5 12h14"></path><path d="M13 6l6 6-6 6"></path>'),
	lineDash: WB_SVG('<path d="M4 12h3"></path><path d="M10 12h4"></path><path d="M17 12h3"></path>'),
	lineDot: WB_SVG('<path d="M4 12h.5"></path><path d="M8 12h.5"></path><path d="M12 12h.5"></path><path d="M16 12h.5"></path><path d="M20 12h.5"></path>', ' style="stroke-width:2.5"'),
	lineSolid: WB_SVG('<path d="M4 12h16"></path>'),
	mind: WB_SVG('<circle cx="12" cy="12" r="3"></circle><path d="M12 9V4M12 15v5M9 12H4M15 12h5"></path>'),
	thick: WB_SVG('<path d="M4 6h16" stroke-width="1"></path><path d="M4 12h16" stroke-width="2.2"></path><path d="M4 18h16" stroke-width="3.6"></path>'),
	zfront: WB_SVG('<rect x="8" y="3" width="13" height="13" rx="1.5"></rect><path d="M3 8v10a3 3 0 0 0 3 3h10"></path>'),
	zup: WB_SVG('<path d="M12 19V5"></path><path d="m6 11 6-6 6 6"></path>'),
	zdown: WB_SVG('<path d="M12 5v14"></path><path d="m6 13 6 6 6-6"></path>'),
	zback: WB_SVG('<rect x="3" y="8" width="13" height="13" rx="1.5"></rect><path d="M8 3h10a3 3 0 0 1 3 3v10"></path>'),
};
const WB_SHAPE_ICON = {
	rect: WB_SVG('<rect x="3" y="4" width="18" height="16"></rect>'),
	rounded: WB_SVG('<rect x="3" y="4" width="18" height="16" rx="5"></rect>'),
	ellipse: WB_SVG('<ellipse cx="12" cy="12" rx="9.5" ry="8"></ellipse>'),
	diamond: WB_SVG('<path d="M12 2l10 10-10 10L2 12z"></path>'),
	pill: WB_SVG('<rect x="2" y="7" width="20" height="10" rx="5"></rect>'),
	triangle: WB_SVG('<path d="M12 3l9.5 18h-19z"></path>'),
	arrow: WB_SVG('<path d="M3 8h11V4l7 8-7 8v-4H3z"></path>'),
};

// ---------------------------------------------------------------------------
// CSS. Scoped under .wb-host. Tokens alias Thymer's own vars with fallbacks; a forced
// light/dark board overrides the token layer only. No backticks in here.
// ---------------------------------------------------------------------------
const WB_CSS = [
'.wb-host{--wb-bg:var(--color-bg-900,var(--panel-bg-color,light-dark(#fcfcfd,#0a0a0b)));--wb-surface:var(--cmdpal-bg-color,var(--color-bg-700,light-dark(#f7f7f8,#212126)));--wb-text:var(--text-color,var(--color-text-300,light-dark(#525655,#c4c4c4)));--wb-muted:var(--color-text-700,light-dark(#787d7c,#8a8a8a));--wb-faint:var(--color-text-800,light-dark(#969b9a,#6b6b6b));--wb-accent:var(--color-primary-500,light-dark(#3f8484,#65c8bb));--wb-line:color-mix(in srgb,var(--text-color,#c4c4c4) 14%,transparent);--wb-grid:color-mix(in srgb,var(--text-color,#c4c4c4) 13%,transparent);--wb-card:var(--cards-bg,light-dark(#ffffff,#111113));--wb-card-line:var(--cards-border-color,light-dark(#e6e6ea,#212126));--wb-shadow:var(--color-shadow-cards,0 4px 6px rgba(0,0,0,.2));--wb-sticky-shadow:0 1px 0 rgba(0,0,0,.12),0 6px 14px var(--color-shadow-sticky,rgba(0,0,0,.5));--wb-radius:var(--radius-normal,3px);--wb-font:var(--font-sans,system-ui,sans-serif);--wb-edge:var(--color-text-700,light-dark(#787d7c,#8a8a8a));position:absolute;inset:0;overflow:hidden;background:var(--wb-bg);color:var(--wb-text);font-family:var(--wb-font);font-size:14px;font-weight:300;user-select:none;outline:none;}',
'.wb-host .wb-canvas.wb-force-light{--wb-bg:#fcfcfd;--wb-surface:#f7f7f8;--wb-text:#525655;--wb-muted:#787d7c;--wb-faint:#969b9a;--wb-accent:#3f8484;--wb-line:rgba(82,86,85,.14);--wb-grid:rgba(82,86,85,.12);--wb-card:#ffffff;--wb-card-line:#e6e6ea;--wb-shadow:0 1px 3px rgba(0,0,0,.05);--wb-sticky-shadow:0 1px 0 rgba(0,0,0,.05),0 4px 12px rgba(0,0,0,.10);--wb-edge:#787d7c;color-scheme:light;}',
'.wb-host .wb-canvas.wb-force-dark{--wb-bg:#0a0a0b;--wb-surface:#212126;--wb-text:#c4c4c4;--wb-muted:#8a8a8a;--wb-faint:#6b6b6b;--wb-accent:#65c8bb;--wb-line:rgba(196,196,196,.14);--wb-grid:rgba(196,196,196,.13);--wb-card:#111113;--wb-card-line:#212126;--wb-shadow:0 4px 6px rgba(0,0,0,.2);--wb-sticky-shadow:0 1px 0 rgba(0,0,0,.12),0 6px 14px rgba(0,0,0,.5);--wb-edge:#8a8a8a;color-scheme:dark;}',
'.wb-host *{box-sizing:border-box;}',
'.wb-canvas{position:absolute;left:0;right:0;top:var(--wb-bar,35px);bottom:0;overflow:hidden;background:var(--wb-bg);cursor:default;touch-action:none;}',
'.wb-canvas.wb-bg-dots{background-image:radial-gradient(var(--wb-grid) 1px,transparent 1px);}',
'.wb-canvas.wb-bg-lines{background-image:linear-gradient(var(--wb-grid) 1px,transparent 1px),linear-gradient(90deg,var(--wb-grid) 1px,transparent 1px);}',
'.wb-canvas.wb-tool-sticky,.wb-canvas.wb-tool-text,.wb-canvas.wb-tool-shape,.wb-canvas.wb-tool-frame,.wb-canvas.wb-tool-stack{cursor:crosshair;}',
'.wb-frame{border:1px solid rgba(0,0,0,.12);border-radius:var(--radius-normal,3px);background:var(--wb-frame-fill,#F7F7F5);box-sizing:border-box;}',
'.wb-node.wb-frame > .wb-txt{position:absolute;left:0;bottom:100%;margin-bottom:6px;width:auto;max-width:100%;height:auto !important;padding:0;font-size:13px;font-weight:600;line-height:18px;color:var(--wb-text);background:transparent;white-space:nowrap;overflow:hidden;text-overflow:clip;display:block;text-align:left;cursor:text;opacity:.9;}',
'.wb-node.wb-frame.wb-editing > .wb-txt{opacity:1;outline:1px solid var(--wb-accent);outline-offset:2px;border-radius:var(--radius-normal,3px);}',
'.wb-node.wb-dim{opacity:.16;filter:saturate(.5);transition:opacity .15s;}g.wb-dim{opacity:.12;}',
'.wb-minimap{position:absolute;right:14px;bottom:50px;width:220px;height:150px;padding:0;background:var(--wb-surface);border:1px solid var(--wb-line);border-radius:var(--wb-radius);box-shadow:var(--wb-shadow);overflow:hidden;cursor:crosshair;touch-action:none;}.wb-minimap[hidden]{display:none;}.wb-minimap canvas{width:220px;height:150px;display:block;}',
'.wb-zoom.wb-savebar{right:auto;left:calc(28px + var(--wb-gutter,10px));width:auto;padding:0 10px;gap:7px;color:var(--wb-muted);cursor:default;}.wb-zoom.wb-savebar[hidden]{display:none;}.wb-savebar .wb-savedot{width:7px;height:7px;border-radius:50%;background:var(--wb-muted);}.wb-savebar.is-failed,.wb-savebar.is-conflict,.wb-savebar.is-refused{color:#c9873a;}.wb-savebar.is-failed .wb-savedot,.wb-savebar.is-conflict .wb-savedot,.wb-savebar.is-refused .wb-savedot{background:#c9873a;}.wb-savebar.is-conflict{cursor:default;}.wb-savebar .wb-savebtn{border:1px solid color-mix(in srgb,currentColor 45%,transparent);background:transparent;color:inherit;font:inherit;font-size:12px;padding:1px 7px;border-radius:var(--radius-normal,3px);cursor:pointer;}.wb-savebar .wb-savebtn:hover{background:color-mix(in srgb,currentColor 16%,transparent);}',
'.wb-focusbar{right:205px;left:auto;}.wb-focusbar .wb-tb span{margin-left:5px;font-size:12px;}.wb-focusbar .wb-tb.is-on{background:color-mix(in srgb,var(--wb-accent) 16%,transparent);color:var(--wb-accent);}.wb-focusbar .wb-focusdepth{display:inline-flex;align-items:center;padding:4px 2px 4px 6px;margin:-4px -4px -4px 0;opacity:.7;border-left:1px solid var(--wb-line);}.wb-focusbar .wb-focusdepth:hover{opacity:1;}.wb-focusbar .wb-focusdepth svg{width:11px;height:11px;}',
'.wb-boardcard{--wb-folder:#71BEF2;--wb-folder-fg:#0f2a3f;--wb-bc-fs:15px;--wb-bc-r:calc(var(--wb-bc-fs) * .8);background:transparent;color:var(--wb-folder-fg);box-sizing:border-box;cursor:default;overflow:visible;font-size:var(--wb-bc-fs);filter:drop-shadow(0 1px 2px rgba(0,0,0,.10)) drop-shadow(0 6px 12px rgba(0,0,0,.14));}',
'.wb-boardcard .wb-bc-svg{position:absolute;inset:0;width:100%;height:100%;display:block;overflow:visible;}.wb-boardcard .wb-bc-back{fill:color-mix(in srgb,var(--wb-folder) 70%,#0b2a4a 30%);}.wb-boardcard .wb-bc-front{fill:var(--wb-folder);}',
'.wb-boardcard .wb-bc-body{position:absolute;left:0;right:0;top:15.1%;bottom:0;display:flex;flex-direction:column;justify-content:flex-end;gap:.25em;padding:1em 1.1em .9em;box-sizing:border-box;}',
'.wb-boardcard .wb-bc-head{display:flex;align-items:center;gap:.5em;min-width:0;}.wb-boardcard .wb-bc-icon{display:flex;opacity:.8;font-size:1.25em;line-height:1;margin-left:-.1em;}.wb-boardcard .wb-bc-icon svg{width:1.2em;height:1.2em;}.wb-boardcard .wb-bc-title{font-weight:600;font-size:1em;line-height:1.3;overflow-wrap:anywhere;}.wb-boardcard .wb-bc-sub{font-size:.72em;opacity:.7;}.wb-boardcard .wb-bc-chips{display:none;}',
'.wb-ghost{position:absolute;opacity:.45;background:color-mix(in srgb,var(--wb-accent) 12%,transparent);border:1px dashed var(--wb-accent);box-sizing:border-box;pointer-events:none;}',
'.wb-stack{background:transparent;color:var(--wb-text);cursor:grab;}.wb-stack .wb-stack-title{position:absolute;left:0;right:0;top:0;height:var(--wb-stack-th,22%);display:flex;align-items:center;justify-content:center;font-size:calc(var(--wb-stack-fs,13px));font-weight:600;color:var(--wb-text);background:var(--wb-surface);border:1px solid var(--wb-line);border-radius:var(--radius-normal,3px) var(--radius-normal,3px) 0 0;cursor:move;box-sizing:border-box;}.wb-stack .wb-stack-pile{position:absolute;left:0;right:0;top:var(--wb-stack-th,22%);bottom:0;background:var(--wb-surface);border:1px solid var(--wb-line);border-top:0;border-radius:0 0 var(--radius-normal,3px) var(--radius-normal,3px);box-sizing:border-box;overflow:visible;}.wb-stack .wb-pad{position:absolute;left:var(--wb-stack-pad,14%);right:var(--wb-stack-pad,14%);top:var(--wb-stack-pad,12%);bottom:var(--wb-stack-pad,12%);perspective:700px;}.wb-stack .wb-pad-edge{position:absolute;left:0;right:0;bottom:0;height:9%;background:var(--wb-stack-color,#F2DF73);filter:brightness(.8);background-image:repeating-linear-gradient(180deg,rgba(0,0,0,.14) 0 1px,rgba(255,255,255,.08) 1px 2px,transparent 2px 4px);box-shadow:0 2px 4px rgba(0,0,0,.18);}.wb-stack .wb-pad-under{position:absolute;left:0;right:0;top:0;bottom:8%;background:var(--wb-stack-color,#F2DF73);filter:brightness(.86);box-shadow:inset 0 8px 12px rgba(0,0,0,.12);}.wb-stack .wb-pad-top{position:absolute;left:0;right:0;top:0;bottom:8%;background:var(--wb-stack-color,#F2DF73);background-image:linear-gradient(135deg,rgba(255,255,255,.38),rgba(255,255,255,0) 50%,rgba(0,0,0,.05));box-shadow:0 1px 2px rgba(0,0,0,.08);}',
'.wb-locked-badge{position:absolute;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:var(--wb-surface);border:1px solid var(--wb-line);display:flex;align-items:center;justify-content:center;color:var(--wb-muted);pointer-events:none;}.wb-locked-badge svg{width:11px;height:11px;}',
'.wb-canvas.wb-tool-connect{cursor:cell;}',
'.wb-canvas.wb-tool-card{cursor:copy;}.wb-canvas.wb-tool-note{cursor:copy;}.wb-canvas.wb-tool-mind{cursor:copy;}',
'.wb-canvas.wb-panning{cursor:grabbing;}',
'.wb-canvas.wb-space{cursor:grab;}',
'.wb-world{position:absolute;left:0;top:0;width:0;height:0;transform-origin:0 0;}',
'.wb-edges{position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;pointer-events:none;}',
'.wb-edges path.wb-hit{stroke:transparent;stroke-width:14px;fill:none;pointer-events:stroke;cursor:pointer;}',
'.wb-edges path.wb-line{fill:none;pointer-events:none;}',
'.wb-edges path.wb-head{pointer-events:none;}',
'.wb-edges g.wb-sel path.wb-line{filter:drop-shadow(0 0 1px var(--wb-accent));}',
'.wb-nodes,.wb-frames{position:absolute;left:0;top:0;}',
'.wb-node{position:absolute;left:0;top:0;transform-origin:0 0;}',
'.wb-txt s,.wb-txt strike{text-decoration:line-through;opacity:.75;}.wb-txt mark{border-radius:calc(var(--radius-normal,3px) / var(--wb-z,1));padding:0 .1em;color:inherit;}.wb-txt.wb-strike{text-decoration:line-through;}',
'.wb-node .wb-txt{width:100%;height:100%;outline:none;white-space:pre-wrap;overflow-wrap:break-word;word-break:break-word;overflow:hidden;cursor:default;}',
'.wb-node.wb-editing .wb-txt{cursor:text;user-select:text;-webkit-user-select:text;}',
'.wb-sticky{color:#1c1c1e;font-weight:400;box-shadow:1px 1px 2px rgba(0,0,0,.08),var(--wb-sh-x,5px) var(--wb-sh-y,6px) var(--wb-sh-b,14px) rgba(0,0,0,var(--wb-sh-a,.12));border-radius:0;padding:14px;display:flex;flex-direction:column;align-items:stretch;justify-content:flex-start;text-align:center;background-image:linear-gradient(180deg,rgba(255,255,255,.22),rgba(255,255,255,0) 28%,rgba(0,0,0,.035));}',
'.wb-sticky::before,.wb-sticky::after{content:"";position:absolute;z-index:-1;bottom:14px;width:42%;height:24%;}.wb-sticky::before{left:10px;transform:rotate(calc(-1 * var(--wb-curl,2deg)));box-shadow:2px 14px 20px rgba(0,0,0,calc(var(--wb-curl-a,.16) * .6));}.wb-sticky::after{right:6px;transform:rotate(var(--wb-curl,2deg));box-shadow:var(--wb-sh-x,5px) 18px 22px rgba(0,0,0,var(--wb-curl-a,.16));}',
'.wb-sticky .wb-txt{display:block;margin:auto 0;line-height:1.3;height:auto;max-height:100%;overflow:hidden;}',
'.wb-sticky.wb-al-left{text-align:left;}.wb-sticky.wb-al-right{text-align:right;}',
'.wb-sticky.wb-al-left .wb-txt{justify-content:flex-start;}.wb-sticky.wb-al-right .wb-txt{justify-content:flex-end;}',
'.wb-text{color:var(--wb-text);padding:4px 6px;line-height:1.45;}',
'.wb-text .wb-txt{height:auto;overflow:visible;}',
'.wb-text.wb-empty .wb-txt:empty:before{content:"Text";color:var(--wb-faint);}',
'.wb-shape{display:flex;align-items:center;justify-content:center;text-align:center;color:var(--wb-text);padding:10px;}',
'.wb-shape svg.wb-shape-bg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;}',
'.wb-shape .wb-shape-hit{fill:none;stroke:transparent;stroke-width:14;pointer-events:none;}',
'.wb-node.wb-shape.wb-hollow{pointer-events:none;}.wb-shape.wb-hollow .wb-shape-hit{pointer-events:stroke;}.wb-shape.wb-hollow .wb-txt:not(:empty){pointer-events:auto;}',
'.wb-shape .wb-txt{position:relative;height:auto;max-height:100%;line-height:1.3;display:flex;align-items:center;justify-content:center;}',
'.wb-image{border-radius:0;overflow:hidden;box-shadow:var(--wb-shadow);background:color-mix(in srgb,var(--wb-text) 6%,transparent);display:flex;align-items:center;justify-content:center;color:var(--wb-faint);}',
'.wb-image img{width:100%;height:100%;object-fit:fill;display:block;pointer-events:none;}',
'.wb-image svg{width:36px;height:36px;opacity:.5;}',
'.wb-b{font-weight:600;}.wb-i{font-style:italic;}.wb-u{text-decoration:underline;text-underline-offset:2px;}',
'.wb-text.wb-hasbg{padding:4px 8px;border-radius:var(--wb-radius);}',
'.wb-elabel{position:absolute;transform:translate(-50%,-50%);height:18px;padding:0 6px;display:flex;align-items:center;background:var(--wb-surface);border:1px solid var(--wb-line);border-radius:var(--wb-radius);font-size:11px;color:var(--wb-muted);white-space:nowrap;cursor:text;outline:none;}',
'.wb-elabel:empty{display:none;}',
'.wb-elabel[contenteditable=true]{display:flex;min-width:24px;user-select:text;-webkit-user-select:text;}',
'.wb-overlay{position:absolute;inset:0;pointer-events:none;}',
'.wb-selbox{position:absolute;border:1px solid var(--wb-accent);pointer-events:none;}',
'.wb-selbox.wb-hover{opacity:.5;}',
'.wb-handle{position:absolute;width:9px;height:9px;margin:-5px 0 0 -5px;background:var(--wb-bg);border:1px solid var(--wb-accent);border-radius:var(--radius-normal,3px);pointer-events:auto;}',
'.wb-handle.nw,.wb-handle.se{cursor:nwse-resize;}.wb-handle.ne,.wb-handle.sw{cursor:nesw-resize;}',
'.wb-handle.e,.wb-handle.w{cursor:ew-resize;}',
'.wb-dot{position:absolute;width:10px;height:10px;margin:-5px 0 0 -5px;border-radius:50%;background:var(--wb-accent);border:1px solid var(--wb-bg);pointer-events:auto;cursor:crosshair;}',
'.wb-epoint{position:absolute;width:11px;height:11px;margin:-5.5px 0 0 -5.5px;border-radius:50%;background:var(--wb-bg);border:2px solid var(--wb-accent);pointer-events:auto;cursor:grab;}',
'.wb-epoint:active{cursor:grabbing;}.wb-eadd{position:absolute;width:9px;height:9px;margin:-4.5px 0 0 -4.5px;border-radius:50%;background:var(--wb-accent);opacity:.35;pointer-events:auto;cursor:copy;}.wb-eadd:hover{opacity:.9;}',
'.wb-dot:hover{transform:scale(1.3);}',
'.wb-marquee{position:absolute;border:1px solid var(--wb-accent);background:color-mix(in srgb,var(--wb-accent) 10%,transparent);pointer-events:none;}',
'.wb-guide{position:absolute;background:var(--wb-accent);opacity:.7;pointer-events:none;}',
'.wb-tagpop{position:fixed;z-index:100003;width:300px;padding:10px;background:var(--cmdpal-bg-color,var(--wb-surface));color:var(--text-color);border:1px solid var(--wb-line);border-radius:var(--radius-normal,3px);box-shadow:var(--wb-shadow);font-size:12px;}.wb-tagpop-row{display:flex;align-items:center;gap:8px;}.wb-tagpop-actions{justify-content:flex-end;gap:14px;margin-top:8px;}.wb-tagdot{width:14px;height:14px;border-radius:50%;flex:0 0 auto;cursor:pointer;border:1px solid rgba(0,0,0,.15);}.wb-taginput{flex:1;min-width:0;background:transparent;border:none;border-bottom:1px solid var(--wb-line);outline:none;color:inherit;font:inherit;font-size:12px;padding:6px 2px;}.wb-taginput:focus{border-bottom-color:var(--wb-accent);}.wb-taglink{cursor:pointer;color:var(--wb-muted);font-size:12px;}.wb-taglink:hover{color:var(--text-color);}.wb-taglink-primary{color:var(--wb-accent);}.wb-taglink-danger{color:var(--color-rose-500,#e0567b);}.wb-tagpalette{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:6px;padding:10px 0 2px 22px;}.wb-tagpills{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;}.wb-tagpill{display:inline-flex;align-items:center;gap:4px;padding:2px 4px 2px 6px;border-radius:3px;border:1px solid var(--wb-line);font-size:10.5px;font-weight:600;line-height:14px;color:var(--text-color);cursor:pointer;max-width:100%;}.wb-tagpill.is-on{border-color:transparent;color:#1c1c1e;}.wb-tagpill .wb-tagpen{display:inline-flex;opacity:.55;padding:1px;border-radius:var(--radius-normal,3px);}.wb-tagpill .wb-tagpen:hover{opacity:1;background:rgba(0,0,0,.08);}.wb-tagpill .wb-tagpen svg{width:10px;height:10px;}',
'.wb-crumb{display:inline-flex;align-items:center;gap:6px;margin-right:6px;color:var(--color-text-600,#a1a1a1);cursor:pointer;font-weight:400;}.wb-crumb:hover .wb-crumb-name{color:var(--text-color);}.wb-crumb .wb-crumb-sep{opacity:.6;}',
'.wb-topbar{position:absolute;right:14px;top:calc(var(--wb-bar,35px) + 12px);height:34px;padding:4px;display:flex;align-items:center;gap:2px;background:var(--wb-surface);border:1px solid var(--wb-line);border-radius:var(--wb-radius);box-shadow:var(--wb-shadow);z-index:6;}',
'.wb-topbar .wb-tbtoggle{width:26px;height:26px;display:flex;align-items:center;justify-content:center;border-radius:var(--wb-radius);color:var(--wb-muted);cursor:pointer;flex:0 0 auto;}.wb-topbar .wb-tbtoggle:hover{color:var(--wb-text);background:color-mix(in srgb,var(--wb-text) 8%,transparent);}.wb-topbar .wb-tbtoggle svg{width:16px;height:16px;display:block;}',
'.wb-topbar.is-collapsed .wb-tbgrp,.wb-topbar.is-collapsed .wb-nbsep{display:none;}.wb-topbar:not(.is-collapsed) .wb-tbtoggle{margin-left:4px;}',
'.wb-topbar .wb-tbgrp{display:flex;align-items:center;gap:2px;}.wb-topbar .wb-tbgrp:empty{display:none;}.wb-topbar .wb-nbsep{margin:0 4px;}',
'.wb-topbar .wb-nb{height:26px;margin:0;padding:0 8px;color:var(--wb-muted);}.wb-topbar .wb-nb:hover{color:var(--wb-text);background:color-mix(in srgb,var(--wb-text) 10%,transparent);}',
'.wb-rail{position:absolute;left:14px;top:calc(var(--wb-bar,35px) + 12px);width:40px;padding:4px;display:flex;flex-direction:column;gap:2px;background:var(--wb-surface);border:1px solid var(--wb-line);border-radius:var(--wb-radius);box-shadow:var(--wb-shadow);z-index:6;}',
'.wb-tool{width:32px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:var(--wb-radius);color:var(--wb-muted);cursor:pointer;position:relative;}',
'.wb-tool:hover{color:var(--wb-text);background:color-mix(in srgb,var(--wb-text) 8%,transparent);}',
'.wb-tool.is-active{background:color-mix(in srgb,var(--wb-accent) 16%,transparent);color:var(--wb-accent);}',
'.wb-tool svg{width:16px;height:16px;}',
'.wb-tip{position:absolute;left:44px;top:50%;transform:translateY(-50%);height:22px;padding:0 7px;display:none;align-items:center;gap:6px;white-space:nowrap;background:var(--wb-surface);border:1px solid var(--wb-line);border-radius:var(--wb-radius);font-size:11px;color:var(--wb-text);box-shadow:var(--wb-shadow);pointer-events:none;}',
'.wb-tool:hover .wb-tip{display:flex;}.wb-flyhead{grid-column:1 / -1;display:flex;align-items:center;justify-content:space-between;gap:8px;height:20px;padding:0 3px 3px;margin-bottom:2px;border-bottom:1px solid var(--wb-line);font-size:11px;color:var(--wb-text);white-space:nowrap;}',
'.wb-key{min-width:16px;height:16px;padding:0 4px;display:inline-flex;align-items:center;justify-content:center;border-radius:var(--radius-normal,3px);background:color-mix(in srgb,var(--wb-text) 10%,transparent);font-size:10px;color:var(--wb-muted);}',
'.wb-fly{position:absolute;left:36px;top:-5px;width:160px;padding:5px;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:2px;background:var(--wb-surface);border:1px solid var(--wb-line);border-radius:var(--wb-radius);box-shadow:var(--wb-shadow);z-index:7;visibility:hidden;opacity:0;transition:visibility 0s .35s,opacity .12s .35s;}',
'.wb-tool:hover .wb-fly,.wb-fly:hover{visibility:visible;opacity:1;transition-delay:0s;}',
'.wb-fly .wb-fi{width:34px;height:34px;display:flex;align-items:center;justify-content:center;border-radius:var(--wb-radius);color:var(--wb-text);cursor:pointer;}',
'.wb-fly .wb-fi:hover{background:color-mix(in srgb,var(--wb-text) 8%,transparent);}',
'.wb-fly .wb-fi.is-on{background:color-mix(in srgb,var(--wb-accent) 16%,transparent);color:var(--wb-accent);}',
'.wb-fly .wb-fi svg{width:18px;height:18px;}',
'.wb-pop .wb-fi{width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:var(--wb-radius);color:var(--wb-text);cursor:pointer;}',
'.wb-pop .wb-fi:hover{background:color-mix(in srgb,var(--wb-text) 8%,transparent);}',
'.wb-pop .wb-fi.is-on{background:color-mix(in srgb,var(--wb-accent) 16%,transparent);color:var(--wb-accent);}',
'.wb-pop .wb-fi svg{width:20px;height:20px;}',
'.wb-fly.wb-fly-colors{gap:6px;width:130px;}.wb-fly .wb-flybtn{grid-column:1 / -1;display:flex;align-items:center;justify-content:center;gap:6px;height:26px;margin-top:2px;border-top:1px solid var(--wb-line);padding-top:6px;font-size:12px;color:var(--wb-text);cursor:pointer;}.wb-fly .wb-flybtn svg{width:14px;height:14px;}.wb-fly .wb-flybtn:hover{color:var(--wb-accent);}',
'.wb-fly.wb-fly-frames{width:200px;grid-template-columns:repeat(3,minmax(0,1fr));gap:2px;padding:6px;}.wb-fly .wb-ff{display:flex;flex-direction:column;align-items:center;gap:3px;padding:7px 2px 6px;border-radius:var(--wb-radius);color:var(--wb-text);cursor:pointer;font-size:11px;line-height:12px;}.wb-fly .wb-ff svg{width:24px;height:24px;}.wb-fly .wb-ff:hover{background:color-mix(in srgb,var(--wb-text) 8%,transparent);}.wb-fly .wb-ff.is-on{background:color-mix(in srgb,var(--wb-accent) 16%,transparent);color:var(--wb-accent);}.wb-fly .wb-ffsep{grid-column:1 / -1;height:1px;margin:3px 4px;background:var(--wb-line);}',
'.wb-sw{width:22px;height:22px;border-radius:var(--radius-normal,3px);box-shadow:inset 0 0 0 1px rgba(0,0,0,.15);cursor:pointer;}',
'.wb-sw.is-on{outline:1px solid var(--wb-accent);outline-offset:1px;}',
'.wb-focusdepth{display:flex;align-items:center;gap:3px;margin-left:6px;padding-left:7px;border-left:1px solid color-mix(in srgb,currentColor 28%,transparent);opacity:.85;}',
'.wb-focusdepth:hover{opacity:1;}.wb-focusn{font-variant-numeric:tabular-nums;}',
'.wb-zoom{position:absolute;right:14px;bottom:12px;height:30px;padding:0 4px;display:flex;align-items:center;gap:2px;background:var(--wb-surface);border:1px solid var(--wb-line);border-radius:var(--wb-radius);box-shadow:var(--wb-shadow);font-size:12px;color:var(--wb-text);z-index:6;}',
'.wb-tb{height:26px;min-width:26px;padding:0 5px;display:flex;align-items:center;justify-content:center;gap:4px;border-radius:var(--wb-radius);color:var(--wb-text);font-size:12px;white-space:nowrap;cursor:pointer;}',
'.wb-rail svg,.wb-zoom svg,.wb-ctx svg,.wb-nb svg{width:16px;height:16px;display:block;}',
'.wb-tb svg{width:16px;height:16px;}',
'.wb-tb.wb-big svg:first-child{width:19px;height:19px;}',
'.wb-nb svg{width:14px;height:14px;}',
'.wb-tb:hover{background:color-mix(in srgb,var(--wb-text) 8%,transparent);}',
'.wb-tb.is-on{background:color-mix(in srgb,var(--wb-accent) 16%,transparent);color:var(--wb-accent);}',
'.wb-tb .wb-chev{width:11px;height:11px;color:var(--wb-muted);}',
'.wb-tb .wb-cdot{width:13px;height:13px;border-radius:50%;display:block;box-shadow:inset 0 0 0 1px rgba(0,0,0,.15);}',
'.wb-tsep{width:1px;height:16px;background:var(--wb-line);margin:0 3px;}',
'.wb-size{height:26px;display:flex;align-items:center;gap:1px;border-radius:var(--wb-radius);}',
'.wb-size input{width:36px;height:22px;padding:0 4px;border:1px solid var(--wb-line);border-radius:var(--wb-radius);background:transparent;color:var(--wb-text);font:inherit;font-size:12px;text-align:center;outline:none;}',
'.wb-size input:focus{border-color:var(--wb-accent);}',
'.wb-size .wb-step{display:flex;flex-direction:column;gap:0;}',
'.wb-size .wb-step div{width:14px;height:11px;display:flex;align-items:center;justify-content:center;color:var(--wb-muted);cursor:pointer;border-radius:var(--radius-normal,3px);}',
'.wb-size .wb-step div:hover{color:var(--wb-text);background:color-mix(in srgb,var(--wb-text) 8%,transparent);}',
'.wb-size .wb-step svg{width:9px;height:9px;}',
'.wb-pop .wb-sw.wb-sw-auto{background:transparent;box-shadow:inset 0 0 0 1px var(--wb-line);position:relative;}',
'.wb-pop .wb-sw.wb-sw-auto:before{content:"";position:absolute;left:3px;right:3px;top:50%;height:1px;background:var(--wb-muted);transform:rotate(-45deg);}',
'.wb-pop .wb-custom{grid-column:1 / -1;display:flex;gap:4px;margin-top:2px;align-items:center;}.wb-pop.wb-pop-wheel{width:176px;grid-template-columns:repeat(6,minmax(0,1fr));}.wb-pop .wb-wheel{grid-column:1 / -1;position:relative;width:140px;height:140px;margin:6px auto 2px;}.wb-pop .wb-wheelcv{width:140px;height:140px;display:block;border-radius:50%;cursor:crosshair;touch-action:none;}.wb-pop .wb-wheelmark{position:absolute;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.35);pointer-events:none;}.wb-pop .wb-wheellight{grid-column:1 / -1;width:100%;height:12px;margin:2px 0;-webkit-appearance:none;appearance:none;border-radius:6px;outline:none;border:1px solid var(--wb-line);}.wb-pop .wb-wheellight::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:#fff;border:1px solid rgba(0,0,0,.35);}.wb-pop .wb-wheelprev{flex:0 0 22px;}',
'.wb-pop .wb-custom input{flex:1;min-width:0;height:22px;padding:0 6px;border:1px solid var(--wb-line);border-radius:var(--wb-radius);background:transparent;color:var(--wb-text);font:inherit;font-size:12px;outline:none;}',
'.wb-pop .wb-custom input:focus{border-color:var(--wb-accent);}',
'.wb-pop .wb-eyedrop{flex:0 0 22px;height:22px;display:flex;align-items:center;justify-content:center;border:1px solid var(--wb-line);border-radius:var(--wb-radius);color:var(--wb-muted);cursor:pointer;}.wb-pop .wb-eyedrop:hover{color:var(--wb-text);border-color:var(--wb-muted);}.wb-pop .wb-eyedrop svg{width:13px;height:13px;}',
'.wb-ctx{position:absolute;min-height:34px;max-width:calc(100% - 72px);padding:3px 5px;display:flex;flex-wrap:wrap;align-items:center;gap:2px;background:var(--wb-surface);border:1px solid var(--wb-line);border-radius:var(--wb-radius);box-shadow:var(--wb-shadow);z-index:8;}',
'.wb-pop.wb-spawnpop{display:block;width:190px;padding:4px;}.wb-sprow{display:flex;align-items:center;gap:8px;height:30px;padding:0 6px;border-radius:var(--wb-radius);color:var(--wb-text);cursor:pointer;font-size:12px;white-space:nowrap;}.wb-sprow:hover{background:color-mix(in srgb,var(--wb-text) 8%,transparent);}.wb-sprow svg{width:18px;height:18px;flex:none;}.wb-sprow span:first-of-type{flex:1;}.wb-sprow .wb-key{opacity:.6;font-size:10px;}.wb-spgrid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:2px;border-top:1px solid var(--wb-line);margin-top:4px;padding-top:4px;}',
'.wb-pop{position:fixed;z-index:100003;width:122px;padding:6px;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;background:var(--wb-surface,var(--cmdpal-bg-color,#212126));border:1px solid var(--wb-line,rgba(196,196,196,.14));border-radius:var(--wb-radius,3px);box-shadow:var(--wb-shadow,0 4px 6px rgba(0,0,0,.2));}',
'.wb-host .qb-menu .wb-mi svg{width:14px;height:14px;}',
'.wb-nb{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;margin-right:2px;border-radius:var(--radius-normal,3px);border:none;background:transparent;color:var(--color-text-600,#a1a1a1);font-size:var(--text-size-smaller,.8125rem);cursor:pointer;line-height:1;align-self:center;white-space:nowrap;}',
'.wb-nb:hover{color:var(--text-color);background:color-mix(in srgb,var(--text-color) 9%,transparent);}.wb-nb.is-muted{color:color-mix(in srgb,var(--color-text-600,#a1a1a1) 65%,transparent);}.wb-nb .ti{font-size:14px;line-height:1;}.wb-nbsep{width:1px;height:16px;margin:0 6px 0 4px;align-self:center;background:color-mix(in srgb,var(--text-color) 16%,transparent);}',
'.wb-nb svg{width:14px;height:14px;display:block;}',
'.wb-nb .wb-chev{width:10px;height:10px;opacity:.55;margin-left:-2px;}',
'.wb-rename{position:fixed;z-index:100003;padding:8px;display:flex;gap:6px;background:var(--wb-surface,var(--cmdpal-bg-color,#212126));border:1px solid var(--wb-line,rgba(196,196,196,.14));border-radius:var(--radius-normal,3px);box-shadow:var(--color-shadow-cards,0 4px 6px rgba(0,0,0,.2));}',
'.wb-rename input{width:220px;height:26px;padding:0 8px;border:1px solid var(--wb-line,rgba(196,196,196,.14));border-radius:var(--radius-normal,3px);background:transparent;color:var(--text-color);font:inherit;font-size:13px;outline:none;}',
'.wb-rename input:focus{border-color:var(--color-primary-500,#65c8bb);}',
].join('\n');

// <<<SHARED option-menu — GENERATED, DO NOT EDIT HERE.
// Source: shared/option-menu.js  |  regenerate: node tools/sync-option-menu.mjs
const wbM = { el: null, key: null, outside: null, type: '', typeAt: 0, focusAfter: null, closeExtra: null };

const wbENUM_COLORS = ["red", "orange", "green", "cyan", "blue", "purple", "pink",
	"fuchsia", "rose", "stone", "teal", "sky", "indigo", "zinc", "yellow"];

function wbEnumVar(idx) {
	const n = wbENUM_COLORS[parseInt(idx, 10)] || "zinc";
	return "var(--enum-" + n + "-fg)";
}

function wbMenu(anchor, items, current, onPick, cfg) {
	wbCloseMenu();
	cfg = cfg || {};
	if (cfg.sheet == null && typeof wbM.sheetDefault === "function" && wbM.sheetDefault()) cfg.sheet = true;
	anchor.classList.add("qb-open");
	// Picking with the MOUSE leaves focus on <body>, so the rebuild that follows
	// has nothing to restore and Tab starts over from the top of the panel.
	// Remember the control the menu belongs to and hand focus back to it, so Tab
	// carries on to the next column from where you just were.
	wbM.focusAfter = (cfg.controlRef ? cfg.controlRef(anchor) : null);
	// Thymer's own picker markup, class for class — the app styles it for us.
	const menu = document.createElement("div");
	menu.className = "cmdpal--inline active qb-menu" + (cfg.dark ? " qb-menu-dark" : "") + (cfg.checks === false ? " qb-menu-nocheck" : "");
	menu.style.position = "fixed";
	menu.addEventListener("mousedown", (e) => e.stopPropagation());
	wbM.el = menu;

	// Rows marked `head` live above the search field, in their own list, and never take part in filtering.
	const headItems = items.filter((it) => it.head);
	let headList = null;
	if (headItems.length) {
		const hs = document.createElement("div");
		hs.className = "autocomplete clickable qb-menu-head";
		headList = document.createElement("div");
		headList.className = "vcontent";
		hs.appendChild(headList);
		menu.appendChild(hs);
	}
	let search = null;
	if (cfg.search) {
		const ic = document.createElement("div");
		ic.className = "cmdpal--inline-input-container";
		const row = document.createElement("div");
		row.className = "cmdpal--inline-input-row";
		search = document.createElement("input");
		search.className = "cmdpal--inline-input";
		search.type = "text";
		search.spellcheck = false;
		search.placeholder = cfg.searchPlaceholder || "Search option ...";
		search.addEventListener("keydown", (e) => {
			// arrows + Enter belong to the list; the rest is typing
			if (["ArrowDown", "ArrowUp", "Enter", "Escape"].indexOf(e.key) < 0) e.stopPropagation();
		});
		search.addEventListener("input", () => paint());
		row.appendChild(search);
		ic.appendChild(row);
		menu.appendChild(ic);
	}
	const scroller = document.createElement("div");
	scroller.className = "autocomplete clickable";
	scroller.style.position = "relative";
	scroller.style.overflow = "hidden";
	const vnode = document.createElement("div");
	vnode.className = "vscroll-node";
	vnode.style.height = "100%";
	const list = document.createElement("div");
	list.className = "vcontent";
	vnode.appendChild(list);
	scroller.appendChild(vnode);
	menu.appendChild(scroller);

	let cells = [], active = -1;
	// Native marks the row under the cursor with `autocomplete--option-selected`
	// — the green fill and light text. Walking the list moves that mark, so the
	// row you are on always reads in the contrast colour, never grey.
	const highlight = (i, scroll) => {
		if (!cells.length) return;
		active = (i + cells.length) % cells.length;
		cells.forEach((c, k) => c.classList.toggle("autocomplete--option-selected", k === active));
		if (scroll !== false && cells[active].scrollIntoView) cells[active].scrollIntoView({ block: "nearest" });
	};
	const makeRow = (it, into) => {
		const row = document.createElement("div");
		row.className = "autocomplete--option";
		row.setAttribute("data-v", it.v == null ? "" : String(it.v));
		if (cfg.dots !== false || it.icon || it.glyph || it.svg) {
			const ic = document.createElement("span");
			ic.className = "autocomplete--option-icon";
			if (it.svg) {
				ic.innerHTML = it.svg;
			} else if (it.glyph) {
				ic.textContent = it.glyph;
			} else if (it.icon) {
				const g = document.createElement("span");
				g.className = "ti " + it.icon;
				ic.appendChild(g);
			} else {
				// No glyph on this option — a dot in its enum colour, like native.
				const d = document.createElement("span");
				d.className = "qb-mi-dot";
				d.style.color = wbEnumVar(it.color);
				ic.appendChild(d);
			}
			row.appendChild(ic);
		}
		const lb = document.createElement("span");
		lb.className = "autocomplete--option-label";
		lb.textContent = it.label;
		row.appendChild(lb);
		// Multi-select hosts mark chosen rows with a trailing check AND a class
		// they can tint. The row's own icon stays put — a picker row always
		// shows its real icon.
		if (cfg.isChecked && cfg.isChecked(it.v)) {
			row.classList.add("qb-checked");
			// `checks: false` hosts show the chosen rows by background only (an active-button look), no glyph.
			if (cfg.checks !== false) {
				const ck = document.createElement("span");
				ck.className = "qb-mi-check";
				ck.textContent = "\u2713";
				row.appendChild(ck);
			}
		}
		row.addEventListener("mouseenter", () => highlight(cells.indexOf(row), false));
		row.addEventListener("click", (e) => {
			e.stopPropagation();
			if (cfg.keepOpen) { onPick(it.v); paint(); return; }   // multi-select: stay open
			wbCloseMenu();
			onPick(it.v);
		});
		into.appendChild(row);
		cells.push(row);
		return row;
	};
	const paint = () => {
		const q = (search && search.value || "").trim();
		// "+" is an AND across parts, and ranking is prefix-first — the same
		// contract as the Move To / Quick Capture picker.
		const parts = q ? q.toLowerCase().split("+").map((s) => s.trim()).filter(Boolean) : [];
		const scored = [];
		for (const it of items) {
			if (it.head) continue;                    // drawn above the search field, never filtered
			if (it.hidden && !parts.length) continue; // a wider set the search can reach, hidden until something is typed
			if (it.idle && parts.length) continue;    // the mirror: a short default list the search replaces
			if (it.title) { scored.push({ it, s: 0 }); continue; }
			// Match against the label plus any alternate text (a keyword's @form).
			const lab = ((it.label || "") + (it.alt ? " " + it.alt : "")).toLowerCase();
			if (it.sep) { if (!parts.length) scored.push({ it, s: 0 }); continue; }
			if (!parts.length) { scored.push({ it, s: 0 }); continue; }
			let total = 0, ok = true;
			for (const p of parts) {
				let s = 0;
				if (lab === p) s = 100;
				else if (lab.indexOf(p) === 0) s = 45;
				else if (new RegExp("\\b" + p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(lab)) s = 25;
				else if (lab.indexOf(p) >= 0) s = 8;
				if (!s) { ok = false; break; }
				total += s;
			}
			if (ok) scored.push({ it, s: total });
		}
		if (parts.length) scored.sort((a, b) => b.s - a.s || a.it.label.length - b.it.label.length || a.it.label.localeCompare(b.it.label));
		list.innerHTML = "";
		cells = [];
		if (headList) {
			headList.innerHTML = "";
			headItems.forEach((it) => {
				if (it.sep) { const d = document.createElement("div"); d.className = "qb-menu-sep"; headList.appendChild(d); return; }
				if (it.title) { const t = document.createElement("div"); t.className = "qb-menu-title" + (it.caps ? " qb-caps" : ""); t.textContent = it.title; headList.appendChild(t); return; }
				makeRow(it, headList);
			});
		}
		if (!scored.length) {
			const e = document.createElement("div");
			e.className = "qb-menu-empty";
			e.textContent = "No matches";
			list.appendChild(e);
			return;
		}
		scored.slice(0, cfg.maxRows || 200).forEach(({ it }) => {
			if (it.sep) { const d = document.createElement("div"); d.className = "qb-menu-sep"; list.appendChild(d); return; }
			if (it.title) { const t = document.createElement("div"); t.className = "qb-menu-title" + (it.caps ? " qb-caps" : ""); t.textContent = it.title; list.appendChild(t); return; }
			makeRow(it, list);
		});
		// Start on whatever is already chosen, else the first row. cfg.startTop: begin at the top (long, searchable
		// lists where the current item may sit far down; Down then walks from the first row, not from the current one).
		const at = cfg.startTop ? -1 : cells.findIndex((c) => c.getAttribute("data-v") === String(current == null ? "" : current));
		highlight(at >= 0 ? at : 0, false);
	};
	paint();
	wbM.repaint = paint;

	// Up/Down walk the list, Enter takes the highlighted row — the menu is
	// keyboard-drivable whether or not it has a search box.
	const onKey = (e) => {
		if (!wbM.el) return;
		if (e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); highlight(active + 1); }
		else if (e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); highlight(active - 1); }
		else if (e.key === "Enter") {
			if (active < 0 || !cells[active]) return;
			e.preventDefault(); e.stopPropagation();
			cells[active].dispatchEvent(new MouseEvent("click", { bubbles: true }));
		} else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); wbCloseMenu(); }
		else if (!search && e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
			// TYPE-AHEAD for the menus that have no search box — the joiner
			// (AND/OR/NOT), Show/NOT, the operators. They are three or four
			// items wide, so a search row would dwarf them, but a keyboard
			// user still has to be able to say which one ("man ska kunna
			// skriva AND/OR/NOT", his ask 2026-08-15). Same behaviour as a
			// native select: the letters pick the first label that starts
			// with what you typed, Enter takes it.
			const now = Date.now();
			if (now - (wbM.typeAt || 0) > 800) wbM.type = "";
			wbM.typeAt = now;
			wbM.type = (wbM.type || "") + e.key.toLowerCase();
			const hit = cells.findIndex((c) =>
				(c.textContent || "").trim().toLowerCase().indexOf(wbM.type) === 0);
			// One repeated letter walks the matches, the way a select does.
			if (hit < 0 && wbM.type.length > 1
				&& wbM.type.split("").every((ch) => ch === wbM.type[0])) {
				wbM.type = e.key.toLowerCase();
				const from = active + 1;
				const n = cells.length;
				for (let k = 0; k < n; k++) {
					const idx = (from + k) % n;
					if ((cells[idx].textContent || "").trim().toLowerCase().indexOf(wbM.type) === 0) {
						e.preventDefault(); e.stopPropagation(); highlight(idx);
						return;
					}
				}
				return;
			}
			if (hit >= 0) { e.preventDefault(); e.stopPropagation(); highlight(hit); }
		}
	};
	wbM.key = onKey;
	wbM.type = ""; wbM.typeAt = 0;
	document.addEventListener("keydown", onKey, true);

	document.body.appendChild(menu);
	/* cfg.alignTo lets a host line the menu up with the FIELD rather than with
	 * the control that opened it. A "+" button at the end of a row is a tiny
	 * anchor, and hanging a 300px menu off its left edge puts the menu far out
	 * to the right of the thing it belongs to (his 2026-08-15 report). */
	const r = (cfg.alignTo || anchor).getBoundingClientRect();
	const M = cfg.edge != null ? cfg.edge : 8;
	// Native picker width, never narrower than the control it belongs to.
	menu.style.width = Math.max(r.width, cfg.width != null ? cfg.width : 320) + "px";
	menu.style.maxWidth = "calc(100vw - 20px)";
	// The list scrolls at the native 350px, or shrinks to fit a short one. Measured
	// from the rendered content, not counted: native rows are 26px and the estimate
	// here was 30, which left a visible strip of dead space under a short list.
	const seps = list.querySelectorAll(".qb-menu-sep").length;
	const wanted = Math.max(list.scrollHeight || 0, (list.children.length - seps) * 26 + seps * 9); // scrollHeight can lag a row or two behind the rendered list; the count is the floor, and a separator is 9px, not a row
	scroller.style.height = Math.min(cfg.maxHeight || 350, Math.max(30, wanted)) + "px"; // cfg.maxHeight lets a short fixed menu show every row without scrolling
	// the virtual list settles a frame later; grow to the real content once, so nothing is left to scroll for
	requestAnimationFrame(() => { const real = vnode.scrollHeight || 0; const cap = cfg.maxHeight || 350; if (real > wanted) scroller.style.height = Math.min(cap, real) + "px"; else if (real > 0 && real < cap && Math.abs(real - wanted) > 2) scroller.style.height = Math.max(30, real) + "px"; });
	const h = menu.offsetHeight;
	// Value menus align on their RIGHT edge with the control; the rest hang left.
	const left = cfg.alignRight ? (r.right - menu.offsetWidth) : r.left;
	menu.style.left = Math.max(M, Math.min(left, window.innerWidth - menu.offsetWidth - M)) + "px";
	let top = r.bottom + 4;
	if (top + h > window.innerHeight - M) top = Math.max(M, r.top - 4 - h);
	menu.style.top = top + "px";
	if (cfg.sheet) {
		// hand the placement to Thymer's phone sheet rule: full viewport width, pinned to the bottom above the keyboard
		menu.classList.add("cmdpal--sheet", "qb-menu-sheet");
		menu.style.left = "var(--mobile-viewport-left, 0px)"; menu.style.top = "auto"; menu.style.right = "auto";
		menu.style.width = "var(--mobile-viewport-width, 100vw)"; menu.style.maxWidth = "none";
		scroller.style.height = Math.min(Math.round(window.innerHeight * 0.6), Math.max(30, wanted)) + "px";
	}
	if (search) search.focus();

	wbM.outside = (e) => {
		if (menu.contains(e.target) || anchor.contains(e.target)) return;
		wbCloseMenu();
	};
	document.addEventListener("mousedown", wbM.outside, true);
}

function wbCloseMenu() {
	if (wbM.closeExtra) { try { wbM.closeExtra(); } catch (e) {} }
	if (wbM.key) { document.removeEventListener("keydown", wbM.key, true); wbM.key = null; }
	if (wbM.outside) { document.removeEventListener("mousedown", wbM.outside, true); wbM.outside = null; }
	if (wbM.el) { wbM.el.remove(); wbM.el = null; }
	wbM.repaint = null;
	document.querySelectorAll(".qb-sel.qb-open").forEach((b) => b.classList.remove("qb-open"));
}

// The menu's stylesheet, appended to the host's CSS string.
const wbMENU_CSS = `
.qb-sel.qb-open, .qb-val:focus { border-color: var(--ed-button-primary-bg, #4caea1); }
.qb-menu { z-index: 100002; padding-top: 5px; padding-bottom: 5px; border-radius: var(--radius-normal, 3px); }
.qb-menu .vscroll-node { overflow-y: auto; scrollbar-width: none; }
.qb-menu .vscroll-node::-webkit-scrollbar { width: 0; height: 0; }
.qb-menu .autocomplete--option { cursor: pointer; }
.qb-menu .autocomplete--option { gap: 11px; }
.qb-menu .cmdpal--inline-input { font-size: var(--text-size-smaller, .8125rem); }
.qb-menu-empty { padding: 6px 10px; opacity: .6; }
.qb-menu-title { padding: 5px 10px 3px; font-size: var(--text-size-smaller, .8125rem); color: var(--text-color-muted, rgba(196,196,196,.55)); text-transform: none; }
.qb-menu-title.qb-caps { text-transform: uppercase; letter-spacing: .06em; }
.qb-menu-sep { height: 1px; margin: 4px 8px; background: var(--border-color, rgba(196,196,196,.14)); }
/* head rows sit above the search field. The host draws its own divider with a head sep row, because it decides which of
   those rows the line belongs under. NO BACKTICKS: this block is a template literal. */
.qb-menu .qb-menu-head { padding-bottom: 2px; }
.qb-menu.qb-menu-sheet { border-radius: var(--radius-normal, 3px) var(--radius-normal, 3px) 0 0 !important; }
.qb-menu.qb-menu-sheet .autocomplete--option { min-height: 44px; }
.autocomplete--option-icon svg { width: 14px; height: 14px; display: block; }
.qb-menu .autocomplete--option-icon {
	flex: 0 0 16px; width: 16px; min-width: 16px; height: 16px;
	display: inline-flex; align-items: center; justify-content: center;
}
.qb-menu .autocomplete--option-icon > .ti { line-height: 1; }
.qb-mi-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.qb-menu .qb-mi-check { margin-left: auto; padding-left: 10px; opacity: .9; }
.qb-menu .autocomplete--option.qb-checked { border-radius: 4px; }
.qb-menu.qb-menu-nocheck .autocomplete--option.qb-checked { background: color-mix(in srgb, var(--color-primary-500, #65c8bb) 16%, transparent); color: var(--color-primary-500, #65c8bb); }
.qb-menu.qb-menu-dark .autocomplete--option { color: #AFAFB0; justify-content: center; font-weight: 600; letter-spacing: .04em; }
.qb-menu.qb-menu-dark .autocomplete--option:hover { background: #3B3B42; }
.qb-menu.qb-menu-dark .autocomplete--option-selected:hover { background: #313E44; color: var(--ed-button-primary-bg, #4caea1); }
.qb-menu.qb-menu-dark .autocomplete--option-selected[data-v="NOT"]:hover { color: var(--enum-red-fg, #e06c6c); }
`;
// >>>SHARED

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const wbUid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
const wbClamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wbSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wbSnap = (v, on) => (on ? Math.round(v / WB_GRID) * WB_GRID : Math.round(v));
function wbEl(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
function wbSvgEl(tag, attrs) { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; }
function wbEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
// a ring of the last 30 mount events, kept in localStorage so a phone can report what its mount did (Copy diagnostics)
function wbTrace(msg) { try { const L = wbTraceRead(); L.push(new Date().toISOString().slice(11, 19) + ' ' + msg); while (L.length > 30) L.shift(); localStorage.setItem('wb_trace', JSON.stringify(L)); } catch (e) {} }
function wbTraceRead() { try { return JSON.parse(localStorage.getItem('wb_trace') || '[]') || []; } catch (e) { return []; } }
async function wbRecordPoll(plugin, guid, tries) { for (let i = 0; i < (tries || 20); i++) { try { const r = await plugin.data.getRecord(guid); if (r) return r; } catch (e) {} await wbSleep(80); } return null; }
function wbNodeColorOf(m) {
	const as = (v) => { const t = String(v == null ? '' : v).trim(); if (!t || t === 'none' || t === 'transparent') return null; if (/^#[0-9a-f]{6}$/i.test(t)) return t; return WB_STICKY_COLORS.some((c) => c.id === t) ? t : null; };
	return m ? as(m.color) || as(m.fill) || as(m.bg) : null;
}
function wbStickyColor(id) { if (/^#[0-9a-f]{6}$/i.test(String(id || ''))) return { id, hex: id, fg: wbContrastText(id) }; return WB_STICKY_COLORS.find((c) => c.id === id) || WB_STICKY_COLORS[0]; } // any hex from the colour wheel is a colour too
function wbHslHex(h, s, l) { const f = (n) => { const k = (n + h / 30) % 12; const a = s * Math.min(l, 1 - l); const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); return Math.round(c * 255).toString(16).padStart(2, '0'); }; return '#' + f(0) + f(8) + f(4); }
function wbHexHsl(hex) { const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '')); if (!m) return null; const n = parseInt(m[1], 16); const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); const l = (mx + mn) / 2; if (mx === mn) return { h: 0, s: 0, l }; const d = mx - mn; const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return { h: h * 60, s, l }; }
function wbHexLum(hex) { const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim()); if (!m) return null; const n = parseInt(m[1], 16); const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255; return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }
function wbContrastText(bg) { const l = wbHexLum(bg); if (l == null) return null; return l > 0.55 ? '#1c1c1e' : '#f2f2f2'; }
function wbIsDarkApp() { const h = document.documentElement; return h.classList.contains('is-dark') || h.classList.contains('basic-dark') || getComputedStyle(h).colorScheme === 'dark'; }

// ---------------------------------------------------------------------------
// Scene model
// ---------------------------------------------------------------------------
function wbNewScene() { return { v: 1, nodes: [], edges: [], view: { x: 0, y: 0, z: 1 }, settings: { bg: 'dots', theme: 'auto', snap: true } }; }
// keep only the inline formatting we understand (b/i/u/s/mark/span colour/background, br, div); everything else is text
function wbSanitizeHtml(html) {
	const box = document.createElement('div'); box.innerHTML = html || '';
	const ok = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'MARK', 'SPAN', 'BR', 'DIV', 'FONT']);
	const walk = (el) => { for (const c of [...el.childNodes]) { if (c.nodeType === 3) continue; if (c.nodeType !== 1 || !ok.has(c.tagName)) { const t = document.createTextNode(c.textContent || ''); el.replaceChild(t, c); continue; } walk(c); const keep = {}; if (c.style && c.style.color) keep.color = c.style.color; if (c.style && c.style.backgroundColor) keep.backgroundColor = c.style.backgroundColor; if (c.tagName === 'FONT' && c.color) keep.color = c.color; for (const a of [...c.attributes]) c.removeAttribute(a.name); if (keep.color) c.style.color = keep.color; if (keep.backgroundColor) c.style.backgroundColor = keep.backgroundColor; } };
	walk(box); return box.innerHTML;
}
function wbNode(type, x, y, w, h, extra) { return Object.assign({ id: wbUid(), type, x, y, w, h }, extra || {}); }
function wbBBox(nodes) {
	if (!nodes.length) return null;
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const n of nodes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h); }
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
function wbCenter(n) { return { x: n.x + n.w / 2, y: n.y + n.h / 2 }; }
function wbSidePoint(n, side) {
	if (side === 'left') return { x: n.x, y: n.y + n.h / 2 };
	if (side === 'right') return { x: n.x + n.w, y: n.y + n.h / 2 };
	if (side === 'top') return { x: n.x + n.w / 2, y: n.y };
	return { x: n.x + n.w / 2, y: n.y + n.h };
}
// Which side of a box points at p: the one whose normal best matches the direction from the box's centre.
function wbSideToward(n, p) {
	const c = wbCenter(n); const dx = p.x - c.x, dy = p.y - c.y;
	if (Math.abs(dx) / Math.max(1, n.w / 2) >= Math.abs(dy) / Math.max(1, n.h / 2)) return dx >= 0 ? 'right' : 'left';
	return dy >= 0 ? 'bottom' : 'top';
}
// A path through fixed waypoints. 'straight' is a polyline, 'elbow' steps at right angles, and 'curved' is one smooth
// spline through every point (Catmull-Rom turned into cubics), leaving and entering the nodes along their side normals.
// A rounded corner between straight segments was not enough: at board zoom it read as a sharp V, which is what he saw.
function wbWayPath(pts, route, n0, n1) {
	let p = pts.slice();
	if (route === 'elbow') {
		// a short stub along each node's normal first, so the line leaves and enters square to the box instead of sliding into the side of an anchor
		const S = 22, f = p[0], l = p[p.length - 1];
		const src = [f, { x: f.x + n0[0] * S, y: f.y + n0[1] * S }].concat(p.slice(1, -1), [{ x: l.x + n1[0] * S, y: l.y + n1[1] * S }, l]);
		const out = [src[0]]; for (let i = 1; i < src.length; i++) { const a = out[out.length - 1], b = src[i]; if (a.x !== b.x && a.y !== b.y) out.push({ x: b.x, y: a.y }); out.push(b); }
		p = out;
	}
	if (route !== 'curved' || p.length < 2) return p.map((q, i) => (i ? 'L' : 'M') + q.x + ' ' + q.y).join(' ');
	// A cardinal spline with CLAMPED handles. The plain Catmull-Rom tangent (neighbour distance / 6) overshoots badly when a
	// short segment follows a long one, which is the kink he saw between two bends placed close together: the handle length is
	// therefore tied to the SHORTER of the two neighbouring segments, while its direction still comes from both, so the join
	// stays smooth.
	const H = [];
	for (let i = 1; i < p.length - 1; i++) {
		const a = p[i - 1], b = p[i], c = p[i + 1];
		const l1 = Math.hypot(b.x - a.x, b.y - a.y) || 1, l2 = Math.hypot(c.x - b.x, c.y - b.y) || 1;
		// the tangent bisects the two SEGMENT DIRECTIONS (unit vectors), so a far-away neighbour cannot drag it: taking the
		// raw chord c - a let a long approach pull the tangent up and the curve overshot into a wiggle between two close bends
		let tx = (b.x - a.x) / l1 + (c.x - b.x) / l2, ty = (b.y - a.y) / l1 + (c.y - b.y) / l2;
		let L = Math.hypot(tx, ty);
		if (L < 1e-6) { tx = (c.x - b.x) / l2; ty = (c.y - b.y) / l2; L = 1; } // a fold back on itself: follow the outgoing leg
		const k = Math.min(l1, l2) * 0.35;
		H[i] = { x: tx / L * k, y: ty / L * k };
	}
	let d = 'M' + p[0].x + ' ' + p[0].y;
	for (let i = 0; i < p.length - 1; i++) {
		const a = p[i], b = p[i + 1], seg = Math.hypot(b.x - a.x, b.y - a.y) || 1, k = wbClamp(seg * 0.4, 8, 150);
		const c1 = i === 0 ? { x: a.x + n0[0] * k, y: a.y + n0[1] * k } : { x: a.x + H[i].x, y: a.y + H[i].y };
		const c2 = i === p.length - 2 ? { x: b.x + n1[0] * k, y: b.y + n1[1] * k } : { x: b.x - H[i + 1].x, y: b.y - H[i + 1].y };
		d += ' C' + c1.x + ' ' + c1.y + ',' + c2.x + ' ' + c2.y + ',' + b.x + ' ' + b.y;
	}
	return d;
}
function wbAutoSides(a, b) {
	const ca = wbCenter(a), cb = wbCenter(b);
	const dx = cb.x - ca.x, dy = cb.y - ca.y;
	// Prefer horizontal when the gap between boxes is horizontal, else vertical.
	const gapX = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
	const gapY = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
	if (gapX >= gapY || Math.abs(dx) > Math.abs(dy) * 1.5) return dx >= 0 ? ['right', 'left'] : ['left', 'right'];
	return dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom'];
}
const WB_NORMAL = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };
// Returns {d, start, end, dirEnd, dirStart, mid} for an edge between two anchor points.
function wbEdgePath(q0, s0, q1, s1, route, trim0, trim1) {
	const n0 = WB_NORMAL[s0], n1 = WB_NORMAL[s1];
	// trim0/trim1: shorten the stroke at either end by the arrowhead's length so the line ends at the head's base
	// (curved and elbow routes leave/arrive along the side normal; straight ones along the line itself)
	let p0 = q0, p1 = q1;
	if (route === 'straight' || !route || (route !== 'curved' && route !== 'elbow')) { const dl = Math.hypot(q1.x - q0.x, q1.y - q0.y) || 1; const ux = (q1.x - q0.x) / dl, uy = (q1.y - q0.y) / dl; p0 = { x: q0.x + ux * (trim0 || 0), y: q0.y + uy * (trim0 || 0) }; p1 = { x: q1.x - ux * (trim1 || 0), y: q1.y - uy * (trim1 || 0) }; }
	else { p0 = { x: q0.x + n0[0] * (trim0 || 0), y: q0.y + n0[1] * (trim0 || 0) }; p1 = { x: q1.x + n1[0] * (trim1 || 0), y: q1.y + n1[1] * (trim1 || 0) }; }
	const dist = Math.hypot(p1.x - p0.x, p1.y - p0.y);
	if (route === 'curved') {
		const k = wbClamp(dist * 0.45, 30, 180);
		const c0 = { x: p0.x + n0[0] * k, y: p0.y + n0[1] * k }, c1 = { x: p1.x + n1[0] * k, y: p1.y + n1[1] * k };
		const bz = (t) => { const u = 1 - t; return { x: u * u * u * p0.x + 3 * u * u * t * c0.x + 3 * u * t * t * c1.x + t * t * t * p1.x, y: u * u * u * p0.y + 3 * u * u * t * c0.y + 3 * u * t * t * c1.y + t * t * t * p1.y }; };
		return { d: 'M' + p0.x + ' ' + p0.y + ' C ' + c0.x + ' ' + c0.y + ', ' + c1.x + ' ' + c1.y + ', ' + p1.x + ' ' + p1.y, dirEnd: [p1.x - c1.x, p1.y - c1.y], dirStart: [p0.x - c0.x, p0.y - c0.y], mid: bz(0.5) };
	}
	if (route === 'elbow') {
		const horiz = (s0 === 'left' || s0 === 'right');
		let pts;
		if (horiz && (s1 === 'left' || s1 === 'right')) { const mx = (p0.x + p1.x) / 2; pts = [p0, { x: mx, y: p0.y }, { x: mx, y: p1.y }, p1]; }
		else if (!horiz && (s1 === 'top' || s1 === 'bottom')) { const my = (p0.y + p1.y) / 2; pts = [p0, { x: p0.x, y: my }, { x: p1.x, y: my }, p1]; }
		else if (horiz) pts = [p0, { x: p1.x, y: p0.y }, p1];
		else pts = [p0, { x: p0.x, y: p1.y }, p1];
		const d = pts.map((p, i) => (i ? 'L' : 'M') + p.x + ' ' + p.y).join(' ');
		const a = pts[pts.length - 2], b = pts[pts.length - 1];
		const m0 = pts[Math.floor((pts.length - 1) / 2)], m1 = pts[Math.floor((pts.length - 1) / 2) + 1];
		return { d, dirEnd: [b.x - a.x, b.y - a.y], dirStart: [pts[0].x - pts[1].x, pts[0].y - pts[1].y], mid: { x: (m0.x + m1.x) / 2, y: (m0.y + m1.y) / 2 } };
	}
	return { d: 'M' + p0.x + ' ' + p0.y + ' L ' + p1.x + ' ' + p1.y, dirEnd: [p1.x - p0.x, p1.y - p0.y], dirStart: [p0.x - p1.x, p0.y - p1.y], mid: { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 } };
}
function wbArrowHead(p, dir, size) {
	const l = Math.hypot(dir[0], dir[1]) || 1; const ux = dir[0] / l, uy = dir[1] / l;
	const bx = p.x - ux * size, by = p.y - uy * size; const px = -uy * size * 0.5, py = ux * size * 0.5;
	return 'M' + p.x + ' ' + p.y + ' L' + (bx + px) + ' ' + (by + py) + ' L' + (bx - px) + ' ' + (by - py) + ' Z';
}
function wbShapePath(kind, w, h) {
	const r = Math.min(w, h);
	if (kind === 'ellipse') return 'M' + (w / 2) + ' 0 A' + (w / 2) + ' ' + (h / 2) + ' 0 1 1 ' + (w / 2) + ' ' + h + ' A' + (w / 2) + ' ' + (h / 2) + ' 0 1 1 ' + (w / 2) + ' 0 Z';
	if (kind === 'diamond') return 'M' + (w / 2) + ' 0 L' + w + ' ' + (h / 2) + ' L' + (w / 2) + ' ' + h + ' L0 ' + (h / 2) + ' Z';
	if (kind === 'triangle') return 'M' + (w / 2) + ' 0 L' + w + ' ' + h + ' L0 ' + h + ' Z';
	if (kind === 'arrow') { const t = Math.min(w * 0.3, h * 0.6); const y0 = h * 0.25, y1 = h * 0.75; return 'M0 ' + y0 + ' L' + (w - t) + ' ' + y0 + ' L' + (w - t) + ' 0 L' + w + ' ' + (h / 2) + ' L' + (w - t) + ' ' + h + ' L' + (w - t) + ' ' + y1 + ' L0 ' + y1 + ' Z'; }
	const rad = kind === 'pill' ? Math.min(w, h) / 2 : (kind === 'rounded' ? Math.min(12, r / 4) : 0);
	if (!rad) return 'M0 0 H' + w + ' V' + h + ' H0 Z';
	return 'M' + rad + ' 0 H' + (w - rad) + ' A' + rad + ' ' + rad + ' 0 0 1 ' + w + ' ' + rad + ' V' + (h - rad) + ' A' + rad + ' ' + rad + ' 0 0 1 ' + (w - rad) + ' ' + h + ' H' + rad + ' A' + rad + ' ' + rad + ' 0 0 1 0 ' + (h - rad) + ' V' + rad + ' A' + rad + ' ' + rad + ' 0 0 1 ' + rad + ' 0 Z';
}

// One picture of a scene (frames, notes, cards, edges as shapes on the board colour): the record banner and the boards page share it.
function wbPaintScene(cv, scene) {
	const W = cv.width, H = cv.height; const g = cv.getContext('2d'); const byId = new Map((scene.nodes || []).map((n) => [n.id, n]));
	const st = scene.settings || {}; const bgc = st.bgColor || (wbIsDarkApp() ? '#141416' : '#f6f6f7'); g.fillStyle = bgc; g.fillRect(0, 0, W, H);
	const nodes = scene.nodes || []; const bb = wbBBox(nodes); if (!bb) return;
	const pad = 40; const sc = Math.min((W - pad * 2) / Math.max(1, bb.w), (H - pad * 2) / Math.max(1, bb.h), 1.2); const ox = (W - bb.w * sc) / 2 - bb.x * sc, oy = (H - bb.h * sc) / 2 - bb.y * sc;
	const P = (x, y) => [ox + x * sc, oy + y * sc]; const dark = wbHexLum(bgc) < 0.55;
	g.strokeStyle = dark ? 'rgba(255,255,255,.35)' : 'rgba(0,0,0,.3)'; g.lineWidth = Math.max(1, 1.5 * sc);
	for (const e of (scene.edges || [])) { const a = byId.get(e.from), b2 = byId.get(e.to); if (!a || !b2) continue; const [x1, y1] = P(a.x + a.w / 2, a.y + a.h / 2), [x2, y2] = P(b2.x + b2.w / 2, b2.y + b2.h / 2); g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); }
	const rr = (x, y, w, h, r, fill, stroke) => { g.beginPath(); g.roundRect(x, y, w, h, r); if (fill) { g.fillStyle = fill; g.fill(); } if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1; g.stroke(); } };
	const order = nodes.slice().sort((a, b2) => (a.type === 'frame' ? 0 : 1) - (b2.type === 'frame' ? 0 : 1));
	for (const n of order) { const [x, y] = P(n.x, n.y); const w = n.w * sc, h = n.h * sc; const r = Math.max(1, 3 * sc);
		if (n.type === 'frame') rr(x, y, w, h, r, wbStickyColor(n.color || 'white').hex, 'rgba(0,0,0,.12)');
		else if (n.type === 'sticky') rr(x, y, w, h, r, wbStickyColor(n.color).hex, null);
		else if (n.type === 'board') rr(x, y, w, h, r * 2, n.color ? wbStickyColor(n.color).hex : '#71BEF2', null);
		else if (n.type === 'shape') rr(x, y, w, h, r, n.fill && n.fill !== 'none' && n.fill.startsWith('#') ? n.fill : (dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.06)'), dark ? 'rgba(255,255,255,.5)' : 'rgba(0,0,0,.4)');
		else if (n.type === 'note') rr(x, y, w, h, r, n.color ? wbStickyColor(n.color).hex : (dark ? '#0F0F11' : '#ffffff'), 'rgba(127,127,127,.35)');
		else if (n.type === 'card' || n.type === 'line' || n.type === 'link') rr(x, y, w, h, r, dark ? '#1b1b1f' : '#ffffff', 'rgba(127,127,127,.35)');
		else if (n.type === 'image') rr(x, y, w, h, r, dark ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.10)', null);
		else if (n.type === 'text' || n.type === 'mind') { g.fillStyle = dark ? 'rgba(255,255,255,.55)' : 'rgba(0,0,0,.5)'; const lh = Math.max(2, 3 * sc); const lines = Math.max(1, Math.min(4, Math.round(h / (lh * 2.2)))); for (let i = 0; i < lines; i++) rr(x, y + i * lh * 2.2 + lh * .6, w * (i === lines - 1 ? .6 : .9), lh, lh / 2, g.fillStyle, null); }
	}
}
// ---------------------------------------------------------------------------
// Board: one board rendered in one panel.
// ---------------------------------------------------------------------------
class WbBoard {
	constructor(plugin, panel, host, rec, scene) {
		this.plugin = plugin; this.panel = panel; this.host = host; this.rec = rec;
		this.scene = scene || wbNewScene();
		this.cam = Object.assign({ x: 0, y: 0, z: 1 }, this.scene.view || {});
		// The camera is a per-device thing and is kept in localStorage (2026-09-22): every pan used to upload the whole scene as a new
		// blob (2412 whiteboard.json files, 51 MB, in his Markdown Mirror), and a shared camera made two devices fight over the view.
		try { const v = JSON.parse(localStorage.getItem('wb_view_' + rec.guid) || 'null'); if (v && isFinite(v.x) && isFinite(v.y) && isFinite(v.z) && v.z > 0) { Object.assign(this.cam, v); this._camFromDevice = true; } } catch (e) {}
		this.tool = 'select'; this.shapeKind = 'rounded'; this.stickyColor = 'yellow'; this.stickyWide = false; this.frameKind = 'custom';
		this.selected = new Set(); this.selectedEdge = null; this.editing = null; this.hover = null;
		this.nodeEls = new Map(); this.edgeEls = new Map(); this.imgUrls = new Map();
		this.undo = []; this.redo = []; this.destroyed = false; this.space = false;
		this.drag = null; this.saveT = null; this.viewT = null; this.raf = 0; this.dirty = false;
		this.disposers = [];
		this.mount();
	}

	// --- DOM -----------------------------------------------------------------
	mount() {
		const h = this.host; h.innerHTML = ''; h.classList.add('wb-host'); h.tabIndex = 0;
		this.applyTheme();
		this.titleEl = null; this.pageBtn = null; this.chromeEls = [];
		// canvas layers
		this.canvas = wbEl('div', 'wb-canvas');
		this.world = wbEl('div', 'wb-world');
		this.frames = wbEl('div', 'wb-frames'); // frames sit under the edges layer so connectors inside a frame stay visible
		this.edges = wbSvgEl('svg', { class: 'wb-edges' });
		this.nodes = wbEl('div', 'wb-nodes');
		this.world.appendChild(this.frames); this.world.appendChild(this.edges); this.world.appendChild(this.nodes);
		this.canvas.appendChild(this.world);
		this.overlay = wbEl('div', 'wb-overlay');
		this.canvas.appendChild(this.overlay);
		h.appendChild(this.canvas);
		this.measureChrome();
		this.applyTheme();
		this.buildRail(); this.buildZoom(); this.ensureChrome();
		this.ctx = null;
		this.bindInput();
		this.applyBg(); this.applyCamera(); this.renderAll();
		this.fitIfFresh();
	}
	measureChrome() {
		const root = this.host.closest('.panel');
		const bar = root && root.querySelector('.panel-bar--tabsbar'); const sb = root && root.querySelector('.vscrollbar');
		this.host.style.setProperty('--wb-bar', (bar && bar.offsetHeight ? bar.offsetHeight : 35) + 'px');
		this.host.style.setProperty('--wb-gutter', (sb && sb.offsetWidth ? sb.offsetWidth : 10) + 'px');
	}
	applyTheme() {
		const t = (this.scene.settings && this.scene.settings.theme) || 'auto';
		if (!this.canvas) return;
		this.canvas.classList.toggle('wb-force-light', t === 'light');
		this.canvas.classList.toggle('wb-force-dark', t === 'dark');
	}
	applyBg() {
		const st = this.scene.settings || {}; const bg = st.bg || 'dots';
		this.canvas.classList.toggle('wb-bg-dots', bg === 'dots');
		this.canvas.classList.toggle('wb-bg-lines', bg === 'lines');
		const c = st.bgColor && wbHexLum(st.bgColor) != null ? st.bgColor : null;
		const cs = this.canvas.style;
		// Contrast tokens go on the WORLD layer only, so the toolbars and zoom pill keep their surface colours.
		const ws = this.world.style;
		if (c) { const dark = wbHexLum(c) < 0.55; cs.backgroundColor = c; cs.setProperty('--wb-grid', dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.14)'); ws.setProperty('--wb-text', dark ? '#e6e6e6' : '#1c1c1e'); ws.setProperty('--wb-muted', dark ? '#b0b0b0' : '#555'); ws.setProperty('--wb-faint', dark ? '#8a8a8a' : '#777'); ws.setProperty('--wb-edge', dark ? '#b0b0b0' : '#555'); ws.setProperty('--wb-surface', dark ? '#2a2a2e' : '#ffffff'); ws.setProperty('--wb-line', dark ? 'rgba(255,255,255,.16)' : 'rgba(0,0,0,.14)'); ws.setProperty('--wb-card', dark ? '#2a2a2e' : '#ffffff'); ws.setProperty('--wb-card-line', dark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.12)'); }
		else { cs.backgroundColor = ''; cs.removeProperty('--wb-grid'); for (const v of ['--wb-text', '--wb-muted', '--wb-faint', '--wb-edge', '--wb-surface', '--wb-line', '--wb-card', '--wb-card-line']) ws.removeProperty(v); }
	}
	// Chrome lives in Thymer's own panel bar: [Boards v] [Page] [Settings]. No second bar, no repeated title.
	ensureTopbar() {
		if (this.topbar && this.topbar.isConnected) return this.topbar;
		const bar = wbEl('div', 'wb-topbar'); bar.addEventListener('pointerdown', (e) => e.stopPropagation());
		bar.appendChild(wbEl('span', 'wb-tbgrp wb-tbcoll')); bar.appendChild(wbEl('span', 'wb-nbsep')); bar.appendChild(wbEl('span', 'wb-tbgrp wb-tbmain'));
		// folded by default (his ruling: it should not take space until wanted); the state is remembered per user
		let open = false; try { open = localStorage.getItem('wb_topbar_open') === '1'; } catch (e) {}
		const tog = wbEl('span', 'wb-tbtoggle'); bar.appendChild(tog);
		const paint = () => { bar.classList.toggle('is-collapsed', !open); tog.innerHTML = open ? WB_SVG('<path d="M9 6l6 6-6 6"></path>') : WB_SVG('<path d="M4 6h16M4 12h16M4 18h16"></path><circle cx="9" cy="6" r="2" fill="var(--wb-surface)"></circle><circle cx="15" cy="12" r="2" fill="var(--wb-surface)"></circle><circle cx="7" cy="18" r="2" fill="var(--wb-surface)"></circle>'); tog.title = open ? 'Fold the board menu' : 'Board menu'; };
		tog.addEventListener('click', (e) => { e.stopPropagation(); open = !open; try { localStorage.setItem('wb_topbar_open', open ? '1' : '0'); } catch (x) {} paint(); this.plugin.closeMenus(); });
		paint();
		this.host.appendChild(bar); this.topbar = bar; this.topbarSep(); return bar;
	}
	topbarSep() { const b = this.topbar; if (!b) return; const sep = b.querySelector('.wb-nbsep'); const l = b.querySelector('.wb-tbcoll'); if (sep) sep.style.display = l && l.childElementCount && !b.classList.contains('is-collapsed') ? '' : 'none'; }
	ensureChrome() {
		const root = this.host.closest('.panel'); const icons = this.ensureTopbar().querySelector('.wb-tbmain');
		if (!icons) return false;
		try { if (!root._wbNavHook) { root._wbNavHook = true; const plugin = this.plugin; const pid = this.panel.getId(); const onNav = (e) => { const t = e.target && e.target.closest ? e.target.closest("span.ti-arrow-left[data-tooltip-html^='Back'], span.ti-arrow-right[data-tooltip-html^='Forward']") : null; if (!t) return; const b = plugin.boards.get(pid); if (!b || b.destroyed) return; e.stopPropagation(); e.preventDefault(); if (t.classList.contains('ti-arrow-left')) plugin.goBack(b.panel); else plugin.goForward(b.panel); }; root.addEventListener('pointerdown', onNav, true); root.addEventListener('mousedown', onNav, true); root.addEventListener('click', onNav, true); } } catch (e) {}
		if (this.chromeEls.length && this.chromeEls[0].isConnected && this.chromeEls[0].parentNode === icons) return true;
		for (const el of this.chromeEls) el.remove(); this.chromeEls = [];
		const mk = (html, title, fn) => { const b = wbEl('span', 'wb-nb', html); b.title = title; b.addEventListener('pointerdown', (e) => e.stopPropagation()); b.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); fn(b); }); return b; };
		const boards = mk(WB_I.board + '<span>Boards</span>' + WB_I.chev.replace('style="width:11px;height:11px"', 'class="wb-chev"'), 'Switch board', (b) => this.plugin.openBoardMenu(b, this));
		const chev0 = WB_I.chev.replace('style="width:11px;height:11px"', 'class="wb-chev"');
		this.pageBtn = mk('<span class="ti ti-file"></span><span></span>' + chev0, 'The pages this board sits on', (b) => { if (this.popEl && this._menuAnchor === b) { this.closeDestPicker(); this._menuAnchor = null; return; } this.plugin.closeMenus(); this._menuAnchor = b; this.pagesPicker(b); });
		const gear = mk(WB_I.gear + '<span>Settings</span>', 'Board settings', (b) => this.boardMenu(b));
		icons.appendChild(boards); icons.appendChild(gear); const collGrp = this.ensureTopbar().querySelector('.wb-tbcoll'); if (collGrp) collGrp.appendChild(this.pageBtn);
		this.chromeEls = [boards, this.pageBtn, gear];
		this.refreshPageBtn(); if (!this.collChromeEls || !this.collChromeEls.length) this.buildCollectionBar();
		this.paintParentCrumb(root);
		return true;
	}
	async boardPagesFresh() { let r = null; try { r = await this.plugin.data.getRecord(this.rec.guid); } catch (e) {} return this.plugin.boardPages(r || this.rec); }
	async pagesPicker(anchor) {
		const pages = await this.boardPagesFresh(); if (this._menuAnchor !== anchor) return;
		const linked = pages.map((pg) => { let icon = 'ti-file'; try { icon = wbTi((pg.getIcon && pg.getIcon(true)) || this.collIcon(this.collGuidOf(pg)), 'ti-file'); } catch (e) {} return { guid: pg.guid, name: pg.getName() || 'Untitled', icon, rec: pg }; });
		const toggle = {
			linked: () => linked, isOn: (guid) => linked.some((x) => x.guid === guid),
			onToggle: (guid, on, info) => { if (on) { linked.push({ guid, name: info.name, icon: info.icon, rec: info.rec }); this.linkPage({ kind: 'page', guid, name: info.name }); } else { const i = linked.findIndex((x) => x.guid === guid); if (i >= 0) linked.splice(i, 1); this.setBoardPages(linked.map((x) => x.guid)); this.plugin.linkBoardToPage(this.rec, null, guid).catch(() => {}); } },
			onOpen: (guid) => { const x = linked.find((y) => y.guid === guid); if (x && x.rec) this.plugin.openPage(x.rec, this); },
		};
		this.noteAttachPicker(anchor, null, { pagesOnly: true, toggle });
	}
	// a sub-board shows "Parent › " in front of its tab title; click goes back to the parent board
	async paintParentCrumb(root) {
		const pages = await this.boardPagesFresh(); let parent = null; for (const pg of pages) { if (await this.plugin.isBoardRecord(pg)) { parent = pg; break; } }
		const title = root && root.querySelector('.panel-tab--title'); if (!title) return;
		const old = title.querySelector('.wb-crumb'); if (old) old.remove();
		if (!parent) return;
		const crumb = wbEl('span', 'wb-crumb', '<span class="wb-crumb-name">' + wbEsc(parent.getName() || 'Board') + '</span><span class="wb-crumb-sep">›</span>');
		crumb.title = 'Back to ' + (parent.getName() || 'the parent board');
		crumb.addEventListener('pointerdown', (e) => e.stopPropagation()); crumb.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); this.plugin.openBoard(parent.guid, this.panel); });
		title.insertBefore(crumb, title.firstChild); title.style.whiteSpace = 'nowrap';
	}
	pageMenu(anchor) {
		const pages = this.plugin.boardPages(this.rec); const items = [];
		for (const pg of pages) { let ic = 'ti-file'; try { ic = (pg.getIcon && pg.getIcon(true)) || this.collIcon(this.collGuidOf(pg)) || ic; } catch (e) {} items.push({ v: 'open:' + pg.guid, label: pg.getName() || 'Untitled', icon: ic }); }
		if (pages.length) items.push({ sep: true });
		items.push({ v: 'link', label: 'Link to a page', icon: 'ti-link' });
		for (const pg of pages) items.push({ v: 'unlink:' + pg.guid, label: 'Unlink from ' + (pg.getName() || 'Untitled'), icon: 'ti-link' });
		wbMenu(anchor, items, null, (v) => {
			if (v === 'link') { setTimeout(() => this.noteAttachPicker(anchor, null, { pagesOnly: true, onPick: (d) => this.linkPage(d) }), 0); return; }
			if (v.startsWith('open:')) { const pg = pages.find((x) => x.guid === v.slice(5)); if (pg) this.plugin.openPage(pg, this); return; }
			if (v.startsWith('unlink:')) { const g = v.slice(7); this.setBoardPages(this.plugin.boardPages(this.rec).map((x) => x.guid).filter((x) => x !== g)); this.plugin.linkBoardToPage(this.rec, null, g).catch(() => {}); this.plugin.toast('Unlinked.'); }
		}, { width: 280, dots: false });
	}
	setBoardPages(guids) { (async () => { let r = null; try { r = await this.plugin.data.getRecord(this.rec.guid); } catch (e) {} let prev = []; try { prev = this.plugin.boardPages(r || this.rec).map((p) => p.guid); } catch (e) {} try { (r || this.rec).prop(WB_F.page.label).set(guids); } catch (e) {} for (const g of prev) if (!guids.includes(g)) this.plugin.linkBoardToPage(this.rec, null, g).catch(() => {}); setTimeout(() => this.refreshPageBtn(), 400); })(); } // a page dropped here also loses the board in its own Boards property, so the two sides agree
	linkPage(dest) {
		if (!dest || dest.kind !== 'page' || !dest.guid) return;
		(async () => { const cur = (await this.boardPagesFresh()).map((x) => x.guid); if (cur.includes(dest.guid)) return; this.setBoardPages(cur.concat([dest.guid])); this.plugin.linkBoardToPage(this.rec, dest.guid, null).catch(() => {}); })();
	}
	attachPagePop(anchor) {
		this.plugin.closeMenus();
		const pop = wbEl('div', 'wb-picker'); pop.addEventListener('pointerdown', (e) => e.stopPropagation());
		const inp = document.createElement('input'); inp.placeholder = 'Find a page to show this board on'; pop.appendChild(inp); const list = wbEl('div', 'wb-plist'); pop.appendChild(list);
		let seq = 0; const paint = async () => { const q = inp.value.trim(); const my = ++seq; list.innerHTML = ''; if (!q) return; let res = null; try { res = await this.plugin.data.searchByQuery(q, 20); } catch (e) {} if (my !== seq) return; for (const r of ((res && res.records) || []).filter((r) => r.guid !== this.rec.guid)) { const row = wbEl('div', 'wb-prow', '<span class="ti ' + wbEsc((r.getIcon && r.getIcon(true)) || 'ti-file-text') + '"></span><span class="wb-plabel">' + wbEsc(r.getName() || 'Untitled') + '</span><span class="wb-pmeta">' + wbEsc(this.plugin.collectionNameOf(r)) + '</span>'); row.addEventListener('click', (e) => { e.stopPropagation(); this.plugin.closeMenus(); try { let prevG = null; try { prevG = (this.rec.prop(WB_F.page.label).texts && this.rec.prop(WB_F.page.label).texts()[0]) || null; } catch (y) {} const pr = this.rec.prop(WB_F.page.label); if (pr.addValue) pr.addValue(r.guid); else pr.set([r.guid]); this.plugin.linkBoardToPage(this.rec, r.guid, null).catch(() => {}); } catch (x) {} setTimeout(() => this.refreshPageBtn(), 400); this.plugin.toast('Linked to ' + (r.getName() || 'the page') + '.'); }); list.appendChild(row); } };
		inp.addEventListener('input', () => { clearTimeout(inp._t); inp._t = setTimeout(paint, 120); }); inp.addEventListener('keydown', (e) => e.stopPropagation());
		this.host.appendChild(pop); this.plugin._pop = pop; const r = anchor.getBoundingClientRect(); const hr = this.host.getBoundingClientRect(); pop.style.left = Math.max(hr.left + 8, Math.min(r.left, hr.right - 328)) + 'px'; pop.style.top = (r.bottom + 6) + 'px';
		const out = (e) => { if (!pop.contains(e.target)) this.plugin.closeMenus(); }; document.addEventListener('pointerdown', out, true); pop._out = out; setTimeout(() => inp.focus(), 0);
	}
	renamePop(anchor, recordGuid) {
		this.plugin.closeMenus();
		const target = recordGuid ? this.plugin.recordSync(recordGuid) : this.rec; if (!target) return;
		const pop = wbEl('div', 'wb-rename'); pop.addEventListener('pointerdown', (e) => e.stopPropagation());
		const inp = document.createElement('input'); inp.value = target.getName() || ''; inp.placeholder = 'Board name';
		inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); const v = inp.value.trim(); this.plugin.closeMenus(); if (v && v !== target.getName()) { if (recordGuid) { try { const t = target.prop('Title'); if (t) t.set(v); } catch (x) {} setTimeout(() => { for (const n of this.scene.nodes) if (n.type === 'board' && n.recordGuid === recordGuid) { const el = this.nodeEls.get(n.id); if (el) this.paintBoardCard(n, el); } }, 400); } else this.plugin.renameBoard(this, v); } } });
		pop.appendChild(inp); this.host.appendChild(pop); this.plugin._pop = pop;
		const r = anchor.getBoundingClientRect(); const hr = this.host.getBoundingClientRect();
		pop.style.left = Math.max(hr.left + 8, Math.min(r.left, hr.right - pop.offsetWidth - 8)) + 'px'; pop.style.top = (r.bottom + 6) + 'px';
		const out = (e) => { if (!pop.contains(e.target)) this.plugin.closeMenus(); }; document.addEventListener('pointerdown', out, true); pop._out = out;
		setTimeout(() => { inp.focus(); inp.select(); }, 0);
	}
	refreshPageBtn() {
		if (!this.pageBtn) return;
		this.boardPagesFresh().then((pages) => { if (!this.pageBtn || !this.pageBtn.isConnected) return; this.paintPageBtn(pages); });
	}
	paintPageBtn(pages) {
		const ic = this.pageBtn.querySelector('.ti'); const lbl = this.pageBtn.querySelectorAll('span')[1];
		let icon = 'ti-file', text = 'Page';
		if (pages.length === 1) { const pg = pages[0]; text = pg.getName() || 'Untitled'; if (text.length > 26) text = text.slice(0, 25) + '…'; try { icon = wbTi((pg.getIcon && pg.getIcon(true)) || this.collIcon(this.collGuidOf(pg)), 'ti-file'); } catch (e) {} }
		else if (pages.length > 1) { text = pages.length + ' pages'; icon = 'ti-files'; }
		if (ic) ic.className = 'ti ' + icon; if (lbl) lbl.textContent = text; this.pageBtn.classList.toggle('is-muted', !pages.length);
		this.pageBtn.title = pages.length ? 'Open, link or unlink the pages this board sits on' : 'Link this board to a page';
	}
	buildRail() {
		const rail = wbEl('div', 'wb-rail');
		const tools = [
			['select', 'Select', 'V'], ['sticky', 'Sticky', 'N'], ['text', 'Text', 'T'], ['shape', 'Shape', 'S'],
			['frame', 'Frame', 'F'], ['image', 'Image', 'I'], ['note', 'Card', 'K'], ['card', 'Page', 'P'], ['mind', 'Mind map', 'M'], ['connect', 'Connect', 'L'], ['comment', 'Comment', 'C'],
		]; // Mind map back in the rail (his ask 2026-09-22): a click on empty canvas makes a root and starts typing in it
		this.toolEls = {};
		for (const [id, label, key] of tools) {
			const b = wbEl('div', 'wb-tool', WB_I[id]);
			b.dataset.tool = id;
			if (id !== 'shape' && id !== 'sticky' && id !== 'frame') b.appendChild(wbEl('div', 'wb-tip', wbEsc(label) + '<span class="wb-key">' + key + '</span>'));
			const flyHead = () => wbEl('div', 'wb-flyhead', wbEsc(label) + '<span class="wb-key">' + key + '</span>');
			if (id === 'shape') {
				// The rail button shows the last chosen shape, and the flyout marks it.
				b.innerHTML = WB_SHAPE_ICON[this.shapeKind] || WB_I.shape;
				const fly = wbEl('div', 'wb-fly'); fly.appendChild(flyHead());
				for (const k of WB_SHAPES) { const fi = wbEl('div', 'wb-fi' + (k === this.shapeKind ? ' is-on' : ''), WB_SHAPE_ICON[k]); fi.title = k.charAt(0).toUpperCase() + k.slice(1); fi.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); this.shapeKind = k; fly.querySelectorAll('.wb-fi').forEach((x) => x.classList.toggle('is-on', x === fi)); b.querySelector('svg').outerHTML = WB_SHAPE_ICON[k]; this.setTool('shape'); }); fly.appendChild(fi); }
				b.appendChild(fly);
			}
			if (id === 'frame') {
				const fly = wbEl('div', 'wb-fly wb-fly-frames'); fly.appendChild(flyHead());
				WB_FRAME_FORMATS.forEach((f, i) => {
					if (i === 6) fly.appendChild(wbEl('div', 'wb-ffsep'));
					const fi = wbEl('div', 'wb-ff' + (f.id === this.frameKind ? ' is-on' : ''), WB_SVG(f.icon) + '<span>' + wbEsc(f.label) + '</span>'); fi.title = f.label + (f.ratio ? '' : ', any size');
					fi.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); this.frameKind = f.id; fly.querySelectorAll('.wb-ff').forEach((x) => x.classList.toggle('is-on', x === fi)); this.setTool('frame'); });
					fly.appendChild(fi);
				});
				b.appendChild(fly);
			}
			if (id === 'sticky') {
				const fly = wbEl('div', 'wb-fly wb-fly-colors'); fly.appendChild(flyHead());
				for (const c of WB_STICKY_COLORS) { const sw = wbEl('div', 'wb-sw'); sw.style.background = c.hex; sw.title = c.id; if (c.id === this.stickyColor) sw.classList.add('is-on'); sw.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); this.stickyColor = c.id; fly.querySelectorAll('.wb-sw').forEach((x) => x.classList.toggle('is-on', x === sw)); this.tintStickyTool(); this.setTool('sticky'); }); fly.appendChild(sw); }
				const stackBtn = wbEl('div', 'wb-flybtn', WB_I.stack + '<span>Stack</span>'); stackBtn.title = 'Place a sticky stack: drag notes off it'; stackBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); this.setTool('stack'); }); fly.appendChild(stackBtn);
				b.appendChild(fly);
			}
			b.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); if (id === 'image') this.pickImage(); else if (id === 'card') this.setTool('card'); else this.setTool(id); this.host.focus(); });
			rail.appendChild(b); this.toolEls[id] = b;
		}
		this.host.appendChild(rail); this.rail = rail;
		this.tintStickyTool();
		this.setTool('select');
	}
	buildZoom() {
		// focus mode lives next to the zoom bar: [◎ Focus v]
		const fb = wbEl('div', 'wb-zoom wb-focusbar'); const st0 = this.scene.settings || {};
		this.paintFocusDepth = () => { const el = fb.querySelector('.wb-focusn'); const sc = this.scene.settings || {}; const d = (sc.focus && sc.focus.depth) || 1; if (el) el.textContent = d >= 99 ? 'All' : String(d); if (this.placeFocusBar) this.placeFocusBar(); };
		const fbtn = wbEl('div', 'wb-tb' + (st0.focus && st0.focus.on ? ' is-on' : ''), WB_I.focus + '<span>Focus</span><span class="wb-focusdepth" title="How many relations away stay lit"><span class="wb-focusn">' + (((st0.focus && st0.focus.depth) || 1) >= 99 ? 'All' : ((st0.focus && st0.focus.depth) || 1)) + '</span>' + WB_I.chev + '</span>'); fbtn.title = 'Focus mode: dim everything but the selection and what it connects to. The number is how many connections stay; the arrow changes it'; this.focusBtn = fbtn;
		fbtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); const sc = this.scene.settings; sc.focus = sc.focus || { on: false, depth: 1 };
			if (e.target.closest && e.target.closest('.wb-focusdepth')) { wbMenu(fbtn, [1, 2, 3].map((d) => ({ v: String(d), label: d + (d > 1 ? ' connections' : ' connection'), icon: 'ti-arrows-diagonal' })).concat([{ sep: true }, { v: 'all', label: 'All connections', icon: 'ti-link' }]), (sc.focus.depth || 1) >= 99 ? 'all' : String(sc.focus.depth || 1), (d) => { sc.focus.depth = d === 'all' ? 99 : (parseInt(d, 10) || 1); if (this.paintFocusDepth) this.paintFocusDepth(); this.renderAll(); this.scheduleSave(); }, { width: 190, dots: false, alignRight: true }); return; }
			sc.focus.on = !sc.focus.on; fbtn.classList.toggle('is-on', sc.focus.on); this.renderAll(); this.scheduleSave(); });
		fb.appendChild(fbtn); this.host.appendChild(fb); this.focusBar = fb;
		const z = wbEl('div', 'wb-zoom');
		const mk = (html, title, fn) => { const b = wbEl('div', 'wb-tb', html); b.title = title; b.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); fn(); }); z.appendChild(b); return b; };
		mk(WB_I.fit, 'Fit to content', () => this.fitAll());
		z.appendChild(wbEl('div', 'wb-tsep'));
		mk(WB_I.minus, 'Zoom out', () => this.zoomBy(1 / 1.2));
		this.zoomLabel = mk('100%', 'Reset to 100%', () => this.zoomTo(1));
		this.zoomLabel.style.minWidth = '44px';
		mk(WB_I.plus, 'Zoom in', () => this.zoomBy(1.2));
		z.appendChild(wbEl('div', 'wb-tsep'));
		let mapOn = false; try { mapOn = localStorage.getItem('wb_minimap') === '1'; } catch (e) {}
		this.mapBtn = mk(WB_SVG('<path d="M3 7l6-3 6 3 6-3v13l-6 3-6-3-6 3z"></path><path d="M9 4v13M15 7v13"></path>'), 'Minimap', () => { this.mapOn = !this.mapOn; try { localStorage.setItem('wb_minimap', this.mapOn ? '1' : '0'); } catch (e) {} this.mapBtn.classList.toggle('is-on', this.mapOn); this.drawMinimap(); });
		this.mapOn = mapOn; this.mapBtn.classList.toggle('is-on', mapOn);
		this.host.appendChild(z); this.zoomBar = z;
		this.placeFocusBar = () => { if (!this.focusBar || !this.zoomBar || !this.zoomBar.isConnected) return; this.focusBar.style.right = (14 + Math.round(this.zoomBar.offsetWidth) + 8) + 'px'; };
		this.placeFocusBar();
		if (window.ResizeObserver) { const ro = new ResizeObserver(() => { if (!this.destroyed) this.placeFocusBar(); }); ro.observe(z); this.disposers.push(() => { try { ro.disconnect(); } catch (e) {} }); }
		this.buildMinimap();
	}
	// --- minimap: the whole board in a small frame above the zoom bar; the bright rectangle is the view, click or drag it to move ---
	buildMinimap() {
		const box = wbEl('div', 'wb-minimap'); const cv = document.createElement('canvas'); cv.width = 440; cv.height = 300; box.appendChild(cv); this.host.appendChild(box); this.minimap = box; this.minimapCv = cv;
		const toWorld = (e) => { const m = this._mapFit; if (!m) return null; const r = cv.getBoundingClientRect(); return { x: m.x0 + (e.clientX - r.left) / m.k, y: m.y0 + (e.clientY - r.top) / m.k }; };
		const go = (e) => { const w = toWorld(e); if (!w) return; const r = this.canvas.getBoundingClientRect(); this.cam.x = r.width / 2 - w.x * this.cam.z; this.cam.y = r.height / 2 - w.y * this.cam.z; this.applyCamera(); };
		let drag = false; box.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); drag = true; cv.setPointerCapture(e.pointerId); go(e); });
		box.addEventListener('pointermove', (e) => { if (drag) go(e); }); box.addEventListener('pointerup', () => { drag = false; }); box.addEventListener('wheel', (e) => e.stopPropagation());
		this.drawMinimap();
	}
	drawMinimap() {
		const box = this.minimap; if (!box) return; box.hidden = !this.mapOn; if (!this.mapOn) return;
		const cv = this.minimapCv, g = cv.getContext('2d'); const W = cv.width, H = cv.height; const pad = 12;
		const r = this.canvas.getBoundingClientRect(); const z = this.cam.z || 1; const view = { x: -this.cam.x / z, y: -this.cam.y / z, w: r.width / z, h: r.height / z };
		const bb = wbBBox(this.scene.nodes) || view; const x0 = Math.min(bb.x, view.x), y0 = Math.min(bb.y, view.y), x1 = Math.max(bb.x + bb.w, view.x + view.w), y1 = Math.max(bb.y + bb.h, view.y + view.h);
		const k = Math.min((W - pad * 2) / Math.max(1, x1 - x0), (H - pad * 2) / Math.max(1, y1 - y0)); const ox = (W - (x1 - x0) * k) / 2, oy = (H - (y1 - y0) * k) / 2;
		this._mapFit = { x0: x0 - ox / k, y0: y0 - oy / k, k: k / 2 }; // canvas is drawn at 2x
		const cs = getComputedStyle(this.canvas); const text = cs.getPropertyValue('--wb-text').trim() || '#888';
		g.clearRect(0, 0, W, H);
		const X = (x) => ox + (x - x0) * k, Y = (y) => oy + (y - y0) * k;
		for (const n of this.scene.nodes) { if (n.type === 'frame') { g.fillStyle = wbStickyColor(n.color || 'white').hex; g.globalAlpha = 0.5; g.fillRect(X(n.x), Y(n.y), n.w * k, n.h * k); g.globalAlpha = 1; g.strokeStyle = text; g.globalAlpha = 0.35; g.lineWidth = 1; g.strokeRect(X(n.x), Y(n.y), n.w * k, n.h * k); g.globalAlpha = 1; } }
		for (const n of this.scene.nodes) {
			if (n.type === 'frame') continue; let c = text, a = 0.45;
			if (n.type === 'sticky' || n.type === 'stack') { c = wbStickyColor(n.color || 'yellow').hex; a = 1; } else if (n.type === 'board') { c = n.color ? wbStickyColor(n.color).hex : '#71BEF2'; a = 1; } else if (n.type === 'image') { c = '#8fa3b8'; a = 0.9; } else if (n.type === 'shape' && n.fill && n.fill !== 'none') { c = n.fill; a = 0.9; } else if (n.type === 'text') { a = 0.3; }
			g.fillStyle = c; g.globalAlpha = a; g.fillRect(X(n.x), Y(n.y), Math.max(2, n.w * k), Math.max(2, n.h * k)); g.globalAlpha = 1;
		}
		const acc = cs.getPropertyValue('--wb-accent').trim() || '#3f8484'; g.strokeStyle = acc; g.lineWidth = 2; g.strokeRect(X(view.x), Y(view.y), view.w * k, view.h * k); g.fillStyle = acc; g.globalAlpha = 0.08; g.fillRect(X(view.x), Y(view.y), view.w * k, view.h * k); g.globalAlpha = 1;
	}
	tintStickyTool() { const b = this.toolEls && this.toolEls.sticky; if (!b) return; const path = b.querySelector('svg path'); if (path) { path.setAttribute('fill', wbStickyColor(this.stickyColor).hex); path.setAttribute('fill-opacity', '0.85'); } }
	setTool(id) {
		this.tool = id;
		for (const k in this.toolEls) this.toolEls[k].classList.toggle('is-active', k === id);
		this.canvas.className = 'wb-canvas wb-tool-' + id; this.applyBg();
		if (id !== 'select') this.commitEdit();
	}

	// --- camera ----------------------------------------------------------------
	applyCamera() {
		const c = this.cam;
		this.world.style.transform = 'translate(' + c.x + 'px,' + c.y + 'px) scale(' + c.z + ')'; this.world.style.setProperty('--wb-z', String(c.z));
		this.canvas.style.backgroundSize = (WB_GRID * 2 * c.z) + 'px ' + (WB_GRID * 2 * c.z) + 'px';
		this.canvas.style.backgroundPosition = (c.x % (WB_GRID * 2 * c.z)) + 'px ' + (c.y % (WB_GRID * 2 * c.z)) + 'px';
		if (this.zoomLabel) this.zoomLabel.textContent = Math.round(c.z * 100) + '%';
		this.renderOverlay(); this.placeCtx();
		if (this.imgT) clearTimeout(this.imgT); this.imgT = setTimeout(() => { this.imgT = null; this.loadVisibleImages(); }, 120);
		if (this.mapOn && !this.mapRaf) this.mapRaf = requestAnimationFrame(() => { this.mapRaf = 0; this.drawMinimap(); });
		if (this.viewT) clearTimeout(this.viewT);
		this.viewT = setTimeout(() => { this.viewT = null; this.scene.view = { x: c.x, y: c.y, z: c.z }; try { localStorage.setItem('wb_view_' + this.rec.guid, JSON.stringify(this.scene.view)); } catch (e) {} }, 600); // in memory for the next content save, on this device for the next mount; no upload
	}
	toWorld(sx, sy) { return { x: (sx - this.cam.x) / this.cam.z, y: (sy - this.cam.y) / this.cam.z }; }
	toScreen(wx, wy) { return { x: wx * this.cam.z + this.cam.x, y: wy * this.cam.z + this.cam.y }; }
	localPt(e) { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
	zoomAt(sx, sy, factor) {
		const z = wbClamp(this.cam.z * factor, WB_MIN_ZOOM, WB_MAX_ZOOM); const f = z / this.cam.z;
		this.cam.x = sx - (sx - this.cam.x) * f; this.cam.y = sy - (sy - this.cam.y) * f; this.cam.z = z;
		this.applyCamera();
	}
	zoomBy(f) { const r = this.canvas.getBoundingClientRect(); this.zoomAt(r.width / 2, r.height / 2, f); }
	zoomTo(z) { const r = this.canvas.getBoundingClientRect(); this.zoomAt(r.width / 2, r.height / 2, z / this.cam.z); }
	fitAll(nodes) {
		const list = nodes || this.scene.nodes; const bb = wbBBox(list); const r = this.canvas.getBoundingClientRect();
		if (!bb) { this.cam = { x: r.width / 2, y: r.height / 2, z: 1 }; this.applyCamera(); return; }
		const pad = 80; const z = wbClamp(Math.min((r.width - pad * 2) / Math.max(bb.w, 1), (r.height - pad * 2) / Math.max(bb.h, 1), 1.5), WB_MIN_ZOOM, WB_MAX_ZOOM);
		this.cam = { z, x: (r.width - bb.w * z) / 2 - bb.x * z, y: (r.height - bb.h * z) / 2 - bb.y * z };
		this.applyCamera();
	}
	fitIfFresh() { if (this._camFromDevice) return; if (!this.scene.view || (this.scene.view.x === 0 && this.scene.view.y === 0 && this.scene.view.z === 1 && this.scene.nodes.length)) this.fitAll(); }

	// --- render ------------------------------------------------------------------
	// A Map instead of a scan of every node (2026-09-22: 88 call sites, two per line per frame, 382 nodes on his board). The
	// index is checked on every hit (same object at the same position), so a splice, a swap or a new array rebuilds it.
	nodeById(id) {
		const nodes = this.scene.nodes; let m = this._byId;
		if (!m || m.nodes !== nodes) m = this._byId = { nodes, map: null };
		if (m.map) { const hit = m.map.get(id); if (hit && nodes[hit.i] === hit.n) return hit.n; }
		m.map = new Map(); for (let i = 0; i < nodes.length; i++) m.map.set(nodes[i].id, { n: nodes[i], i });
		const hit = m.map.get(id); return hit ? hit.n : null;
	}
	invalidate() { if (this.raf) return; this.raf = requestAnimationFrame(() => { this.raf = 0; this.renderAll(); }); }
	// what the active filter hides: property filter (collection boards, from syncCollection) + tag filter (any board)
	computeHidden() {
		const out = new Set(this._propHidden || []); const fl = this.scene.settings && this.scene.settings.coll && this.scene.settings.coll.filter;
		if (fl && fl.kind === 'tag') for (const n of this.scene.nodes) { if (n.type === 'frame') continue; if (!(n.tags || []).includes(fl.tagId)) out.add(n.id); }
		return out;
	}
	// focus mode: the selection plus everything within N connections stays, the rest dims
	applyFocus() {
		const f = this.scene.settings && this.scene.settings.focus; const on = !!(f && f.on && this.selected.size);
		this.host.classList.toggle('wb-focus-on', on);
		if (!on) { for (const el of this.nodeEls.values()) el.classList.remove('wb-dim'); for (const g of this.host.querySelectorAll('g[data-id]')) g.classList.remove('wb-dim'); return; } // this.edgesLayer never existed (the layer is this.edges), so leaving focus mode left every edge dimmed at opacity .12
		const keep = new Set(this.selected); let frontier = [...this.selected];
		for (let d = 0; d < (f.depth || 1); d++) { const next = []; for (const e of this.scene.edges) { if (frontier.includes(e.from) && !keep.has(e.to)) { keep.add(e.to); next.push(e.to); } if (frontier.includes(e.to) && !keep.has(e.from)) { keep.add(e.from); next.push(e.from); } } frontier = next; if (!next.length) break; }
		for (const [id, el] of this.nodeEls) el.classList.toggle('wb-dim', !keep.has(id));
		for (const g of this.host.querySelectorAll('g[data-id]')) { const e = this.scene.edges.find((x) => x.id === g.getAttribute('data-id')); g.classList.toggle('wb-dim', !(e && keep.has(e.from) && keep.has(e.to))); }
	}
	renderAll() {
		if (this.destroyed) return;
		this._filterHidden = this.computeHidden();
		const seen = new Set();
		const guard = (what, fn) => { try { fn(); } catch (e) { console.error('[Whiteboard] render failed in ' + what, e); if (!this._renderErrToast || Date.now() - this._renderErrToast > 10000) { this._renderErrToast = Date.now(); this.plugin.toast('Whiteboard render error (' + what + '): ' + (e && e.message ? e.message : e)); } } };
		for (const n of this.scene.nodes) { seen.add(n.id); guard('node ' + n.type, () => this.renderNode(n)); }
		for (const [id, el] of this.nodeEls) if (!seen.has(id)) { el.remove(); this.nodeEls.delete(id); }
		for (const el of [...this.nodes.children]) { const id = el.dataset && el.dataset.id; if (!id || seen.has(id)) continue; if (this.nodeEls.get(id) === el) this.nodeEls.delete(id); if (el.contains(document.activeElement)) { try { document.activeElement.blur(); this.host.focus({ preventScroll: true }); } catch (e) {} } el.remove(); }
		guard('edges', () => this.renderEdges()); guard('overlay', () => this.renderOverlay()); guard('toolbar', () => this.buildCtx()); guard('focus', () => this.applyFocus()); guard('images', () => this.loadVisibleImages()); guard('minimap', () => this.drawMinimap());
	}
	renderNode(n) {
		let el = this.nodeEls.get(n.id);
		if (el && el.dataset.wbType && el.dataset.wbType !== n.type) { el.remove(); this.nodeEls.delete(n.id); el = null; }
		if (!el) {
			el = wbEl('div', 'wb-node'); el.dataset.id = n.id; el.dataset.wbType = n.type;
			if (n.type === 'sticky') { el.classList.add('wb-sticky'); el.appendChild(wbEl('div', 'wb-txt')); }
			else if (n.type === 'text') { el.classList.add('wb-text'); el.appendChild(wbEl('div', 'wb-txt')); }
			else if (n.type === 'shape') { el.classList.add('wb-shape'); const s = wbSvgEl('svg', { class: 'wb-shape-bg' }); s.appendChild(wbSvgEl('path', { 'vector-effect': 'non-scaling-stroke' })); s.appendChild(wbSvgEl('path', { class: 'wb-shape-hit', 'vector-effect': 'non-scaling-stroke' })); el.appendChild(s); el.appendChild(wbEl('div', 'wb-txt')); }
			else if (n.type === 'image') { el.classList.add('wb-image'); el.innerHTML = WB_I.image; el.dataset.lazy = '1'; }
			else if (n.type === 'frame') { el.classList.add('wb-frame'); el.appendChild(wbEl('div', 'wb-txt')); }
			else if (n.type === 'stack') { el.classList.add('wb-stack'); el.innerHTML = '<div class="wb-stack-title">Sticky Stack</div><div class="wb-stack-pile"><div class="wb-pad"><div class="wb-pad-edge"></div><div class="wb-pad-under"></div><div class="wb-pad-top"></div></div></div>'; }
			else if (n.type === 'board') { el.classList.add('wb-boardcard'); el.innerHTML = '<svg class="wb-bc-svg" viewBox="0 0 280 225" preserveAspectRatio="xMidYMid meet"><path class="wb-bc-back" d="M102.465 13C104.485 13 105.494 13 106.439 13.1835C108.212 13.5278 109.858 14.3456 111.203 15.5501C111.92 16.192 112.53 16.9968 113.75 18.6062C114.97 20.2157 115.58 21.0205 116.297 21.6624C117.642 22.8669 119.288 23.6847 121.061 24.029C122.006 24.2125 123.015 24.2125 125.035 24.2125H257.6C265.44 24.2125 269.361 24.213 272.355 25.6721C274.99 26.9556 277.131 29.0036 278.474 31.5226C279.999 34.3863 280 38.1353 280 45.6329V138.58C280 146.077 279.999 149.826 278.474 152.69C277.131 155.209 274.99 157.257 272.355 158.54C269.361 160 265.44 160 257.6 160H22.4004C14.5598 160 10.6393 160 7.64453 158.54C5.01026 157.257 2.86859 155.209 1.52637 152.69C0.000525117 149.826 0 146.077 0 138.58V28.4204C0 26.2523 0.125433 24.8848 0.304392 23.9712C0.555234 22.6907 0.680655 22.0504 1.0003 21.2259C1.23171 20.629 1.73526 19.6791 2.09939 19.1525C2.60239 18.4252 3.01624 18.0081 3.84395 17.1738C4.9335 16.0756 6.21665 15.1553 7.64453 14.4596C10.6393 13.0005 14.5598 13 22.4004 13H102.465Z"></path><path class="wb-bc-front" d="M0 67.9556C0 56.07 0 50.1272 1.52591 45.5875C2.86814 41.5943 5.00986 38.3477 7.64413 36.3131C10.6389 34 14.5593 34 22.4 34H257.6C265.441 34 269.361 34 272.356 36.3131C274.99 38.3477 277.132 41.5943 278.474 45.5875C280 50.1272 280 56.07 280 67.9556V191.044C280 202.93 280 208.873 278.474 213.412C277.132 217.406 274.99 220.652 272.356 222.687C269.361 225 265.441 225 257.6 225H22.4C14.5593 225 10.6389 225 7.64413 222.687C5.00986 220.652 2.86814 217.406 1.52591 213.412C0 208.873 0 202.93 0 191.044V67.9556Z"></path></svg><div class="wb-bc-body"><div class="wb-bc-head"><span class="wb-bc-icon"></span><span class="wb-bc-title">Sub-board</span></div><div class="wb-bc-sub"></div><div class="wb-bc-chips"></div></div>'; this.paintBoardCard(n, el); }
			// frames sit behind everything they contain
			if (n.type === 'frame') this.frames.insertBefore(el, this.frames.firstChild); else this.nodes.appendChild(el);
			this.nodeEls.set(n.id, el);
		}
		el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; el.style.width = n.w + 'px'; el.style.height = n.h + 'px';
		const txt = el.querySelector('.wb-txt');
		if (txt && this.editing !== n.id) { if (n.html) { if (txt.innerHTML !== n.html) txt.innerHTML = n.html; } else if (txt.innerText !== (n.text || '')) txt.innerText = n.text || ''; }
		if (txt) { txt.classList.toggle('wb-b', !!n.bold); txt.classList.toggle('wb-i', !!n.italic); txt.classList.toggle('wb-u', !!n.underline); txt.classList.toggle('wb-strike', !!n.strike); }
		if (n.type === 'sticky') {
			const c = wbStickyColor(n.color); el.style.backgroundColor = c.hex; el.style.color = c.fg || '#1c1c1e'; el.style.padding = wbStickyPad(n) + 'px';
			// every note gets its own shadow and curl, seeded by its id, so a wall of notes reads as paper, not tiles
			if (!el.dataset.wbPaper) { let h = 0; for (const ch of String(n.id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; const r1 = (h % 100) / 100, r2 = ((h >> 7) % 100) / 100, r3 = ((h >> 14) % 100) / 100; el.style.setProperty('--wb-sh-x', (3 + r3 * 5).toFixed(1) + 'px'); el.style.setProperty('--wb-sh-y', (5 + r1 * 5).toFixed(1) + 'px'); el.style.setProperty('--wb-sh-b', (12 + r2 * 8).toFixed(1) + 'px'); el.style.setProperty('--wb-sh-a', (0.10 + r3 * 0.06).toFixed(3)); el.style.setProperty('--wb-curl', (1.2 + r2 * 1.8).toFixed(2) + 'deg'); el.style.setProperty('--wb-curl-a', (0.12 + r1 * 0.08).toFixed(3)); el.dataset.wbPaper = '1'; }
			el.classList.toggle('wb-al-left', n.align === 'left'); el.classList.toggle('wb-al-right', n.align === 'right');
			this.fitSticky(n, el);
		} else if (n.type === 'text') {
			el.style.fontSize = (n.fontSize || 15) + 'px'; el.style.textAlign = n.align || 'left'; el.style.color = n.textColor || ''; el.style.background = n.bg || ''; el.classList.toggle('wb-hasbg', !!n.bg);
			el.classList.toggle('wb-empty', !(n.text || '').trim());
			if (this.editing !== n.id) { const want = Math.max(28, txt.scrollHeight + 8); if (Math.abs(want - n.h) > 1) { n.h = want; el.style.height = want + 'px'; } }
		} else if (n.type === 'stack') {
			if (n.size && n.size !== 'custom' && WB_STACK_SIZES[n.size] && wbStackSizeKey(n) !== n.size) { n.w = wbStackWidthFor(WB_STACK_SIZES[n.size]); el.style.width = n.w + 'px'; this.scheduleSave(); }
			const g = wbStackGeom(n); if (Math.abs(n.h - g.h) > 1) { n.h = g.h; el.style.height = n.h + 'px'; this.scheduleSave(); }
			el.style.setProperty('--wb-stack-th', g.th.toFixed(1) + 'px'); el.style.setProperty('--wb-stack-pad', g.pad.toFixed(1) + 'px');
			el.style.setProperty('--wb-stack-color', wbStickyColor(n.color || 'yellow').hex); el.style.setProperty('--wb-stack-fs', Math.max(7, Math.min(18, n.w / 12)).toFixed(1) + 'px');
		} else if (n.type === 'board') {
			if (Math.abs(n.h - n.w / WB_FOLDER_AR) > 1) { n.h = Math.round(n.w / WB_FOLDER_AR); el.style.height = n.h + 'px'; this.scheduleSave(); } // the folder drawing has fixed proportions; older cards had free ones
			const bic = el.querySelector('.wb-bc-icon'); if (bic) { const want = n.icon ? '<span class="ti ' + wbEsc(n.icon) + '"></span>' : WB_I.subboard; if (bic.innerHTML !== want) bic.innerHTML = want; }
			el.style.setProperty('--wb-bc-fs', Math.max(7, Math.min(22, n.w / 17)).toFixed(1) + 'px'); // text follows the card's size
			if (n.color) { const fc = wbStickyColor(n.color); el.style.setProperty('--wb-folder', fc.hex); el.style.setProperty('--wb-folder-fg', fc.fg || wbContrastText(fc.hex) || '#1c1c1e'); } else { el.style.removeProperty('--wb-folder'); el.style.removeProperty('--wb-folder-fg'); }
		} else if (n.type === 'frame') {
			const fc = wbStickyColor(n.color || 'white'); el.style.setProperty('--wb-frame-fill', fc.hex); el.style.setProperty('--wb-frame-fg', fc.fg || wbContrastText(fc.hex) || '#1c1c1e');
			if (txt && this.editing !== n.id && !(n.text || '').trim()) txt.innerText = 'Frame';
		} else if (n.type === 'shape') {
			const p = el.querySelector('path'); p.setAttribute('d', wbShapePath(n.shape || 'rect', n.w, n.h));
			// No fill = a frame drawn around other things (his ask 2026-09-26): the inside lets clicks through to what lies under it,
			// the shape itself is grabbed on its outline (a 14 px invisible band) or on its text.
			const hit = el.querySelector('.wb-shape-hit'); if (hit) hit.setAttribute('d', p.getAttribute('d')); el.classList.toggle('wb-hollow', !n.fill || n.fill === 'none');
			// his ruling 2026-09-26: an unfilled shape has no tone at all (the 10 % accent tint is gone); the outline always draws
			p.setAttribute('fill', n.fill && n.fill !== 'none' ? n.fill : 'none'); p.setAttribute('stroke', n.stroke || 'var(--wb-accent)'); p.setAttribute('stroke-width', n.strokeWidth || 1.5);
			el.style.fontSize = (n.fontSize || 15) + 'px'; el.style.textAlign = n.align || 'center';
			el.style.color = n.textColor || ((n.fill && n.fill !== 'none') ? (wbContrastText(n.fill) || '') : '');
		}
	}
	fitSticky(n, el) {
		const txt = el.querySelector('.wb-txt'); if (!txt) return;
		// The fit is a binary search with two layout reads per step, so 219 post-its cost 495 ms per renderAll (measured on his
		// board 2026-09-22), and renderAll runs on every grab and drop. Nothing the fit depends on changes between most renders:
		// the result is kept on the element under a key of everything it reads, and a matching key skips the search entirely.
		const tagRow = el.querySelector('.wb-tagrow'); const tagH = tagRow ? tagRow.offsetHeight + Math.round(n.w * 0.06) : 0;
		const key = (n.html || n.text || '') + '|' + n.w + '|' + n.h + '|' + (n.fontSize || 'auto') + '|' + tagH + '|' + (n.bold ? 1 : 0) + (n.italic ? 1 : 0) + (n.underline ? 1 : 0) + (n.strike ? 1 : 0) + '|' + (n.align || '') + '|' + (this.drag && this.drag.kind === 'resize' ? 'r' : '');
		if (el.dataset.wbFit === key) return; el.dataset.wbFit = key;
		const pad2 = wbStickyPad(n) * 2; const maxH = n.h - pad2 - tagH, maxW = n.w - pad2;
		const fixed = n.fontSize && n.fontSize !== 'auto' ? Number(n.fontSize) : 0;
		// a chosen size is a ceiling: it scales with the note on resize, and when it still does not fit the text shrinks to fit rather than being cut
		if (fixed) { txt.style.fontSize = fixed + 'px'; if (txt.scrollHeight <= maxH + 1 && txt.scrollWidth <= maxW + 1) return; }
		let lo = 4, hi = fixed ? Math.max(5, fixed) : Math.max(12, Math.min(48, Math.round(n.h / 3.2)));
		// binary search the largest size that fits
		while (hi - lo > 1) { const mid = Math.round((lo + hi) / 2); txt.style.fontSize = mid + 'px'; if (txt.scrollHeight <= maxH + 1 && txt.scrollWidth <= maxW + 1) lo = mid; else hi = mid; }
		txt.style.fontSize = lo + 'px';
		// text never disappears: if it does not fit even at the smallest size, the note grows in height to hold it (not mid-resize, that would fight the drag)
		if (txt.scrollHeight > maxH + 1 && !(this.drag && this.drag.kind === 'resize')) { const want = txt.scrollHeight + pad2 + tagH; if (want > n.h) { n.h = want; el.style.height = want + 'px'; this.scheduleSave(); } }
	}
	// images load when they come into view (with a margin), never all at once on open
	loadVisibleImages() {
		if (this.destroyed) return; const z = this.cam.z || 1; const r = this.canvas.getBoundingClientRect(); const m = 400 / z;
		const vx = -this.cam.x / z - m, vy = -this.cam.y / z - m, vX = vx + r.width / z + 2 * m, vY = vy + r.height / z + 2 * m;
		for (const n of this.scene.nodes) { if (n.type !== 'image') continue; const el = this.nodeEls.get(n.id); if (!el || !el.dataset.lazy) continue; if (n.x < vX && n.x + n.w > vx && n.y < vY && n.y + n.h > vy) { delete el.dataset.lazy; this.loadImage(n, el); } }
	}
	async loadImage(n, el) {
		if (!n.blobGuid) return;
		let url = this.imgUrls.get(n.blobGuid);
		if (!url) { url = await this.plugin.blobUrl(n.blobGuid, n.name); if (!url || this.destroyed) return; this.imgUrls.set(n.blobGuid, url); }
		const img = document.createElement('img'); img.src = url; img.draggable = false; el.innerHTML = ''; el.appendChild(img);
	}
	edgeGeom(e) {
		const a = this.nodeById(e.from), b = this.nodeById(e.to); if (!a || !b) return null;
		if (e.points && e.points.length) {
			// routed by hand: the ends aim at the first and last waypoint, the middle follows them exactly
			const s0 = e.fromSide || wbSideToward(a, e.points[0]), s1 = e.toSide || wbSideToward(b, e.points[e.points.length - 1]);
			const q0 = wbSidePoint(a, s0), q1 = wbSidePoint(b, s1); const pts = [q0].concat(e.points.map((p) => ({ x: p.x, y: p.y })), [q1]);
			const last = pts[pts.length - 2], first = pts[1]; const mid = e.points[Math.floor((e.points.length - 1) / 2)];
			const n0 = WB_NORMAL[s0], n1 = WB_NORMAL[s1];
			// the arrowhead follows the way the curve actually arrives: along the side normal when it is smooth, along the last segment otherwise
			const dEnd = (e.route || 'curved') === 'curved' ? [-n1[0], -n1[1]] : [q1.x - last.x, q1.y - last.y];
			const dStart = (e.route || 'curved') === 'curved' ? [-n0[0], -n0[1]] : [q0.x - first.x, q0.y - first.y];
			return { d: wbWayPath(pts, e.route || 'curved', n0, n1), dirEnd: dEnd, dirStart: dStart, mid: { x: mid.x, y: mid.y }, s0, s1 };
		}
		let s0 = e.fromSide, s1 = e.toSide; if (!s0 || !s1) { const auto = wbAutoSides(a, b); s0 = s0 || auto[0]; s1 = s1 || auto[1]; }
		const size = 6 + (e.width || 1.5) * 1.2; // arrowhead length (kept in step with renderEdges)
		return Object.assign(wbEdgePath(wbSidePoint(a, s0), s0, wbSidePoint(b, s1), s1, e.route || 'curved', e.startArrow ? size - 0.5 : 0, e.endArrow === false ? 0 : size - 0.5), { s0, s1 });
	}
	renderEdges(only) {
		const seen = new Set();
		for (const e of this.scene.edges) {
			if (only && !only.has(e.from) && !only.has(e.to) && this.edgeEls.has(e.id)) { seen.add(e.id); continue; } // untouched by the drag: its path is still right
			const g = this.edgeGeom(e); if (!g) continue; seen.add(e.id);
			let ent = this.edgeEls.get(e.id);
			if (!ent) {
				const grp = wbSvgEl('g', { 'data-id': e.id });
				const hit = wbSvgEl('path', { class: 'wb-hit' }); const line = wbSvgEl('path', { class: 'wb-line' }); const h0 = wbSvgEl('path', { class: 'wb-head' }); const h1 = wbSvgEl('path', { class: 'wb-head' });
				grp.appendChild(hit); grp.appendChild(line); grp.appendChild(h0); grp.appendChild(h1); this.edges.appendChild(grp);
				const label = wbEl('div', 'wb-elabel'); label.dataset.edge = e.id; this.nodes.appendChild(label);
				ent = { grp, hit, line, h0, h1, label }; this.edgeEls.set(e.id, ent);
			}
			const color = e.color || 'var(--wb-edge)'; const w = e.width || 1.5;
			ent.hit.setAttribute('d', g.d); ent.line.setAttribute('d', g.d); ent.line.setAttribute('stroke', color); ent.line.setAttribute('stroke-width', w);
			ent.line.setAttribute('stroke-dasharray', e.dash === 'dashed' ? (w * 5) + ' ' + (w * 4) : e.dash === 'dotted' ? '0.1 ' + (w * 3) : ''); ent.line.setAttribute('stroke-linecap', e.dash === 'dotted' ? 'round' : 'butt');
			const size = 6 + w * 1.2; // arrowhead length; 0.5.17: a quarter smaller
			ent.h1.setAttribute('d', e.endArrow === false ? '' : wbArrowHead(wbSidePoint(this.nodeById(e.to), g.s1), g.dirEnd, size)); ent.h1.setAttribute('fill', color);
			ent.h0.setAttribute('d', e.startArrow ? wbArrowHead(wbSidePoint(this.nodeById(e.from), g.s0), g.dirStart, size) : ''); ent.h0.setAttribute('fill', color);
			ent.grp.classList.toggle('wb-sel', this.selectedEdge === e.id);
			ent.label.style.left = g.mid.x + 'px'; ent.label.style.top = g.mid.y + 'px';
			if (ent.label.getAttribute('contenteditable') !== 'true') ent.label.textContent = e.label || '';
			const ls = ent.label.style; ls.fontSize = (e.labelSize || 11) + 'px'; ls.height = e.labelSize ? 'auto' : ''; ls.padding = e.labelSize ? '2px 6px' : ''; ls.color = e.labelColor || '';
			if (e.labelBg === 'none') { ls.background = 'transparent'; ls.borderColor = 'transparent'; } else if (e.labelBg && wbHexLum(e.labelBg) != null) { ls.background = e.labelBg; ls.borderColor = e.labelBg; if (!e.labelColor) ls.color = wbContrastText(e.labelBg); } else { ls.background = ''; ls.borderColor = ''; }
		}
		for (const [id, ent] of this.edgeEls) if (!seen.has(id)) { ent.grp.remove(); ent.label.remove(); this.edgeEls.delete(id); }
	}
	renderOverlay() {
		const ov = this.overlay; ov.innerHTML = '';
		const sel = [...this.selected].map((id) => this.nodeById(id)).filter(Boolean);
		if (this.hover && !this.selected.has(this.hover) && !this.drag) { const n = this.nodeById(this.hover); if (n) { const b = this.boxEl(n, 'wb-selbox wb-hover'); ov.appendChild(b); } }
		for (const n of sel) ov.appendChild(this.boxEl(n, 'wb-selbox'));
		if (sel.length === 1 && this.editing !== sel[0].id) {
			const n = sel[0]; const p = this.toScreen(n.x, n.y); const w = n.w * this.cam.z, h = n.h * this.cam.z;
			if (!n.locked) for (const [k, dx, dy] of [['nw', 0, 0], ['ne', 1, 0], ['sw', 0, 1], ['se', 1, 1]]) { const hd = wbEl('div', 'wb-handle ' + k); hd.dataset.handle = k; hd.style.left = (p.x + w * dx) + 'px'; hd.style.top = (p.y + h * dy) + 'px'; ov.appendChild(hd); }
			if (n.type === 'text' || n.type === 'mind') for (const [k, dx, dy] of [['e', 1, 0.5], ['w', 0, 0.5]]) { const hd = wbEl('div', 'wb-handle ' + k); hd.dataset.handle = k; hd.style.left = (p.x + w * dx) + 'px'; hd.style.top = (p.y + h * dy) + 'px'; ov.appendChild(hd); }
			for (const [side, dx, dy] of [['top', 0.5, 0], ['right', 1, 0.5], ['bottom', 0.5, 1], ['left', 0, 0.5]]) { const d = wbEl('div', 'wb-dot'); d.dataset.side = side; d.style.left = (p.x + w * dx + (dx - 0.5) * 24) + 'px'; d.style.top = (p.y + h * dy + (dy - 0.5) * 24) + 'px'; ov.appendChild(d); }
		} else if (sel.length > 1) {
			const bb = wbBBox(sel); const b = this.boxEl(bb, 'wb-selbox'); b.style.borderStyle = 'dashed'; ov.appendChild(b);
			const p = this.toScreen(bb.x, bb.y); const w = bb.w * this.cam.z, h = bb.h * this.cam.z;
			for (const [k, dx, dy] of [['nw', 0, 0], ['ne', 1, 0], ['sw', 0, 1], ['se', 1, 1]]) { const hd = wbEl('div', 'wb-handle ' + k); hd.dataset.handle = k; hd.dataset.group = '1'; hd.style.left = (p.x + w * dx) + 'px'; hd.style.top = (p.y + h * dy) + 'px'; ov.appendChild(hd); }
		}
		if (this.drag && this.drag.kind === 'marquee') { const m = wbEl('div', 'wb-marquee'); const r = this.drag.rect; m.style.left = r.x + 'px'; m.style.top = r.y + 'px'; m.style.width = r.w + 'px'; m.style.height = r.h + 'px'; ov.appendChild(m); }
		// hovering a side dot previews the note a click would add: a straight line out of the dot and a ghost of the note
		if (!this.drag && this.hoverDot && sel.length === 1 && wbSpawnable(sel[0])) { const src = sel[0]; const at = this.spawnPos(src, this.hoverDot); const a = this.toScreen(wbSidePoint(src, this.hoverDot).x, wbSidePoint(src, this.hoverDot).y); const bp = wbSidePoint(Object.assign({}, src, at), wbOppositeSide(this.hoverDot)); const b = this.toScreen(bp.x, bp.y); const g = wbSvgEl('svg', { class: 'wb-edges', style: 'position:absolute;left:0;top:0;overflow:visible;width:1px;height:1px;pointer-events:none' }); g.appendChild(wbSvgEl('path', { d: 'M' + a.x + ' ' + a.y + ' L' + b.x + ' ' + b.y, stroke: 'var(--wb-accent)', 'stroke-width': 1.5, fill: 'none', 'stroke-dasharray': '4 4' })); ov.appendChild(g); const gp = this.toScreen(at.x, at.y); const ghost = wbEl('div', 'wb-ghost'); ghost.style.left = gp.x + 'px'; ghost.style.top = gp.y + 'px'; ghost.style.width = (src.w * this.cam.z) + 'px'; ghost.style.height = (src.h * this.cam.z) + 'px'; if (src.type === 'sticky') ghost.style.background = wbStickyColor(src.color).hex; ov.appendChild(ghost); }
		if (!this.drag && this.pendingSpawn) { const ps = this.pendingSpawn; const from = ps.side ? wbSidePoint(ps.src, ps.side) : wbCenter(ps.src); const s = this.toScreen(from.x, from.y); const t = this.toScreen(ps.x, ps.y); const g = wbSvgEl('svg', { class: 'wb-edges', style: 'position:absolute;left:0;top:0;overflow:visible;width:1px;height:1px' }); g.appendChild(wbSvgEl('path', { d: 'M' + s.x + ' ' + s.y + ' L' + t.x + ' ' + t.y, stroke: 'var(--wb-accent)', 'stroke-width': 1.5, fill: 'none', 'stroke-dasharray': '4 4' })); g.appendChild(wbSvgEl('circle', { cx: t.x, cy: t.y, r: 4, fill: 'var(--wb-accent)' })); ov.appendChild(g); }
		if (this.drag && this.drag.kind === 'connect') { const s = this.toScreen(this.drag.from.x, this.drag.from.y); const g = wbSvgEl('svg', { class: 'wb-edges', style: 'position:absolute;left:0;top:0;overflow:visible;width:1px;height:1px' }); const l = wbSvgEl('path', { d: 'M' + s.x + ' ' + s.y + ' L' + this.drag.cur.x + ' ' + this.drag.cur.y, stroke: 'var(--wb-accent)', 'stroke-width': 1.5, fill: 'none', 'stroke-dasharray': '4 4' }); g.appendChild(l); ov.appendChild(g); }
		if (this.selectedEdge && !this.drag) {
			const e2 = this.scene.edges.find((x) => x.id === this.selectedEdge); const g2 = e2 && this.edgeGeom(e2);
			if (e2 && g2) {
				const a = this.nodeById(e2.from), b = this.nodeById(e2.to);
				const pts = [wbSidePoint(a, g2.s0)].concat((e2.points || []).map((q) => ({ x: q.x, y: q.y })), [wbSidePoint(b, g2.s1)]);
				(e2.points || []).forEach((q, i) => { const sp = this.toScreen(q.x, q.y); const h = wbEl('div', 'wb-epoint'); h.dataset.epoint = String(i); h.title = 'Drag to move this bend, double-click to remove it'; h.style.left = sp.x + 'px'; h.style.top = sp.y + 'px'; ov.appendChild(h); });
				for (let i = 0; i < pts.length - 1; i++) { if (Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y) * this.cam.z < 46) continue; const m = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 }; const sp = this.toScreen(m.x, m.y); const h = wbEl('div', 'wb-eadd'); h.dataset.eadd = String(i); h.title = 'Drag to bend the line around something'; h.style.left = sp.x + 'px'; h.style.top = sp.y + 'px'; ov.appendChild(h); }
			}
		}
		if (this.drag && this.drag.guides) for (const gd of this.drag.guides) { const l = wbEl('div', 'wb-guide'); if (gd.v != null) { const s = this.toScreen(gd.v, 0); l.style.left = s.x + 'px'; l.style.top = '0'; l.style.width = '1px'; l.style.bottom = '0'; } else { const s = this.toScreen(0, gd.h); l.style.top = s.y + 'px'; l.style.left = '0'; l.style.height = '1px'; l.style.right = '0'; } ov.appendChild(l); }
	}
	boxEl(n, cls) { const b = wbEl('div', cls); const p = this.toScreen(n.x, n.y); b.style.left = (p.x - 1) + 'px'; b.style.top = (p.y - 1) + 'px'; b.style.width = (n.w * this.cam.z + 2) + 'px'; b.style.height = (n.h * this.cam.z + 2) + 'px'; return b; }

	// --- input -----------------------------------------------------------------
	bindInput() {
		const cv = this.canvas, h = this.host;
		const on = (el, ev, fn, opts) => { const h = (x) => { if (WB_GEN !== window.__wbGen) return; fn(x); }; el.addEventListener(ev, h, opts); const off = () => el.removeEventListener(ev, h, opts); this.disposers.push(off); if (el === document || el === window) WB_LISTENERS.push(off); };
		on(cv, 'pointerdown', (e) => this.onDown(e));
		on(cv, 'pointermove', (e) => this.onMove(e));
		on(cv, 'pointerup', (e) => this.onUp(e));
		on(cv, 'pointercancel', (e) => this.onUp(e, true));
		on(cv, 'dblclick', (e) => this.onDbl(e));
		on(cv, 'wheel', (e) => this.onWheel(e), { passive: false });
		// Thymer moves focus to <body> after every mousedown, so keys are taken at document level
		// whenever this board's panel is the focused one (or the event starts inside the host).
		const mine = (e) => this.host.contains(e.target) || ((e.target === document.body || e.target === document.documentElement) && this.isActivePanel());
		on(document, 'keydown', (e) => { if (mine(e)) this.onKey(e); }, true);
		on(document, 'keyup', (e) => { if (mine(e) && e.code === 'Space') { this.space = false; cv.classList.remove('wb-space'); } }, true);
		on(document, 'visibilitychange', () => { if (document.visibilityState === 'hidden') this.flush(); }); on(window, 'pagehide', () => this.flush()); on(window, 'beforeunload', () => this.flush());
		on(document, 'paste', (e) => { if (mine(e)) this.onPaste(e); }, true);
		on(cv, 'dragenter', (e) => { if (e.dataTransfer && [...(e.dataTransfer.items || [])].some((it) => it.kind === 'file')) e.preventDefault(); });
		on(cv, 'dragover', (e) => { if (e.dataTransfer && [...(e.dataTransfer.items || [])].some((it) => it.kind === 'file')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
		const onDrop = (e) => { if (!cv.contains(e.target)) return; const files = e.dataTransfer && e.dataTransfer.files; if (!files || !files.length) return; e.preventDefault(); e.stopPropagation(); const w = this.toWorld(this.localPt(e).x, this.localPt(e).y); let i = 0; for (const f of files) if (/^image\//.test(f.type)) this.addImageFile(f, w.x + i++ * 24, w.y + i * 24); };
		const onDragOver = (e) => { if (!cv.contains(e.target)) return; if (e.dataTransfer && [...(e.dataTransfer.items || [])].some((it) => it.kind === 'file')) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; } };
		on(window, 'drop', onDrop, true); on(window, 'dragover', onDragOver, true); on(window, 'dragenter', onDragOver, true);
		// pointerdown outside the host commits an edit and drops the context toolbar focus
		const outside = (e) => { if (!this.host.contains(e.target) && this.editing) this.commitEdit(); if (this.nativeEdit && !this.host.contains(e.target) && !(e.target.closest && e.target.closest('.prop-edit-field, .cmdpal--inline, .autocomplete, .datepicker, .dropdown-menu, .popup'))) this.endNativeEdit(true); };
		document.addEventListener('pointerdown', outside, true); this.disposers.push(() => document.removeEventListener('pointerdown', outside, true));
		const themeObs = new MutationObserver(() => this.applyTheme()); themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] }); this.disposers.push(() => themeObs.disconnect());
		const ro = new ResizeObserver(() => { this.renderOverlay(); this.placeCtx(); }); ro.observe(cv); this.disposers.push(() => ro.disconnect());
	}
	isActivePanel() { const p = this.host.closest('.panel'); if (p) return p.classList.contains('focused-panel') || p.classList.contains('has-focus'); try { return this.panel.isActive(); } catch (e) { return false; } }
	hitAt(e) { const el = document.elementFromPoint(e.clientX, e.clientY); const n = el && el.closest ? el.closest('.wb-node') : null; return n ? this.nodeById(n.dataset.id) : null; }
	// a relation dropped inside a frame's body counts as a drop on empty canvas (the frame is a target only along its border)
	connectTarget(e) { const hit = this.hitAt(e); if (!hit || hit.type !== 'frame') return hit; const w = this.toWorld(this.localPt(e).x, this.localPt(e).y); const m = 14 / this.cam.z; return (w.x > hit.x + m && w.x < hit.x + hit.w - m && w.y > hit.y + m && w.y < hit.y + hit.h - m) ? null : hit; }
	hitNode(e) { const el = e.target && e.target.closest ? e.target.closest('.wb-node') : null; return el ? this.nodeById(el.dataset.id) : null; }
	onDown(e) {
		if (e.button === 2) return;
		this.plugin.closeMenus();
		const t = e.target; const pt = this.localPt(e);
		if (this.nativeEdit) { if (t.closest && t.closest('.prop-edit-field, .cmdpal--inline, .autocomplete, .datepicker, .dropdown-menu, .popup')) return; this.endNativeEdit(true); }
		if (t.closest && (t.closest('.wb-ctx') || t.closest('.wb-rail') || t.closest('.wb-zoom'))) return;
		// clicking inside the text being edited: let the browser handle caret placement
		if (this.editing && t.closest && t.closest('.wb-node') && t.closest('.wb-node').dataset.id === this.editing) return;
		if (this.editing && t.classList && t.classList.contains('wb-elabel') && t.getAttribute('contenteditable') === 'true') return;
		this.commitEdit();
		this.host.focus({ preventScroll: true });
		setTimeout(() => { if (!this.destroyed && !this.editing && document.activeElement === document.body) this.host.focus({ preventScroll: true }); }, 0);
		e.preventDefault();
		if (e.button === 1 || this.space) { this.startDrag(e, { kind: 'pan', cx: this.cam.x, cy: this.cam.y }); this.canvas.classList.add('wb-panning'); return; }
		const handle = t.dataset && t.dataset.handle; const side = t.dataset && t.dataset.side;
		if (handle && this.selected.size > 1) { const items = [...this.selected].map((id) => this.nodeById(id)).filter((n) => n && !n.locked); if (!items.length) return; const bb = wbBBox(items); this.pushHistory(); const mmRoots = [...new Set(items.filter((n) => this.mmIsTree && this.mmIsTree(n.id)).map((n) => this.mmRootOf(n.id).id))].map((id) => { const r = this.nodeById(id); return { id, s0: (r && r.mm && r.mm.scale) || 1 }; }); this.startDrag(e, { kind: 'gresize', handle, items, mmRoots, orig: items.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h, fontSize: n.fontSize })), bb }); return; }
		if (handle && this.selected.size === 1) { const n = this.nodeById([...this.selected][0]); if (n && n.locked) return; this.pushHistory(); const rootMM = this.mmIsTree && this.mmIsTree(n.id) ? this.mmRootOf(n.id).mm : null; this.startDrag(e, { kind: 'resize', handle, n, o: Object.assign({}, n), scale0: (rootMM && rootMM.scale) || 1, aspect: (n.type === 'image' || n.type === 'sticky' || n.type === 'card' || n.type === 'line' || n.type === 'board' || n.type === 'stack' || e.shiftKey) ? n.w / n.h : 0 }); return; }
		if (side && this.selected.size === 1) { const n = this.nodeById([...this.selected][0]); this.startDrag(e, { kind: 'connect', src: n, side, from: wbSidePoint(n, side), cur: pt }); return; }
		const ep = t.dataset && t.dataset.epoint, ea = t.dataset && t.dataset.eadd;
		if ((ep != null || ea != null) && this.selectedEdge) {
			const ed = this.scene.edges.find((x) => x.id === this.selectedEdge);
			if (ed) {
				this.pushHistory(); const w0 = this.toWorld(pt.x, pt.y);
				let i;
				if (ep != null) i = Number(ep);
				else { ed.points = ed.points || []; i = Number(ea); ed.points.splice(i, 0, { x: Math.round(w0.x), y: Math.round(w0.y) }); }
				this.startDrag(e, { kind: 'edgept', edge: ed, i });
				this.renderEdges(); this.renderOverlay(); return;
			}
		}
		const edgeEl = t.closest ? t.closest('g[data-id]') : null;
		if (edgeEl && this.tool === 'select' && !e.shiftKey) { this.selected.clear(); this.selectedEdge = edgeEl.getAttribute('data-id'); this.renderAll(); return; } // with shift held a press on a relation starts a marquee instead (relations run through frames, so a shift-drag often begins on one)
		if (t.classList && t.classList.contains('wb-elabel')) { this.editLabel(t.dataset.edge); return; }
		const w = this.toWorld(pt.x, pt.y); const hit = this.hitNode(e);
		if (this.tool === 'shape') { this.startDrag(e, { kind: 'newshape', w0: w }); return; } // drag out its size (his ask 2026-09-26); a click in onUp drops the default size
		if (this.tool === 'sticky' || this.tool === 'text' || this.tool === 'shape') { if (!hit || this.tool !== 'text' || hit.type === 'frame') { this.createAt(this.tool, w); return; } }
		if (this.tool === 'frame') { this.startDrag(e, { kind: 'newframe', w0: w }); return; }
		if (this.tool === 'stack') { this.pushHistory(); const snap = !!(this.scene.settings && this.scene.settings.snap); const sw = wbStackWidthFor(WB_STACK_SIZES.m); const st = wbNode('stack', wbSnap(w.x - sw / 2, snap), wbSnap(w.y - sw * 0.6, snap), sw, sw, { color: this.stickyColor, size: 'm', shape: this.stickyWide ? 'wide' : 'square', tags: [] }); st.h = wbStackGeom(st).h; this.scene.nodes.push(st); this.selected = new Set([st.id]); this.selectedEdge = null; this.setTool('select'); this.renderAll(); this.scheduleSave(); return; }
		const onEmpty = !hit || hit.type === 'frame'; // a frame counts as free space for every creating tool
		if (this.tool === 'card') { if (onEmpty) { this.openCardPicker(w.x, w.y, { x: e.clientX, y: e.clientY }); } return; }
		if (this.tool === 'mind') { if (onEmpty) this.createMindAt(w); return; }
		if (this.tool === 'note') { if (onEmpty && this.notePick) this.notePick(w, { x: e.clientX, y: e.clientY }); return; } // his ask 2026-09-27: a new card, or one showing an existing page
		if (this.tool === 'connect') { if (hit) { this.startDrag(e, { kind: 'connect', src: hit, side: null, from: wbCenter(hit), cur: pt }); } return; }
		// select tool
		if (hit && hit.type === 'stack' && !hit.locked && !(t.closest && t.closest('.wb-stack-title'))) {
			// pull a fresh note off the stack: same colour, size and tags, dragged from the pointer
			this.startDrag(e, { kind: 'pull', stack: hit }); return; // the note appears in onMove, once this is a drag and not a click
		}
		if (hit && hit.type === 'frame' && e.shiftKey && !(t.closest && t.closest('.wb-txt'))) {
			// shift-drag inside a frame draws a marquee over its content (a plain drag would move the frame)
			this.selectedEdge = null; this.startDrag(e, { kind: 'marquee', rect: { x: pt.x, y: pt.y, w: 0, h: 0 }, add: new Set(this.selected), toggle: hit.id }); this.renderOverlay(); return;
		}
		if (hit) {
			this.selectedEdge = null;
			if (e.shiftKey) { if (this.selected.has(hit.id)) this.selected.delete(hit.id); else this.selected.add(hit.id); }
			else if (!this.selected.has(hit.id)) { this.selected.clear(); this.selected.add(hit.id); }
			let moving = [...this.selected].map((id) => this.nodeById(id)).filter((n) => n && !n.locked);
			for (const f of moving.filter((n) => n.type === 'frame')) for (const k of this.frameChildren(f)) if (!moving.includes(k)) moving.push(k); // a locked element on a frame is locked TO the frame: it travels with it
			const primary = moving.length === 1 && hit ? hit.id : null; // the node under the pointer, before a branch is expanded around it
			if (this.mmExpandBranch) moving = this.mmExpandBranch(moving); // a mind-map branch moves with its children
			if (moving.length) this.startDrag(e, { kind: 'move', items: moving, orig: moving.map((n) => ({ x: n.x, y: n.y })), moved: false, alt: e.altKey, primary });
			this.renderAll();
		} else {
			if (!e.shiftKey) { this.selected.clear(); this.selectedEdge = null; }
			this.startDrag(e, { kind: 'marquee', rect: { x: pt.x, y: pt.y, w: 0, h: 0 }, add: e.shiftKey ? new Set(this.selected) : new Set() });
			this.renderAll();
		}
	}
	startDrag(e, d) { d.sx = e.clientX; d.sy = e.clientY; d.pid = e.pointerId; d.started = false; this.drag = d; try { this.canvas.setPointerCapture(e.pointerId); } catch (x) {} }
	onMove(e) {
		const d = this.drag; const pt = this.localPt(e);
		if (!d) { const cr = this.canvas.getBoundingClientRect(); const wpt = this.toWorld(pt.x, pt.y); this.lastPointer = { x: wpt.x, y: wpt.y, inside: e.clientX >= cr.left && e.clientX <= cr.right && e.clientY >= cr.top && e.clientY <= cr.bottom }; const hit = this.hitNode(e); const id = hit ? hit.id : null; const t = e.target; const dot = (t && t.classList && t.classList.contains('wb-dot')) ? t.dataset.side : null; if (id !== this.hover || dot !== this.hoverDot) { this.hover = id; this.hoverDot = dot; this.renderOverlay(); } return; }
		const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
		if (!d.started && Math.hypot(dx, dy) < 3 && d.kind !== 'pan') return;
		d.started = true;
		if (d.kind === 'edgept') {
			const w = this.toWorld(pt.x, pt.y); const snap = !!(this.scene.settings && this.scene.settings.snap) && !e.metaKey;
			d.edge.points[d.i] = { x: Math.round(wbSnap(w.x, snap)), y: Math.round(wbSnap(w.y, snap)) };
			this.renderEdges(); this.renderOverlay(); return;
		}
		if (d.kind === 'pull') {
			// first real movement on a stack: peel a note off it, from the pointer, and carry on as a move
			const st = d.stack, g = wbStackGeom(st), w0 = this.toWorld(pt.x, pt.y); this.pushHistory();
			const fresh = { id: wbUid(), type: 'sticky', x: Math.round(w0.x - g.nw / 2), y: Math.round(w0.y - g.nh / 2), w: g.nw, h: g.nh, text: '', color: st.color || 'yellow', fontSize: 'auto', tags: (st.tags || []).slice() };
			this.scene.nodes.push(fresh); this.selected = new Set([fresh.id]); this.selectedEdge = null;
			Object.assign(d, { kind: 'move', items: [fresh], orig: [{ x: fresh.x, y: fresh.y }], moved: true, alt: false, pulled: true, sx: e.clientX, sy: e.clientY }); this.renderAll();
			
			return;
		}
		const snap = !!(this.scene.settings && this.scene.settings.snap) && !e.metaKey;
		if (d.kind === 'pan') { this.cam.x = d.cx + dx; this.cam.y = d.cy + dy; this.applyCamera(); return; }
		if (d.kind === 'move') {
			if (d.alt && !d.duped) { d.duped = true; this.pushHistory(); const copies = this.duplicateNodes(d.items, 0, 0); d.items = copies; d.orig = copies.map((n) => ({ x: n.x, y: n.y })); this.selected = new Set(copies.map((n) => n.id)); }
			else if (!d.moved) { this.pushHistory(); }
			d.moved = true;
			const wx = dx / this.cam.z, wy = dy / this.cam.z;
			// one snapped delta for the whole selection, so a frame's content (and any multi-selection) keeps its arrangement
			const sdx = wbSnap(d.orig[0].x + wx, snap) - d.orig[0].x, sdy = wbSnap(d.orig[0].y + wy, snap) - d.orig[0].y;
			d.items.forEach((n, i) => { n.x = d.orig[i].x + sdx; n.y = d.orig[i].y + sdy; });
			d.guides = this.smartGuides(d.items);
			this.renderNodesFast(d.items); this.dragFrame(d.items); return;
		}
		if (d.kind === 'resize') {
			const n = d.n, o = d.o; const wx = dx / this.cam.z, wy = dy / this.cam.z; const min = 24; if (n.type === 'frame' && n.format && n.format !== 'custom') n.format = 'custom';
			let x = o.x, y = o.y, w = o.w, hh = o.h; const hd = d.handle;
			if (hd.includes('e')) w = Math.max(min, o.w + wx); if (hd.includes('s')) hh = Math.max(min, o.h + wy);
			if (hd.includes('w')) { w = Math.max(min, o.w - wx); x = o.x + o.w - w; } if (hd.includes('n')) { hh = Math.max(min, o.h - wy); y = o.y + o.h - hh; }
			if (d.aspect) { if (hd === 'e' || hd === 'w') hh = w / d.aspect; else if (Math.abs(wx) > Math.abs(wy)) hh = w / d.aspect; else w = hh * d.aspect; if (hd.includes('n')) y = o.y + o.h - hh; if (hd.includes('w')) x = o.x + o.w - w; }
			n.x = wbSnap(x, snap); n.y = wbSnap(y, snap); n.w = Math.max(min, wbSnap(w, snap)); n.h = Math.max(min, wbSnap(hh, snap));
			if (n.type === 'text') { if (hd.length === 2) { const f = Math.max(6, Math.round((o.fontSize || 15) * (n.w / Math.max(1, o.w)))); n.fontSize = f; } n.h = o.h; n.y = o.y; }
			if (n.type === 'line') { n.baseW = n.baseW || o.w; }
			if (n.type === 'sticky' && typeof o.fontSize === 'number') { n.fontSize = Math.max(4, Math.round(o.fontSize * n.w / Math.max(1, o.w))); }
			if (n.type === 'stack') { n.size = wbStackSizeKey(n); n.h = wbStackGeom(n).h; }
			if (n.type === 'mind' && (hd === 'e' || hd === 'w')) {
				const el0 = this.nodeEls.get(n.id); const sc = this.mmScale(n.id);
				n.x = o.x; n.y = o.y; n.h = o.h; n.mmW = Math.max(60, Math.round(w / sc));
				if (el0 && n.mmW * sc >= this.mmNatW(n, el0)) delete n.mmW; // dragged back out past the text: hug it again
				if (el0) { el0.classList.toggle('wb-mm-wrap', !!n.mmW); this.mmFit(n, el0); }
				const rt = this.mmRootOf(n.id); if (rt) this.mmLayout(rt.id);
				this.renderAll(); this.placeCtx(); return;
			}
			if (this.mmIsTree && this.mmIsTree(n.id)) { const root = this.mmRootOf(n.id); root.mm = root.mm || { dir: 'horizontal', sides: 'both' }; root.mm.scale = Math.max(0.3, Math.min(4, (d.scale0 || 1) * (n.w / o.w))); this.mmLayout(root.id); this.renderAll(); this.placeCtx(); return; }
			this.renderNode(n); this.dragFrame([n]); return;
		}
		if (d.kind === 'gresize') {
			const bb = d.bb, hd = d.handle; const wx = dx / this.cam.z, wy = dy / this.cam.z;
			// anchor = the corner opposite the handle; scale locked to the group's proportions
			const ax = hd.includes('w') ? bb.x + bb.w : bb.x, ay = hd.includes('n') ? bb.y + bb.h : bb.y;
			const sx = hd.includes('e') ? (bb.w + wx) / bb.w : (bb.w - wx) / bb.w; const sy = hd.includes('s') ? (bb.h + wy) / bb.h : (bb.h - wy) / bb.h;
			const sc = Math.max(0.1, Math.abs(wx) > Math.abs(wy) ? sx : sy);
			d.items.forEach((n, i) => { const o = d.orig[i]; n.x = Math.round(ax + (o.x - ax) * sc); n.y = Math.round(ay + (o.y - ay) * sc); n.w = Math.max(24, Math.round(o.w * sc)); n.h = Math.max(24, Math.round(o.h * sc)); if (typeof o.fontSize === 'number') n.fontSize = Math.max(6, Math.round(o.fontSize * sc)); this.renderNode(n); });
			// A whole mind map in the selection cannot be scaled through its coordinates: a bubble's size comes from its TEXT
			// (mmFit), so the boxes sprang straight back to full size while the positions stayed squeezed and the map
			// collapsed into itself (his recording 2026-09-19). A map scales the way a single bubble already scaled it,
			// through mm.scale and a relayout. The root keeps the position the group scaling gave it, so it follows the drag.
			if (d.mmRoots && d.mmRoots.length) {
				for (const r of d.mmRoots) { const root = this.nodeById(r.id); if (!root || !root.mm) continue; root.mm.scale = Math.max(0.3, Math.min(4, r.s0 * sc)); this.mmLayout(r.id); }
				this.renderAll(); this.placeCtx(); return;
			}
			this.renderEdges(); this.renderOverlay(); this.placeCtx(); return;
		}
		if (d.kind === 'newshape') {
			const snap = !!(this.scene.settings && this.scene.settings.snap) && !e.metaKey; const w1 = this.toWorld(pt.x, pt.y);
			if (!d.n) { this.pushHistory(); d.n = wbNode('shape', d.w0.x, d.w0.y, 1, 1, { text: '', shape: this.shapeKind, fontSize: 15 }); this.scene.nodes.push(d.n); this.selected = new Set([d.n.id]); this.selectedEdge = null; }
			let ex = w1.x, ey = w1.y;
			// Shift keeps the sides equal (a square, a circle)
			if (e.shiftKey) { const sz = Math.max(Math.abs(ex - d.w0.x), Math.abs(ey - d.w0.y)); ex = d.w0.x + (ex < d.w0.x ? -sz : sz); ey = d.w0.y + (ey < d.w0.y ? -sz : sz); }
			d.big = d.big || Math.abs(ex - d.w0.x) >= 12 || Math.abs(ey - d.w0.y) >= 12;
			const x0 = wbSnap(Math.min(d.w0.x, ex), snap), y0 = wbSnap(Math.min(d.w0.y, ey), snap), x1 = wbSnap(Math.max(d.w0.x, ex), snap), y1 = wbSnap(Math.max(d.w0.y, ey), snap);
			d.n.x = x0; d.n.y = y0; d.n.w = Math.max(24, x1 - x0); d.n.h = Math.max(24, y1 - y0); this.renderNode(d.n); this.renderEdges(); this.renderOverlay(); return;
		}
		if (d.kind === 'newframe') {
			const snap = !!(this.scene.settings && this.scene.settings.snap) && !e.metaKey; const w1 = this.toWorld(pt.x, pt.y);
			if (!d.n) { this.pushHistory(); const count = this.scene.nodes.filter((x) => x.type === 'frame').length + 1; d.n = wbNode('frame', d.w0.x, d.w0.y, 1, 1, { text: 'Frame ' + count, color: 'white', format: 'custom' }); this.scene.nodes.push(d.n); this.selected = new Set([d.n.id]); this.selectedEdge = null; }
			const x0 = wbSnap(Math.min(d.w0.x, w1.x), snap), y0 = wbSnap(Math.min(d.w0.y, w1.y), snap), x1 = wbSnap(Math.max(d.w0.x, w1.x), snap), y1 = wbSnap(Math.max(d.w0.y, w1.y), snap);
			d.n.x = x0; d.n.y = y0; d.n.w = Math.max(24, x1 - x0); d.n.h = Math.max(24, y1 - y0); this.renderNode(d.n); this.renderOverlay(); return;
		}
		if (d.kind === 'marquee') { d.rect = { x: Math.min(pt.x, d.sx - this.canvas.getBoundingClientRect().left), y: Math.min(pt.y, d.sy - this.canvas.getBoundingClientRect().top), w: Math.abs(dx), h: Math.abs(dy) }; const a = this.toWorld(d.rect.x, d.rect.y), b = this.toWorld(d.rect.x + d.rect.w, d.rect.y + d.rect.h); this.selected = new Set(d.add); for (const n of this.scene.nodes) { if (n.locked) continue; if (n.type === 'frame') { if (n.x >= a.x && n.x + n.w <= b.x && n.y >= a.y && n.y + n.h <= b.y) this.selected.add(n.id); } else if (n.x < b.x && n.x + n.w > a.x && n.y < b.y && n.y + n.h > a.y) this.selected.add(n.id); } this.renderOverlay(); return; } // a frame joins a marquee only when fully enclosed, so a marquee drawn inside it picks its content and not the frame
		if (d.kind === 'connect') { d.cur = pt; const hit = this.connectTarget(e); this.hover = hit && hit.id !== d.src.id ? hit.id : null; this.renderOverlay(); return; }
	}
	onUp(e, cancelled) {
		const d = this.drag; if (!d) return; this.drag = null; this.canvas.classList.remove('wb-panning');
		try { this.canvas.releasePointerCapture(d.pid); } catch (x) {}
		if (d.kind === 'edgept') { this.renderEdges(); this.renderOverlay(); this.buildCtx(); this.scheduleSave(); return; }
		if (d.kind === 'pull') { this.selected = new Set([d.stack.id]); this.selectedEdge = null; this.renderAll(); return; } // a click on the pad: select the stack, no note
		if (d.kind === 'connect' && !d.started && !cancelled && d.side && wbSpawnable(d.src)) {
			// a click (no drag) on a side dot: the previewed note becomes real, connected to the source (Miro's +)
			const at = this.spawnPos(d.src, d.side); this.hoverDot = null; this.spawnFrom(d.src, at.x, at.y, d.side); return;
		}
		if (d.kind === 'connect' && d.started && !cancelled) {
			const pt = this.localPt(e); const hit = this.connectTarget(e);
			if (hit && hit.id !== d.src.id) { this.pushHistory(); this.scene.edges.push({ id: wbUid(), from: d.src.id, to: hit.id, fromSide: d.side || null, toSide: null, route: 'curved' }); this.selected = new Set([hit.id]); }
			else if (!hit && wbSpawnable(d.src)) { const w = this.toWorld(pt.x, pt.y); this.hover = null; this.pendingSpawn = { src: d.src, side: d.side || null, x: w.x, y: w.y }; this.renderOverlay(); this.spawnPop(e.clientX, e.clientY); return; }
			this.hover = null; this.renderAll(); this.scheduleSave(); return;
		}
		if (d.kind === 'move') { if (d.moved) { this.scheduleSave(); } if (d.pulled && d.items[0]) { this.renderAll(); this.beginEdit(d.items[0].id); this.scheduleSave(); return; } this.renderAll(); return; }
		if (d.kind === 'resize' || d.kind === 'gresize') { this.scheduleSave(); this.renderAll(); return; }
		if (d.kind === 'newshape') {
			if (d.n && !d.big) { this.scene.nodes = this.scene.nodes.filter((x) => x !== d.n); this.undo.pop(); d.n = null; } // barely moved: that was a click
			if (!d.n) { this.createAt('shape', d.w0); return; }
			this.setTool('select'); this.renderAll(); this.beginEdit(d.n.id); this.scheduleSave(); return;
		}
		if (d.kind === 'newframe') {
			if (!d.n) { this.createFrameAt(d.w0); return; } // a click: the chosen format at that spot
			if (d.n.w < 40 || d.n.h < 40) { this.scene.nodes = this.scene.nodes.filter((x) => x !== d.n); this.selected = new Set(); this.createFrameAt(d.w0); return; }
			this.setTool('select'); this.renderAll(); this.scheduleSave(); return;
		}
		if (d.kind === 'marquee') { if (!d.started && d.toggle) { if (this.selected.has(d.toggle)) this.selected.delete(d.toggle); else this.selected.add(d.toggle); } this.renderAll(); return; }
	}
	onDbl(e) {
		const t = e.target; if (t.closest && (t.closest('.wb-ctx') || t.closest('.wb-rail') || t.closest('.wb-zoom'))) return;
		const ep = t.dataset && t.dataset.epoint;
		if (ep != null && this.selectedEdge) {
			const ed = this.scene.edges.find((x) => x.id === this.selectedEdge);
			if (ed && ed.points) { this.pushHistory(); ed.points.splice(Number(ep), 1); if (!ed.points.length) delete ed.points; this.renderEdges(); this.renderOverlay(); this.buildCtx(); this.scheduleSave(); }
			return;
		}
		const hit = this.hitNode(e) || this.hitAt(e); const edgeEl = t.closest ? t.closest('g[data-id]') : null;
		if (hit && hit.type === 'board') { this.plugin.openBoard(hit.recordGuid, this.panel); return; }
		if (hit && this.editing === hit.id) return; // already editing: let the browser select the word
		if (hit && hit.type !== 'image') { this.beginEdit(hit.id); return; }
		if (edgeEl) { this.editLabel(edgeEl.getAttribute('data-id')); return; }
		// Double-click on empty canvas does nothing with the Select tool (his ruling 2026-09-04).
	}
	onWheel(e) {
		e.preventDefault();
		const pt = this.localPt(e);
		if (e.ctrlKey || e.metaKey) { const dy = wbClamp(e.deltaY, -40, 40); const f = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.004)); this.zoomAt(pt.x, pt.y, f); return; }
		this.cam.x -= e.deltaX; this.cam.y -= e.deltaY; this.applyCamera();
	}
	smartGuides(items) {
		if (this.scene.nodes.length > 400) return null;
		const bb = wbBBox(items); const out = []; const tol = 4 / this.cam.z; const ids = new Set(items.map((n) => n.id));
		const xs = [bb.x, bb.x + bb.w / 2, bb.x + bb.w], ys = [bb.y, bb.y + bb.h / 2, bb.y + bb.h];
		for (const n of this.scene.nodes) { if (ids.has(n.id)) continue; for (const x of [n.x, n.x + n.w / 2, n.x + n.w]) for (const mx of xs) if (Math.abs(x - mx) < tol) out.push({ v: x }); for (const y of [n.y, n.y + n.h / 2, n.y + n.h]) for (const my of ys) if (Math.abs(y - my) < tol) out.push({ h: y }); }
		return out.slice(0, 6);
	}
	renderNodesFast(items) { for (const n of items) { const el = this.nodeEls.get(n.id); if (el) { el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; } } }
	// Lines, selection and toolbar are redrawn ONCE per frame during a drag, and only the lines that touch what moved (2026-09-22:
	// a trackpad sends up to 120 moves a second and every one redrew all 103 lines, which is what made a bubble drag lag)
	dragFrame(items) {
		this._dragOnly = new Set(items.map((n) => n.id));
		if (this._dragRaf) return;
		this._dragRaf = requestAnimationFrame(() => { this._dragRaf = 0; if (this.destroyed) return; this.renderEdges(this._dragOnly); this.renderOverlay(); this.placeCtx(); });
	}

	// --- creating ---------------------------------------------------------------
	// sub-board card: name, a count line and up to four content chips, read from the sub-board's saved scene
	async paintBoardCard(n, el) {
		const ic = el.querySelector('.wb-bc-icon'); if (ic) ic.innerHTML = n.icon ? '<span class="ti ' + wbEsc(n.icon) + '"></span>' : WB_I.subboard;
		const rec = await this.plugin.record(n.recordGuid); if (!el.isConnected) return;
		const t = el.querySelector('.wb-bc-title'), sub = el.querySelector('.wb-bc-sub'), chips = el.querySelector('.wb-bc-chips');
		if (!rec) { if (t) t.textContent = 'Board not found'; return; }
		if (t) t.textContent = rec.getName() || 'Untitled board';
		const live = [...this.plugin.boards.values()].find((b) => !b.destroyed && b.rec.guid === n.recordGuid);
		const scene = live ? live.scene : await this.plugin.loadScene(rec); if (!el.isConnected || !scene) return;
		const items = scene.nodes.filter((x) => x.type !== 'frame'); const boards = scene.nodes.filter((x) => x.type === 'board').length; const frames = scene.nodes.filter((x) => x.type === 'frame').length;
		const parts = [items.length - boards + (items.length - boards === 1 ? ' item' : ' items')]; if (frames) parts.push(frames + (frames === 1 ? ' frame' : ' frames')); if (boards) parts.push(boards + (boards === 1 ? ' sub-board' : ' sub-boards'));
		if (sub) sub.textContent = parts.join(' · ');
		if (chips) { chips.innerHTML = ''; let k = 0; for (const x of scene.nodes) { if (k >= 4) break; let label = ''; if (x.type === 'card' && x.recordGuid) { const r = this.plugin.recordSync(x.recordGuid); label = r ? (r.getName() || 'Untitled') : ''; } else if (x.type === 'frame' || x.type === 'board') label = (x.text || '').trim(); else label = (x.text || '').trim(); if (!label) continue; const ch = wbEl('span', 'wb-bc-chip'); ch.textContent = label.length > 18 ? label.slice(0, 17) + '…' : label; if (x.type === 'sticky' && x.color) ch.style.background = wbStickyColor(x.color).hex; chips.appendChild(ch); k++; } }
	}
	// a fresh, empty node of the same kind, size and colour as `src`, connected from `src`; editing starts at once
	// --- backups: the last versions kept on this device, plus export/import as a file ---
	async restoreMenu(anchor) {
		const list = await wbBackupList(this.rec.guid); if (!list.length) { this.plugin.toast('No earlier versions on this device yet.'); return; }
		const fmt = (t) => { const d = new Date(t); const today = new Date(); const same = d.toDateString() === today.toDateString(); return (same ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ') + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); };
		const items = list.map((b) => ({ v: b.key, label: fmt(b.t) + ', ' + b.count + (b.count === 1 ? ' item' : ' items') + (b.rev === this.scene.rev ? ' (current)' : ''), icon: 'ti-history' }));
		this.menu(anchor, items, null, (key) => { const b = list.find((x) => x.key === key); if (!b) return; let sc = null; try { sc = JSON.parse(b.json); } catch (e) {} if (!sc || !Array.isArray(sc.nodes)) { this.plugin.toast('That version could not be read.'); return; }
			this.pushHistory(); const rev = this.scene.rev; this.scene = Object.assign(wbNewScene(), sc, { rev }); this.userCleared = true; this.selected = new Set(); this.selectedEdge = null; this.renderAll(); this.applyBg(); this.applyTheme(); this.scheduleSave(); this.plugin.toast('Restored the version from ' + fmt(b.t) + '. Undo brings the previous state back.'); }, { width: 260, dots: false, maxRows: 20 });
	}
	exportScene() {
		const name = ((this.rec.getName && this.rec.getName()) || 'board').replace(/[^\w.-]+/g, '_') + '.whiteboard.json';
		const blob = new Blob([wbSceneJson(this.scene)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
	}
	importScene() {
		const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json,application/json';
		inp.addEventListener('change', async () => { const f = inp.files && inp.files[0]; if (!f) return; let sc = null; try { sc = JSON.parse(await f.text()); } catch (e) {} if (!sc || !Array.isArray(sc.nodes)) { this.plugin.toast('That file is not a whiteboard export.'); return; }
			this.pushHistory(); const rev = this.scene.rev; this.scene = Object.assign(wbNewScene(), sc, { rev }); this.userCleared = true; this.selected = new Set(); this.selectedEdge = null; this.renderAll(); this.applyBg(); this.applyTheme(); this.scheduleSave(); this.plugin.toast('Imported ' + sc.nodes.length + ' items. Undo brings the previous board back.'); });
		inp.click();
	}
	spawnPos(src, side) { const gap = 60; let x = src.x, y = src.y; if (side === 'right') x = src.x + src.w + gap; else if (side === 'left') x = src.x - src.w - gap; else if (side === 'bottom') y = src.y + src.h + gap; else if (side === 'top') y = src.y - src.h - gap; return { x, y }; }
	spawnFrom(src, x, y, side) {
		this.pushHistory();
		const fresh = { id: wbUid(), type: src.type, x, y, w: src.w, h: src.h, text: '' };
		for (const k of ['color', 'fontSize', 'shape', 'fill', 'stroke', 'strokeWidth', 'align', 'textColor', 'bg']) if (src[k] !== undefined) fresh[k] = src[k];
		this.scene.nodes.push(fresh); this.scene.edges.push(Object.assign({}, this.edgeStyleOf(src), { id: wbUid(), from: src.id, to: fresh.id, fromSide: side || null, toSide: null }));
		this.selected = new Set([fresh.id]); this.renderAll(); this.beginEdit(fresh.id); this.scheduleSave();
	}
	// Miro: a relation dropped on empty canvas asks what to put there. Enter = the same kind as the source, Escape = nothing.
	spawnPop(cx, cy) {
		this.plugin.closeMenus(); const ps = this.pendingSpawn; if (!ps) return;
		const pop = wbEl('div', 'wb-pop wb-spawnpop'); pop.addEventListener('pointerdown', (e) => e.stopPropagation());
		const same = wbEl('div', 'wb-sprow', (ps.src.type === 'shape' ? (WB_SHAPE_ICON[ps.src.shape] || WB_I.shape) : (WB_I[ps.src.type] || WB_I.sticky)) + '<span>Same object</span><span class="wb-key">Enter</span>');
		same.addEventListener('click', (e) => { e.stopPropagation(); this.spawnPending(null); }); pop.appendChild(same);
		const grid = wbEl('div', 'wb-spgrid'); pop.appendChild(grid);
		const opts = [['text', null, 'Text', WB_I.text], ['sticky', null, 'Sticky', WB_I.sticky]].concat(WB_SHAPES.map((k) => ['shape', k, k.charAt(0).toUpperCase() + k.slice(1), WB_SHAPE_ICON[k]]));
		for (const [type, shape, title, icon] of opts) { const fi = wbEl('div', 'wb-fi', icon); fi.title = title; fi.addEventListener('click', (e) => { e.stopPropagation(); this.spawnPending({ type, shape }); }); grid.appendChild(fi); }
		this.host.appendChild(pop); const hr = this.host.getBoundingClientRect();
		pop.style.left = Math.max(hr.left + 8, Math.min(cx + 14, hr.right - pop.offsetWidth - 8)) + 'px'; pop.style.top = Math.max(hr.top + 8, Math.min(cy - 12, hr.bottom - pop.offsetHeight - 8)) + 'px';
		this.plugin._pop = pop; pop._onClose = () => { if (this.pendingSpawn) { this.pendingSpawn = null; this.renderOverlay(); } };
		const out = (e) => { if (!pop.contains(e.target)) this.plugin.closeMenus(); }; document.addEventListener('pointerdown', out, true); pop._out = out;
	}
	spawnPending(pick) {
		const ps = this.pendingSpawn; if (!ps) return; this.pendingSpawn = null; const src = ps.src;
		const type = pick ? pick.type : src.type; const shape = pick ? pick.shape : src.shape;
		let w = src.w, h = src.h; if (type === 'text') { h = 30; } // same footprint as the source, whatever the kind: a chain keeps one scale
		this.pushHistory();
		const fresh = { id: wbUid(), type, x: Math.round(ps.x - w / 2), y: Math.round(ps.y - h / 2), w, h, text: '' };
		if (type === 'sticky') { fresh.color = src.type === 'sticky' ? src.color : this.stickyColor; fresh.fontSize = src.type === 'sticky' ? src.fontSize : 'auto'; }
		if (type === 'text') fresh.fontSize = src.type === 'text' ? src.fontSize : 15;
		if (type === 'shape') { fresh.shape = shape; fresh.fontSize = 15; if (src.type === 'shape') for (const k of ['fill', 'stroke', 'strokeWidth', 'textColor', 'fontSize']) if (src[k] !== undefined) fresh[k] = src[k]; }
		this.scene.nodes.push(fresh); this.scene.edges.push(Object.assign({}, this.edgeStyleOf(src), { id: wbUid(), from: src.id, to: fresh.id, fromSide: ps.side, toSide: null }));
		this.plugin.closeMenus(); this.selected = new Set([fresh.id]); this.renderAll(); this.beginEdit(fresh.id); this.scheduleSave();
	}
	// the look of the newest relation touching a node: a chain of notes keeps one line style (dotted stays dotted)
	edgeStyleOf(n) {
		const out = { route: 'curved' }; const es = this.scene.edges.filter((e) => e.from === n.id || e.to === n.id); const last = es[es.length - 1]; if (!last) return out;
		for (const k of ['route', 'dash', 'color', 'width', 'startArrow', 'endArrow']) if (last[k] !== undefined) out[k] = last[k];
		return out;
	}
	createFrameAt(w) {
		this.pushHistory(); const snap = !!(this.scene.settings && this.scene.settings.snap);
		const count = this.scene.nodes.filter((x) => x.type === 'frame').length + 1;
		const fmt = wbFrameFormat(this.frameKind);
		const n = wbNode('frame', wbSnap(w.x - fmt.w / 2, snap), wbSnap(w.y - fmt.h / 2, snap), fmt.w, fmt.h, { text: 'Frame ' + count, color: 'white', format: fmt.id });
		this.scene.nodes.push(n); this.selected = new Set([n.id]); this.selectedEdge = null;
		this.setTool('select'); this.renderAll(); this.scheduleSave();
	}
	// everything that sits fully inside a frame moves with it (nested frames and their content included)
	frameChildren(f) { return this.scene.nodes.filter((n) => n !== f && n.x >= f.x && n.y >= f.y && n.x + n.w <= f.x + f.w && n.y + n.h <= f.y + f.h); }
	createAt(kind, w) {
		this.pushHistory(); let n;
		const snap = !!(this.scene.settings && this.scene.settings.snap);
		if (kind === 'sticky') { const sw = this.stickyWide ? 260 : 170, sh = this.stickyWide ? 150 : 170; n = wbNode('sticky', wbSnap(w.x - sw / 2, snap), wbSnap(w.y - sh / 2, snap), sw, sh, { text: '', color: this.stickyColor, fontSize: 'auto' }); }
		else if (kind === 'text') n = wbNode('text', wbSnap(w.x, snap), wbSnap(w.y - 14, snap), 240, 30, { text: '', fontSize: 15 });
		else n = wbNode('shape', wbSnap(w.x - 100, snap), wbSnap(w.y - 50, snap), 200, 100, { text: '', shape: this.shapeKind, fontSize: 15 });
		this.scene.nodes.push(n); this.selected = new Set([n.id]); this.selectedEdge = null;
		this.setTool('select'); this.renderAll(); this.beginEdit(n.id); this.scheduleSave();
	}
	duplicateNodes(items, dx, dy) {
		const map = new Map(); const copies = [];
		for (const n of items) { const c = Object.assign({}, n, { id: wbUid(), x: n.x + dx, y: n.y + dy }); map.set(n.id, c.id); copies.push(c); this.scene.nodes.push(c); }
		for (const e of [...this.scene.edges]) if (map.has(e.from) && map.has(e.to)) this.scene.edges.push(Object.assign({}, e, { id: wbUid(), from: map.get(e.from), to: map.get(e.to) }));
		return copies;
	}
	pickImage() {
		const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
		inp.addEventListener('change', () => { const r = this.canvas.getBoundingClientRect(); const w = this.toWorld(r.width / 2, r.height / 2); let i = 0; for (const f of inp.files) this.addImageFile(f, w.x - 110 + i * 24, w.y - 80 + i++ * 24); });
		inp.click();
	}
	async addImageFile(file, wx, wy) {
		file = await wbShrinkImage(file);
		const dims = await new Promise((res) => { const u = URL.createObjectURL(file); const im = new Image(); im.onload = () => { res({ w: im.naturalWidth, h: im.naturalHeight, u }); }; im.onerror = () => res({ w: 300, h: 200, u }); im.src = u; });
		const blob = await this.plugin.data.uploadBlob(file); if (!blob || this.destroyed) { this.plugin.toast('Could not upload the image.'); return; }
		const maxW = 360; const scale = Math.min(1, maxW / dims.w); const w = Math.round(dims.w * scale), h = Math.round(dims.h * scale);
		this.pushHistory();
		const n = wbNode('image', Math.round(wx), Math.round(wy), w, h, { blobGuid: blob.guid, name: file.name || 'image' });
		this.imgUrls.set(blob.guid, dims.u);
		this.scene.nodes.push(n); this.selected = new Set([n.id]); this.renderAll(); this.scheduleSave();
	}
	onPaste(e) {
		if (this.destroyed) return;
		// The app cancels every paste on a window-level capture listener (measured 2026-09-07: defaultPrevented is already
		// true when the event reaches document capture), so nothing ever lands in our own editable notes. We therefore have
		// to insert it ourselves. Insert ONCE: execCommand first, and the manual range only if the text really did not
		// change, because execCommand can report failure and still have inserted, which is what doubled it in 0.14.8.
		if (this.editing) {
			const el = this.nodeEls.get(this.editing); const box = el && el.querySelector('.wb-txt');
			const data = e.clipboardData ? (e.clipboardData.getData('text/plain') || '') : '';
			if (!box || !data) return;
			e.preventDefault(); e.stopPropagation();
			const text = data.replace(/\r\n/g, '\n');
			const before = box.innerText;
			try { document.execCommand('insertText', false, text); } catch (x) {}
			if (box.innerText === before) {
				const sel = window.getSelection();
				if (sel && sel.rangeCount && box.contains(sel.anchorNode)) { const rg = sel.getRangeAt(0); rg.deleteContents(); const t = document.createTextNode(text); rg.insertNode(t); rg.setStartAfter(t); rg.collapse(true); sel.removeAllRanges(); sel.addRange(rg); }
				else box.appendChild(document.createTextNode(text));
			}
			if (this.editInput) this.editInput();
			return;
		}
		const items = e.clipboardData && e.clipboardData.items; if (!items) return;
		const r = this.canvas.getBoundingClientRect(); const w = this.toWorld(r.width / 2, r.height / 2);
		for (const it of items) { if (it.kind === 'file' && /^image\//.test(it.type)) { const f = it.getAsFile(); if (f) { e.preventDefault(); this.addImageFile(f, w.x - 150, w.y - 100); return; } } }
		const txt = e.clipboardData.getData('text/plain'); if (txt && txt.startsWith('WBCLIP1') && !this.editing) { e.preventDefault(); this.pasteClip(txt); return; }
		const one = this.selected.size === 1 ? this.nodeById([...this.selected][0]) : null;
		if (txt && txt.trim() && one && (one.type === 'sticky' || one.type === 'text' || one.type === 'shape' || one.type === 'mind')) {
			e.preventDefault(); this.pushHistory();
			const add = txt.replace(/\s+$/, '');
			one.text = (one.text || '').trim() ? (one.text.replace(/\s+$/, '') + '\n' + add) : add;
			this.renderAll();
			const el2 = this.nodeEls.get(one.id);
			if (el2 && one.type === 'sticky') this.fitSticky(one, el2);
			if (one.type === 'mind') { const r = this.mmRootOf(one.id); if (r) this.mmLayout(r.id); this.renderAll(); }
			this.renderOverlay(); this.scheduleSave(); return;
		}
		// With the Sticky tool chosen, several pasted lines (a list, a CSV column) become one post-it per line (his ask 2026-09-22),
		// laid out as a grid around the view's middle in the current colour, list markers stripped, all selected afterwards.
		const rows = txt ? txt.split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*\u2022\u25E6\u2013]|\d+[.)])\s+/, '').trim()).filter(Boolean) : [];
		if (rows.length >= 2 && this.tool === 'sticky') { e.preventDefault(); this.pasteStickies(rows, w); return; } // only with the Sticky tool chosen (his ruling 2026-09-22): with Select, a pasted text stays one text element
		if (txt && txt.trim()) { e.preventDefault(); this.pushHistory(); const n = wbNode('text', Math.round(w.x - 120), Math.round(w.y - 15), 240, 30, { text: txt.trim(), fontSize: 15 }); this.scene.nodes.push(n); this.selected = new Set([n.id]); this.renderAll(); this.scheduleSave(); }
	}

	pasteStickies(rows, w) {
		this.pushHistory(); const snap = !!(this.scene.settings && this.scene.settings.snap);
		const sw = this.stickyWide ? 260 : 170, sh = this.stickyWide ? 150 : 170, gap = 24;
		const cols = Math.min(rows.length, Math.max(1, Math.ceil(Math.sqrt(rows.length)))); const rowsN = Math.ceil(rows.length / cols);
		const x0 = w.x - (cols * sw + (cols - 1) * gap) / 2, y0 = w.y - (rowsN * sh + (rowsN - 1) * gap) / 2;
		const made = rows.map((text, i) => wbNode('sticky', wbSnap(x0 + (i % cols) * (sw + gap), snap), wbSnap(y0 + Math.floor(i / cols) * (sh + gap), snap), sw, sh, { text, color: this.stickyColor, fontSize: 'auto' }));
		for (const n of made) this.scene.nodes.push(n);
		this.selected = new Set(made.map((n) => n.id)); this.selectedEdge = null; this.renderAll(); this.scheduleSave();
		this.plugin.toast(made.length + ' post-its from the pasted lines.');
	}

	// --- editing ----------------------------------------------------------------
	beginEdit(id) {
		const n = this.nodeById(id); const el = this.nodeEls.get(id); if (!n || !el || n.type === 'image') return;
		this.commitEdit(); this.editing = id; el.classList.add('wb-editing');
		const txt = el.querySelector('.wb-txt'); txt.contentEditable = 'true'; txt.spellcheck = false;
		this.editSnapshot = n.text || '';
		txt.focus(); const sel = window.getSelection(); const rg = document.createRange(); rg.selectNodeContents(txt); rg.collapse(false); sel.removeAllRanges(); sel.addRange(rg);
		this.editInput = () => { n.text = txt.innerText.replace(/\n$/, ''); if (n.type === 'sticky') this.fitSticky(n, el); if (n.type === 'text') { const want = Math.max(28, txt.scrollHeight + 8); if (want !== n.h) { n.h = want; el.style.height = want + 'px'; this.renderEdges(); this.renderOverlay(); } } };
		txt.addEventListener('input', this.editInput);
		this.renderOverlay(); this.buildCtx();
	}
	commitEdit() {
		if (!this.editing) return; const id = this.editing; const n = this.nodeById(id); const el = this.nodeEls.get(id); this.editing = null;
		if (!el) { const stray = this.nodes.querySelector('.wb-node.wb-editing'); if (stray) { const st = stray.querySelector('.wb-txt'); if (st) { try { st.removeEventListener('input', this.editInput); } catch (e) {} st.contentEditable = 'false'; } stray.classList.remove('wb-editing'); } }
		if (el) { const txt = el.querySelector('.wb-txt'); if (txt) { txt.removeEventListener('input', this.editInput); txt.contentEditable = 'false'; if (n) { n.text = txt.innerText.replace(/\n$/, ''); const clean = wbSanitizeHtml(txt.innerHTML); if (/<(b|strong|i|em|u|s|strike|mark|span|font)\b/i.test(clean)) n.html = clean; else delete n.html; } } el.classList.remove('wb-editing'); }
		if (n && n.text !== this.editSnapshot) { this.undo.push(this.snapshotWith(id, this.editSnapshot)); this.redo = []; this.scheduleSave(); }
		if (n && n.type === 'text' && !(n.text || '').trim() && !this.keepEmpty) { this.scene.nodes = this.scene.nodes.filter((x) => x.id !== id); this.scene.edges = this.scene.edges.filter((e) => e.from !== id && e.to !== id); this.selected.delete(id); this.scheduleSave(); }
		try { window.getSelection().removeAllRanges(); } catch (e) {}
		this.renderAll();
	}
	snapshotWith(id, text) { const s = JSON.parse(JSON.stringify(this.scene)); const n = s.nodes.find((x) => x.id === id); if (n) n.text = text; return JSON.stringify(s); }
	editLabel(edgeId) {
		const e = this.scene.edges.find((x) => x.id === edgeId); const ent = this.edgeEls.get(edgeId); if (!e || !ent) return;
		this.commitEdit(); this.selectedEdge = edgeId; this.selected.clear(); this.renderAll();
		const lab = ent.label; lab.contentEditable = 'true'; lab.textContent = e.label || ''; lab.focus();
		const done = () => { lab.contentEditable = 'false'; const v = lab.textContent.trim(); if (v !== (e.label || '')) { this.pushHistory(); e.label = v; this.scheduleSave(); } lab.removeEventListener('blur', done); lab.removeEventListener('keydown', kd); this.renderEdges(); };
		const kd = (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); lab.blur(); } };
		lab.addEventListener('blur', done); lab.addEventListener('keydown', kd);
		const sel = window.getSelection(); const rg = document.createRange(); rg.selectNodeContents(lab); sel.removeAllRanges(); sel.addRange(rg);
	}

	// --- keyboard ---------------------------------------------------------------
	onKey(e) {
		if (this.destroyed) return;
		const meta = e.metaKey || e.ctrlKey;
		const t = e.target;
		if (this.nativeEdit) return;
		if (t && t.tagName && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return; // our popovers (tags, rename, hex) own their keys
		if (this._noteEditor) { if (e.key === 'Escape') { e.stopPropagation(); this.noteEditClose(); } return; } // the floating editor owns the keyboard
		if (this.pendingSpawn) { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); this.spawnPending(null); return; } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.plugin.closeMenus(); return; } }
		if (e.metaKey || e.ctrlKey || e.altKey) { const act = wbMatchAction(e, this.plugin); if (act) { e.preventDefault(); e.stopPropagation(); if (act === 'panel.history_back') this.plugin.goBack(this.panel); else if (act === 'panel.history_forward') this.plugin.goForward(this.panel); else this.plugin.goJournal(this.panel); return; } }
		const inlineEdit = t && t.classList && t.getAttribute && t.getAttribute('contenteditable') === 'true' && (t.classList.contains('wb-elabel') || t.classList.contains('wb-title'));
		if (inlineEdit) {
			if (meta && e.key.toLowerCase() === 'a') { e.preventDefault(); e.stopPropagation(); const sel = window.getSelection(); const rg = document.createRange(); rg.selectNodeContents(t); sel.removeAllRanges(); sel.addRange(rg); return; }
			if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); t.blur(); return; }
			e.stopPropagation(); return;
		}
		if (this.editing) {
			// Everything stays in the text while editing, except commit / undo.
			if (meta && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); this.commitEdit(); return; }
			if (meta && e.key.toLowerCase() === 'a') { e.preventDefault(); e.stopPropagation(); const ed = this.nodeEls.get(this.editing); const tx = ed && ed.querySelector('.wb-txt'); if (tx) { const sel = window.getSelection(); const rg = document.createRange(); rg.selectNodeContents(tx); sel.removeAllRanges(); sel.addRange(rg); } return; }
			if (meta && e.key.toLowerCase() === 'b') { e.preventDefault(); e.stopPropagation(); this.styleSel({ bold: 'toggle' }); return; }
			if (meta && e.key.toLowerCase() === 'i') { e.preventDefault(); e.stopPropagation(); this.styleSel({ italic: 'toggle' }); return; }
			if (meta && e.key.toLowerCase() === 'u') { e.preventDefault(); e.stopPropagation(); this.styleSel({ underline: 'toggle' }); return; }
			if (meta && e.shiftKey && e.key.toLowerCase() === 'x') { e.preventDefault(); e.stopPropagation(); this.styleSel({ strike: 'toggle' }); return; }
			e.stopPropagation(); return;
		}
		if (e.target && (e.target.tagName === 'INPUT' || e.target.isContentEditable)) return;
		const k = e.key; const lk = k.toLowerCase();
		const stop = () => { e.preventDefault(); e.stopPropagation(); };
		if (e.code === 'Space' && this.selected.size === 1) { const cn = this.nodeById([...this.selected][0]); if (cn && cn.type === 'card' && cn.recordGuid) { stop(); this.plugin.openRecord(cn.recordGuid, this.panel, true); return; } if (cn && this.isNoteNode && this.isNoteNode(cn) && cn.recordGuid && cn.recordGuid !== this.rec.guid) { stop(); this.plugin.openLine(cn.recordGuid, cn.lineGuid, this.panel, true); return; } }
		if (e.code === 'Space') { this.space = true; this.canvas.classList.add('wb-space'); stop(); return; }
		if (meta && lk === 'z') { stop(); if (e.shiftKey) this.redoOnce(); else this.undoOnce(); return; }
		if (meta && lk === 'a') { stop(); this.selected = new Set(this.scene.nodes.map((n) => n.id)); this.renderAll(); return; }
		if (meta && lk === 'd') { stop(); this.dupSelection(); return; }
		if (meta && !e.shiftKey && (lk === 'c' || lk === 'x') && this.selected.size && !this.editing) { stop(); this.copySelection(lk === 'x'); return; }
		if (meta && e.shiftKey && lk === 'l' && this.selected.size) { stop(); this.toggleLock(); return; }
		if (meta && !e.shiftKey && (lk === 'b' || lk === 'i' || lk === 'u') && this.selected.size) { stop(); this.styleSel({ [lk === 'b' ? 'bold' : lk === 'i' ? 'italic' : 'underline']: 'toggle' }); return; }
		if (meta && lk === '0') { stop(); this.zoomTo(1); return; }
		if (meta && (k === '=' || k === '+')) { stop(); this.zoomBy(1.2); return; }
		if (meta && k === '-') { stop(); this.zoomBy(1 / 1.2); return; }
		if (e.shiftKey && k === '!') { stop(); this.fitAll(); return; }
		if (e.shiftKey && k === '"') { stop(); const sel = [...this.selected].map((id) => this.nodeById(id)).filter(Boolean); if (sel.length) this.fitAll(sel); return; }
		if (meta) return;
		if (k === 'Backspace' || k === 'Delete') { stop(); this.deleteSelection(); return; }
		if (k === 'Enter' && this.selected.size === 1) { stop(); this.beginEdit([...this.selected][0]); return; }
		if (k.startsWith('Arrow') && this.selected.size && !e.altKey) { stop(); const d = e.shiftKey ? WB_GRID : 1; const dx = k === 'ArrowLeft' ? -d : k === 'ArrowRight' ? d : 0, dy = k === 'ArrowUp' ? -d : k === 'ArrowDown' ? d : 0; this.pushHistory(); const mv = []; for (const id of this.selected) { const n = this.nodeById(id); if (n && !n.locked) { mv.push(n); if (n.type === 'frame') for (const k of this.frameChildren(n)) if (!k.locked && !mv.includes(k)) mv.push(k); } } for (const n of mv) { n.x += dx; n.y += dy; } this.renderAll(); this.scheduleSave(); return; }
		// Miro: select a sticky and just type. This wins over the one-letter tool keys (v/n/t/s/l/p/c/k/i), otherwise typing
		// "s" into a selected sticky switched to the Shape tool and the next click drew a shape (his recording 2026-09-05).
		if (k.length === 1 && !e.altKey && this.selected.size === 1) { const n = this.nodeById([...this.selected][0]); if (n && (n.type === 'sticky' || n.type === 'text' || n.type === 'shape' || n.type === 'mind')) { stop(); this.pushHistory(); n.text = ''; this.renderNode(n); this.beginEdit(n.id); document.execCommand('insertText', false, k); return; } }
		const toolKeys = { v: 'select', n: 'sticky', t: 'text', s: 'shape', f: 'frame', l: 'connect', p: 'card', c: 'comment', k: 'note', m: 'mind' };
		if (!e.altKey && toolKeys[lk]) { stop(); this.setTool(toolKeys[lk]); return; }
		if (lk === 'i' && !e.altKey) { stop(); this.pickImage(); return; }
	}
	// --- moving elements to another board, and sub-boards ---------------------------------------------------------
	selectionForMove() {
		const sel = [...this.selected].map((id) => this.nodeById(id)).filter((n) => n && !n.locked); const set = new Set(sel);
		for (const f of sel.filter((n) => n.type === 'frame')) for (const k of this.frameChildren(f)) if (!k.locked) set.add(k);
		return [...set];
	}
	// Everything that turns the selection into something else lives here (his ruling 2026-09-07), so Mind map and Make
	// page are no longer categories of their own in the toolbar.
	// Everything that turns the selection into something else lives here (his ruling 2026-09-07), so Mind map and Make
	// page are no longer categories of their own. Rows carry the rail's own icons, not generic dots.
	selectionMenu(anchor, sel) {
		const one = sel.length === 1 ? sel[0] : null;
		const frame = !!(one && one.type === 'frame');
		const mmType = (n) => n && (n.type === 'sticky' || n.type === 'text' || n.type === 'shape' || n.type === 'mind');
		const loose = sel.filter((n) => mmType(n) && !this.mmIsTree(n.id));
		const isNote = !!(one && this.isNoteNode && this.isNoteNode(one));
		const inTree = !!(one && this.mmIsTree(one.id));
		const branches = sel.filter((n) => this.mmIsTree(n.id) && this.mmParent(n.id)); // a root keeps its map, it is never converted away
		const branch = inTree && !!this.mmParent(one.id);
		const pageable = !!(one && (mmType(one) || isNote) && !(isNote && one.whole));
		const pageCard = !!(one && one.type === 'card' && one.recordGuid && !one._missing); // a page card can show the page's body instead
		const noteable = !!(one && !isNote && ((mmType(one) && (!inTree || branch)) || pageCard));
		const rootable = !!(one && mmType(one) && !inTree);
		const kids = !!(inTree && this.mmChildren(one.id).length);
		const mmIcon = WB_SVG('<circle cx="12" cy="12" r="3"></circle><path d="M12 9V4"></path><path d="M12 15v5"></path><path d="M9 12H4"></path><path d="M15 12h5"></path>');
		const items = [{ v: 'move', label: 'Move to another board', svg: WB_I.moveTo }, { sep: true }];
		if (sel.length && !sel.some((n) => n.type === 'frame')) items.push({ v: 'zfront', label: 'Bring to front', svg: WB_I.zfront }, { v: 'zup', label: 'Bring forward', svg: WB_I.zup }, { v: 'zdown', label: 'Send backward', svg: WB_I.zdown }, { v: 'zback', label: 'Send to back', svg: WB_I.zback }, { sep: true }); // frames live in their own layer under everything
		if (pageable) items.push({ v: 'page', label: 'Turn into a page', svg: WB_I.card });
		if (noteable) items.push({ v: 'note', label: 'Turn into a note card', svg: WB_I.note });
		if (isNote && one.whole) items.push({ v: 'pagecard', label: 'Turn into a page card', svg: WB_I.card });
		if (branches.length) items.push({ v: 'postit', label: branches.length > 1 ? 'Turn into post-its' : 'Turn into a post-it', svg: WB_I.sticky });
		items.push({ v: 'sub', label: frame ? 'Turn the frame into a sub-board' : 'Turn into a sub-board', svg: WB_I.subboard });
		if (rootable || loose.length >= 2) items.push({ v: 'mindmap', label: 'Turn into a mind map', svg: mmIcon });
		if (kids) items.push({ v: 'kidpages', label: 'Turn every child into a page', svg: WB_I.card });
		wbMenu(anchor, items, null, (v) => {
			if (v === 'move') { setTimeout(() => this.moveToBoardMenu(anchor), 30); return; }
			if (v === 'zfront' || v === 'zup' || v === 'zdown' || v === 'zback') { this.reorderZ(sel, v); return; }
			if (v === 'mindmap') { if (loose.length >= 2) this.mmFromSelection(); else this.mmMakeRoot(one); return; }
			if (v === 'note') { if (pageCard) this.turnIntoBodyCard(one); else this.turnIntoNote(one); return; }
			if (v === 'pagecard') { this.turnIntoPageCard(one); return; }
			if (v === 'postit') { this.mmToPostit(branches); return; }
			if (v === 'page') { setTimeout(() => this.plugin.pickCollection(anchor, (col) => (isNote ? this.notePromoteToPage(one, col) : this.promoteToPage(one, col))), 30); return; }
			if (v === 'kidpages') { setTimeout(() => this.plugin.pickCollection(anchor, (c2) => this.mmChildrenToPages(one, c2)), 30); return; }
			this.createSubBoard();
		}, { width: 300, dots: false });
	}
	async moveToBoardMenu(anchor) {
		const recs = (await this.plugin.allBoards()).filter((r) => r.guid !== this.rec.guid);
		if (!recs.length) { this.plugin.toast('There is no other board yet.'); return; }
		wbMenu(anchor, recs.map((r) => ({ v: r.guid, label: r.getName() || 'Untitled', icon: 'ti-layout-board' })), null, (v) => this.moveSelectionToBoard(v), { width: 260, dots: false, search: recs.length > 8, startTop: true, searchPlaceholder: 'Find a board' });
	}
	// Moves the nodes (frames carry their content), the edges between them, and a board-local card's block. Placed where
	// they were unless that overlaps the target's content, then below it.
	async moveSelectionToBoard(guid, opts) {
		opts = opts || {}; const nodes = opts.nodes || this.selectionForMove(); if (!nodes.length) return null;
		const targetRec = await this.plugin.record(guid); if (!targetRec) { this.plugin.toast('That board was not found.'); return null; }
		const live = [...this.plugin.boards.values()].find((b) => !b.destroyed && b !== this && b.rec.guid === guid);
		const scene = live ? live.scene : ((await this.plugin.loadScene(targetRec)) || wbNewScene());
		const ids = new Set(nodes.map((n) => n.id)); const edges = this.scene.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
		const mine = wbBBox(nodes); const bb = wbBBox(scene.nodes); let dx = 0, dy = 0;
		if (opts.toOrigin && mine) { dx = 80 - mine.x; dy = 80 - mine.y; }
		else if (bb && mine && mine.x < bb.x + bb.w && mine.x + mine.w > bb.x && mine.y < bb.y + bb.h && mine.y + mine.h > bb.y) { dx = bb.x - mine.x; dy = bb.y + bb.h + 80 - mine.y; }
		for (const n of nodes) { if (n.type === 'note' && n.recordGuid === this.rec.guid && !n.lines) { try { const li = await this.noteLine(n); const last = await lastTopLevel(targetRec); if (li && await li.move(targetRec, last)) { n.recordGuid = guid; n._snap = null; } } catch (e) {} } }
		this.pushHistory();
		for (const n of nodes) { n.x += dx; n.y += dy; delete n._snap; delete n._rev; scene.nodes.push(n); } for (const e of edges) scene.edges.push(e);
		scene.reveal = nodes.map((n) => n.id); // the target board selects and frames these when it opens next
		if (live) { live.selected = new Set(scene.reveal); delete scene.reveal; live.renderAll(); live.fitAll(nodes); }
		this.scene.nodes = this.scene.nodes.filter((n) => !ids.has(n.id)); this.scene.edges = this.scene.edges.filter((e) => !ids.has(e.from) && !ids.has(e.to));
		for (const id of ids) this.selected.delete(id); this.renderAll(); this.scheduleSave();
		if (live) { live.renderAll(); live.scheduleSave(); } else await this.plugin.saveScene(targetRec, scene);
		if (!opts.quiet) this.plugin.toast('Moved ' + nodes.length + (nodes.length === 1 ? ' item' : ' items') + ' to ' + (targetRec.getName() || 'the board') + '.');
		return { rec: targetRec, moved: nodes };
	}
	// A new board that belongs to this one; the selection moves into it and a card stands in its place here.
	async createSubBoard() {
		const sel = [...this.selected].map((id) => this.nodeById(id)).filter(Boolean); if (!sel.length) return;
		const frame = sel.length === 1 && sel[0].type === 'frame' ? sel[0] : null;
		const nodes = frame ? this.frameChildren(frame).filter((n) => !n.locked) : this.selectionForMove();
		const name = frame ? ((frame.text || '').trim() || 'Sub-board') : 'Sub-board ' + (this.scene.nodes.filter((n) => n.type === 'board').length + 1);
		const at = frame ? { x: frame.x, y: frame.y, w: Math.max(280, frame.w), h: Math.max(280, frame.w) / WB_FOLDER_AR } : (() => { const bb = wbBBox(nodes) || { x: 0, y: 0, w: 260, h: 160 }; return { x: bb.x, y: bb.y, w: 280, h: Math.round(280 / WB_FOLDER_AR) }; })();
		const rec = await this.plugin.createBoard(name, this.rec.guid); if (!rec) return;
		if (nodes.length) await this.moveSelectionToBoard(rec.guid, { nodes, toOrigin: true, quiet: true });
		this.pushHistory();
		if (frame) { this.scene.nodes = this.scene.nodes.filter((n) => n !== frame); this.scene.edges = this.scene.edges.filter((e) => e.from !== frame.id && e.to !== frame.id); }
		const card = wbNode('board', at.x, at.y, at.w, at.h, { recordGuid: rec.guid }); this.scene.nodes.push(card); this.selected = new Set([card.id]); this.selectedEdge = null;
		this.renderAll(); this.scheduleSave(); this.plugin.toast('Sub-board "' + name + '" created' + (nodes.length ? ' with ' + nodes.length + (nodes.length === 1 ? ' item' : ' items') : '') + '. Double-click the card to open it.');
	}
	// locked = stays where it is: no move, no resize, no delete; still selectable and editable
	toggleLock() {
		const sel = [...this.selected].map((id) => this.nodeById(id)).filter(Boolean); if (!sel.length) return;
		const lock = !sel.every((n) => n.locked); this.pushHistory(); for (const n of sel) n.locked = lock;
		this.renderAll(); this.scheduleSave();
	}
	deleteSelection() {
		if (this.selected.size && this.selected.size >= this.scene.nodes.length) this.userCleared = true; // deleting everything on purpose: the empty-board guard steps aside
		if (this.selectedEdge) { this.pushHistory(); this.scene.edges = this.scene.edges.filter((e) => e.id !== this.selectedEdge); this.selectedEdge = null; this.renderAll(); this.scheduleSave(); return; }
		if (!this.selected.size) return;
		const lockedIds = new Set([...this.selected].filter((id) => { const n = this.nodeById(id); return n && n.locked; }));
		if (lockedIds.size) { this.plugin.toast(lockedIds.size === this.selected.size ? 'Locked. Unlock it first to delete it.' : 'Locked items were kept.'); for (const id of lockedIds) this.selected.delete(id); if (!this.selected.size) { this.renderAll(); return; } }
		this.pushHistory();
		this.scene.nodes = this.scene.nodes.filter((n) => !this.selected.has(n.id)); this.scene.edges = this.scene.edges.filter((e) => !this.selected.has(e.from) && !this.selected.has(e.to));
		this.selected.clear(); this.renderAll(); this.scheduleSave();
	}
	// Cmd+C / Cmd+X: the selection (with the relations between its members) goes to the clipboard as text with a marker; Cmd+V pastes it at the pointer
	copySelection(cut) {
		const items = [...this.selected].map((id) => this.nodeById(id)).filter((n) => n && n.type !== 'note'); if (!items.length) { if (this.selected.size) this.plugin.toast('Note cards cannot be copied; they are pages.'); return; }
		const ids = new Set(items.map((n) => n.id)); const payload = { nodes: items.map((n) => JSON.parse(wbSceneJson(n))), edges: this.scene.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => Object.assign({}, e)) };
		const text = 'WBCLIP1' + JSON.stringify(payload); this.plugin.wbClip = text;
		try { navigator.clipboard.writeText(text).catch(() => {}); } catch (e) {}
		if (cut) { const locked = items.filter((n) => n.locked); if (locked.length) { this.plugin.toast('Locked items were copied, not cut.'); } this.pushHistory(); const gone = new Set(items.filter((n) => !n.locked).map((n) => n.id)); this.scene.nodes = this.scene.nodes.filter((n) => !gone.has(n.id)); this.scene.edges = this.scene.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to)); for (const id of gone) { const el = this.nodeEls.get(id); if (el) { el.remove(); this.nodeEls.delete(id); } } this.selected = new Set(); this.renderAll(); this.scheduleSave(); }
	}
	pasteClip(text) {
		let payload = null; try { payload = JSON.parse(text.slice(7)); } catch (e) { return false; } if (!payload || !Array.isArray(payload.nodes) || !payload.nodes.length) return false;
		const bb = wbBBox(payload.nodes); const r = this.canvas.getBoundingClientRect(); const at = this.lastPointer && this.lastPointer.inside ? this.lastPointer : this.toWorld(r.width / 2, r.height / 2);
		const dx = Math.round(at.x - bb.x - bb.w / 2), dy = Math.round(at.y - bb.y - bb.h / 2); const map = new Map(); this.pushHistory();
		for (const n of payload.nodes) { const c = Object.assign({}, n, { id: wbUid(), x: n.x + dx, y: n.y + dy }); map.set(n.id, c.id); this.scene.nodes.push(c); }
		for (const e of payload.edges || []) if (map.has(e.from) && map.has(e.to)) this.scene.edges.push(Object.assign({}, e, { id: wbUid(), from: map.get(e.from), to: map.get(e.to) }));
		this.selected = new Set([...map.values()]); this.selectedEdge = null; this.renderAll(); this.scheduleSave(); return true;
	}
	// one colour for a mixed selection: notes, frames, stacks and mind nodes take it as their colour, shapes as their fill, text as its background
	colorAll(items, id) {
		this.pushHistory(); const hex = id ? (String(id).startsWith('#') ? id : wbStickyColor(id).hex) : null;
		for (const n of items) { if (n.type === 'shape') { n.fill = hex || 'none'; n.textColor = hex ? wbContrastText(hex) : null; } else if (n.type === 'text') { n.bg = hex; } else { n.color = id || null; } }
		if (this.mmRecolorAll && items.some((n) => this.mmIsTree && this.mmIsTree(n.id))) this.mmRecolorAll(); // the branch lines follow the bubbles
		this.renderAll(); this.scheduleSave();
	}
	dupSelection() { const items = [...this.selected].map((id) => this.nodeById(id)).filter(Boolean); if (!items.length) return; this.pushHistory(); const copies = this.duplicateNodes(items, 24, 24); this.selected = new Set(copies.map((n) => n.id)); this.renderAll(); this.scheduleSave(); }

	// --- history + persistence --------------------------------------------------
	pushHistory() { this.undo.push(wbSceneJson(this.scene)); if (this.undo.length > 100) this.undo.shift(); this.redo = []; }
	undoOnce() { if (!this.undo.length) return; this.commitEdit(); this.redo.push(wbSceneJson(this.scene)); this.restore(this.undo.pop()); }
	redoOnce() { if (!this.redo.length) return; this.undo.push(wbSceneJson(this.scene)); this.restore(this.redo.pop()); }
	restore(json) { const view = this.scene.view; const snaps = new Map(this.scene.nodes.map((n) => [n.id, n._snap])); this.scene = JSON.parse(json); for (const n of this.scene.nodes) { const sp = snaps.get(n.id); if (sp) n._snap = sp; } this.scene.view = view; const ids = new Set(this.scene.nodes.map((n) => n.id)); this.selected = new Set([...this.selected].filter((id) => ids.has(id))); if (this.selectedEdge && !this.scene.edges.find((e) => e.id === this.selectedEdge)) this.selectedEdge = null; this.applyTheme(); this.applyBg(); this.renderAll(); this.scheduleSave(); }
	// "On this board" on the board's own page: one [[Page]] line per page card, per page a card is attached to and per
	// sub-board. Thymer then shows the board in each page's backreferences. Kept in sync a few seconds after each change.
	async syncBoardRefs() {
		if (this.destroyed || !wbSyncReady()) return; // derived from the scene: a stale scene would delete the refs of newer cards
		const want = new Set(); for (const n of this.scene.nodes) { if (n.type === 'card' && n.recordGuid) want.add(n.recordGuid); if (n.type === 'note' && n.recordGuid && n.recordGuid !== this.rec.guid) want.add(n.recordGuid); if (n.type === 'board' && n.recordGuid) want.add(n.recordGuid); }
		let items = []; try { items = (await this.rec.getLineItems()) || []; } catch (e) { return; }
		const txtOf = (li) => (li.segments || []).map((sg) => typeof sg.text === 'string' ? sg.text : '').join('').trim();
		const refOf = (li) => { const sg = (li.segments || []).find((x) => x.type === 'ref' && x.text && x.text.guid); return sg ? sg.text.guid : null; };
		let head = items.find((li) => this.plugin.isTopOf(li, this.rec) && liType(li) === 'heading' && txtOf(li) === WB_REFS_HEADING);
		const kids = head ? items.filter((li) => liRaw(li).pguid === liGuid(head)) : [];
		const have = new Map(); for (const li of kids) { const g = refOf(li); if (g) have.set(g, li); }
		const missing = [...want].filter((g) => !have.has(g)); const extra = kids.filter((li) => { const g = refOf(li); return !g || !want.has(g); });
		if (!missing.length && !extra.length && (head || !want.size)) return;
		if (!head && want.size) { const tops = items.filter((li) => this.plugin.isTopOf(li, this.rec)); try { head = await this.rec.createLineItem(null, tops.length ? tops[tops.length - 1] : null, 'heading', [{ type: 'text', text: WB_REFS_HEADING }], null); } catch (e) { head = null; } if (!head) return; }
		for (const li of extra) { try { await li.delete(); } catch (e) {} }
		let last = kids.filter((li) => !extra.includes(li)).pop() || null;
		for (const g of missing) { try { const li = await this.rec.createLineItem(head, last, 'text', [{ type: 'ref', text: { guid: g } }], null); if (li) last = li; } catch (e) {} }
		if (head && !want.size) { try { for (const li of kids) await li.delete(); await head.delete(); } catch (e) {} }
	}
	// The debounce used to restart on every change, so a long unbroken stretch of work was never written at all.
	// Now it has a ceiling (WB_SAVE_MAX) and a local copy goes to memory + IndexedDB within half a second regardless.
	scheduleSave(viewOnly) {
		if (this.saveT) clearTimeout(this.saveT);
		if (!viewOnly) {
			if (this.refsT) clearTimeout(this.refsT); this.refsT = setTimeout(() => { this.refsT = null; this.syncBoardRefs().catch(() => {}); }, 4000);
			this.markDirty(); this.snapLocal(); if (!this.dirtySince) this.dirtySince = Date.now();
			if (this.bannerT) clearTimeout(this.bannerT); this.bannerT = setTimeout(() => { this.bannerT = null; this.updateBanner().catch(() => {}); }, 20000);
		}
		const due = this.dirtySince && Date.now() - this.dirtySince >= WB_SAVE_MAX;
		const wait = viewOnly ? 3000 : due ? Math.max(0, 1200 - (Date.now() - (this.lastSaveAt || 0))) : 700;
		this.saveT = setTimeout(() => { this.saveT = null; if (!viewOnly) this.dirtySince = 0; this.persist(viewOnly); }, wait);
	}
	// A copy of the scene that costs nothing (no network): memory for a plugin reload, IndexedDB for an app restart.
	snapLocal(now) {
		const write = () => { if (this.destroyed && !now) return; try { const json = wbSceneJson(this.scene); const rev = Math.max(this.scene.rev || 0, this.knownRev || 0); wbCachePut(this.rec.guid, { rev, json, at: Date.now(), pending: true }); wbPendingPut(this.rec.guid, rev, json, this.scene.nodes.length); } catch (e) {} };
		if (now) { if (this.snapT) { clearTimeout(this.snapT); this.snapT = null; } write(); return; }
		if (this.snapT) return; this.snapT = setTimeout(() => { this.snapT = null; write(); }, 500);
	}
	// A 1200x400 picture of the board (frames, notes, cards, edges as shapes on the board colour) as the record's banner:
	// the Boards collection's gallery and the board page then preview the content.
	renderBannerBlob() { const cv = document.createElement('canvas'); cv.width = 1200; cv.height = 400; wbPaintScene(cv, this.scene); return new Promise((res) => cv.toBlob(res, 'image/png')); }
	async updateBanner() {
		if (this.destroyed || !this.scene.nodes.length || !wbSyncReady()) return false;
		const key = wbSceneJson({ n: this.scene.nodes.map((n) => [n.id, n.type, Math.round(n.x), Math.round(n.y), Math.round(n.w), Math.round(n.h), n.color || '']), e: this.scene.edges.length, c: (this.scene.settings || {}).bgColor || '' });
		if (key === this._bannerKey) return false; this._bannerKey = key;
		const blob = await this.renderBannerBlob(); if (!blob) return false;
		try { await this.rec.setBannerFromBlob(blob); return true; } catch (e) { console.warn('[Whiteboard] banner', e); return false; }
	}
	flush() { if (this.saveT) { clearTimeout(this.saveT); this.saveT = null; return this.persist(); } return this.savePromise || Promise.resolve(); }
	// --- persistence with a safety net: local backup, retries, conflict and empty-board guards, a visible state ---
	markDirty() { this.dirty = true; if (!this.dirtyT) this.dirtyT = setTimeout(() => { this.dirtyT = null; if (this.dirty) this.setSaveState('dirty'); }, 2500); }
	persist(viewOnly) {
		if (this.destroyed) return this.savePromise || Promise.resolve(); // a torn-down board is not allowed to write; its last state is in the local copy
		try { this.plugin.watchSync(); } catch (e) {} // the 1 s watcher is throttled in a hidden window; every save attempt checks too
		if (this.saving) { this.dirtyAgain = true; if (!viewOnly) this.dirtyAgainReal = true; return this.savePromise || Promise.resolve(); }
		const n = this.scene.nodes.length;
		if (n === 0 && (this.lastSavedNodes || 0) > 2 && !this.userCleared) { this.setSaveState('refused'); return Promise.resolve(); } // an empty scene after a full one is far more likely a bug than an intent
		// 2026-09-25: a stale web client wrote 179 nodes over 417. The collapse rule that guards a LOAD now guards a save too: five
		// times fewer items than the last saved state is refused until the user clears the board on purpose (or keeps theirs).
		if (n > 0 && (this.lastSavedNodes || 0) > 10 && n * 5 < this.lastSavedNodes && !this.userCleared) { this.setSaveState('refused'); console.warn('[Whiteboard] refusing to save ' + n + ' nodes over ' + this.lastSavedNodes); return Promise.resolve(); }
		this.saving = true; this.lastSaveAt = Date.now(); this.setSaveState(this.dirty ? 'saving' : null);
		const force = this.forceOnce; this.forceOnce = false;
		this.savePromise = this.plugin.saveScene(this.rec, this.scene, this, { noBackup: !!viewOnly && !this.dirty, force, viewOnly: !!viewOnly }).then((r) => {
			this.saving = false;
			if (r && r.ok) { this._waitSince = 0; this.dirty = false; this.retryN = 0; this.lastSavedNodes = n; this.userCleared = false; this.setSaveState(null); return; }
			if (r && r.conflict) {
				// another device saved first: take its version in and merge, then save the merge. The bar is only for a server copy
				// that could not be read or merged (and for the stale-device guard, whose record is not ahead).
				const before = this.knownRev || 0;
				return this.pullRemote('conflict').then(() => { if (this.destroyed) return; if ((this.knownRev || 0) > before) { if (this.dirty) this.scheduleSave(); else this.setSaveState(null); } else if (!this._pullT) this.setSaveState('conflict'); });
			}
			if (r && r.fatal) { this.setSaveState('failed'); return; }
			if (r && r.wait) { if (!this._waitSince) this._waitSince = Date.now(); if (Date.now() - this._waitSince > 5000) this.plugin.syncPing(); this.setSaveState('waiting'); if (this.retryT) clearTimeout(this.retryT); this.retryT = setTimeout(() => { this.retryT = null; this.persist(viewOnly); }, 2000); return; }
			this.retryN = (this.retryN || 0) + 1; this.setSaveState('failed');
			const wait = Math.min(60000, 2000 * Math.pow(2, this.retryN - 1)); if (this.retryT) clearTimeout(this.retryT); this.retryT = setTimeout(() => { this.retryT = null; this.persist(); }, wait);
		}).catch(() => { this.saving = false; this.retryN = (this.retryN || 0) + 1; this.setSaveState('failed'); this.retryT = setTimeout(() => { this.retryT = null; this.persist(); }, Math.min(60000, 2000 * Math.pow(2, this.retryN - 1))); })
		.then(() => { if (this.dirtyAgain) { this.dirtyAgain = false; const real = this.dirtyAgainReal; this.dirtyAgainReal = false; return this.persist(!real); } });
		const g = this.rec.guid, pr = this.savePromise; WB_INFLIGHT.set(g, pr); pr.then(() => { if (WB_INFLIGHT.get(g) === pr) WB_INFLIGHT.delete(g); }, () => { if (WB_INFLIGHT.get(g) === pr) WB_INFLIGHT.delete(g); });
		return this.savePromise;
	}
	setSaveState(state) {
		this.saveState = state; if (this.destroyed || !this.host) return;
		let bar = this.saveBar; if (!bar) { bar = wbEl('div', 'wb-zoom wb-savebar'); bar.addEventListener('pointerdown', (e) => e.stopPropagation()); this.host.appendChild(bar); this.saveBar = bar; }
		const msgs = { dirty: ['Unsaved changes', 'Changes are saved automatically a moment after you stop'], saving: ['Saving', 'Uploading the board'], failed: ['Not saved yet, retrying', 'The upload failed (offline?). The board keeps trying; a copy is kept on this device'], conflict: ['Newer version on the server', 'This board was saved from somewhere else. Click to reload it; your changes are kept as a local version under Restore an earlier version'], waiting: ['Waiting for sync', 'Thymer has not finished syncing with the server yet. Nothing is uploaded until it has, so an older copy on this device can never overwrite newer work. Your changes are kept on this device meanwhile'], refused: ['Empty board not saved', 'The board became empty; it was not written over the saved version. Delete everything on purpose to clear it'] };
		if (!state) { bar.hidden = true; return; }
		if (state === 'saving') { if (bar.hidden) return; } // 'Saving' only replaces a visible 'Unsaved changes'; a quiet save stays quiet
		const m = msgs[state] || msgs.dirty; bar.hidden = false; bar.className = 'wb-zoom wb-savebar is-' + state; bar.innerHTML = '<span class="wb-savedot"></span><span>' + m[0] + '</span>'; bar.title = m[1];
		bar.onclick = null;
		if (state === 'conflict') {
			const btn = (label, title, fn) => { const b = wbEl('button', 'wb-savebtn', label); b.title = title; b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); bar.appendChild(b); };
			btn('Reload', 'Throw away what is on screen and open the version that is on the server', () => this.plugin.openBoard(this.rec.guid, this.panel));
			btn('Keep mine', 'Write what is on screen over the version on the server (the server version stays under Restore an earlier version)', async () => {
				try { const cur = await this.plugin.loadScene(this.rec); if (cur) await wbBackupPut(this.rec.guid, (cur.rev || 0), wbSceneJson(cur), cur.nodes.length); } catch (e) {} // the version being overwritten becomes a restore point first
				this.forceOnce = true; this.knownRev = 0; this.persist();
			});
		}
	}
	// Live sync: another device saved this board. Read-only until the merge is applied; anything that must go up again goes through
	// persist, the sync gate and the revision check like every other save. A device with nothing unsaved takes the server copy as is
	// and uploads nothing (so two open devices never answer each other's saves); only real unsaved edits are merged and saved.
	async pullRemote(why) {
		if (this.destroyed) return;
		if (this._pulling) { this._pullAgain = true; return; }
		const busy = () => this.saving || this.editing || this.drag || this.nativeEdit || this._noteEditor;
		if (busy()) { if (this._pullT) clearTimeout(this._pullT); this._pullT = setTimeout(() => { this._pullT = null; this.pullRemote(why); }, 500); return; }
		this._pulling = true;
		try {
			const fresh = await this.plugin.record(this.rec.guid); if (!fresh || this.destroyed) return;
			const got = await this.plugin.serverScene(fresh, this.blobGuid); if (!got || got.same || this.destroyed) return; // same file as last time: nothing new (our own save's event lands here)
			const remote = got.scene; const rid = remote.saveId || null;
			if (rid) { if (rid === this.baseId || (this.versions && this.versions.has(rid))) { this.blobGuid = got.blobGuid; return; } } // a version we already have (or an older one)
			else if ((remote.rev || 0) <= (this.knownRev || 0)) return; // a scene saved before version ids existed: the revision decides
			if (busy()) { this._pullAgain = true; return; }
			const rJson = wbSceneJson(remote);
			// Which state was the remote built on? If its lineage holds our base, it simply continues from us. If not, the two saves
			// were concurrent: merge against the newest common ancestor we still hold, so what we uploaded is not taken for deleted.
			// No common ancestor at all means the other device was out of step: nothing is merged automatically, the bar asks.
			let baseJ = this.baseJson, concurrent = false;
			if (rid && this.baseId && !(remote.hist || []).includes(this.baseId)) {
				const anc = (remote.hist || []).slice().reverse().find((id) => this.versions && this.versions.has(id));
				if (!anc) { console.warn('[Whiteboard] remote version ' + rid + ' shares no known ancestor with ours (' + this.baseId + '): not merged'); wbTrace('pull no ancestor ' + this.rec.guid.slice(0, 6)); try { await wbBackupPut(this.rec.guid, remote.rev || 0, rJson, remote.nodes.length); } catch (e) {} this.setSaveState('conflict'); return; }
				baseJ = this.versions.get(anc); concurrent = true;
			}
			let next = remote, merged = false;
			if (this.dirty || concurrent) {
				let base = null; try { base = baseJ ? JSON.parse(baseJ) : null; } catch (e) {}
				if (!base) { console.warn('[Whiteboard] no merge base, the conflict bar decides'); this.setSaveState('conflict'); return; }
				next = wbMergeScene(base, JSON.parse(wbSceneJson(this.scene)), remote); merged = true;
			}
			const key = (sc) => { const o = Object.assign({}, sc); for (const k of ['rev', 'savedAt', 'view', 'saveId', 'hist']) delete o[k]; return wbSceneJson(o); };
			const changed = merged && key(next) !== key(remote); // the merge added something of ours: it has to go up again
			this.applyRemote(next, remote, rJson, got.blobGuid);
			wbTrace('pulled ' + (why || '') + ' ' + this.rec.guid.slice(0, 6) + ' ->' + remote.rev + (concurrent ? ' concurrent' : '') + (changed ? ' merged' : ''));
			if (changed) { this.markDirty(); this.snapLocal(); this.scheduleSave(); }
			else { if (this.saveT) { clearTimeout(this.saveT); this.saveT = null; } this.dirtySince = 0; this.dirty = false; this.setSaveState(null); wbCachePut(this.rec.guid, { rev: remote.rev || 0, json: rJson, at: remote.savedAt || 0, pending: false }); wbPendingDel(this.rec.guid); }
		} catch (e) { console.warn('[Whiteboard] pull', e); }
		finally { this._pulling = false; if (this._pullAgain && !this.destroyed) { this._pullAgain = false; if (this._pullT) clearTimeout(this._pullT); this._pullT = setTimeout(() => { this._pullT = null; this.pullRemote(why); }, 300); } }
	}
	rememberVersion(id, json) { if (!id || !json) return; this.versions = this.versions || new Map(); this.versions.set(id, json); while (this.versions.size > 12) this.versions.delete(this.versions.keys().next().value); }
	applyRemote(next, remote, rJson, blobGuid) {
		const snaps = new Map(this.scene.nodes.map((n) => [n.id, n._snap])); const view = this.scene.view;
		this.scene = Object.assign(wbNewScene(), next); for (const n of this.scene.nodes) { const sp = snaps.get(n.id); if (sp) n._snap = sp; }
		this.knownRev = Math.max(this.knownRev || 0, remote.rev || 0); this.scene.view = view; this.scene.rev = this.knownRev;
		this.baseJson = rJson; this.baseId = remote.saveId || null; this.baseHist = remote.hist || []; this.blobGuid = blobGuid || this.blobGuid; this.rememberVersion(remote.saveId, rJson); this.lastSavedNodes = (remote.nodes || []).length;
		try { const mx = Math.max(this.knownRev, parseInt(localStorage.getItem('wb_maxrev_' + this.rec.guid) || '0', 10) || 0); localStorage.setItem('wb_maxrev_' + this.rec.guid, String(mx)); } catch (e) {}
		const ids = new Set(this.scene.nodes.map((n) => n.id)); this.selected = new Set([...this.selected].filter((id) => ids.has(id))); if (this.selectedEdge && !this.scene.edges.find((e) => e.id === this.selectedEdge)) this.selectedEdge = null;
		this.applyTheme(); this.applyBg(); this.renderAll();
	}
	destroy() { if (this.nativeEdit) this.endNativeEdit(true); this.commitEdit(); if (this.staleReload) { if (this.saveT) { clearTimeout(this.saveT); this.saveT = null; } this.finalSave = Promise.resolve(); } else { this.snapLocal(true); this.finalSave = this.flush(); } this.destroyed = true;
		for (const t of ['retryT', 'refsT', 'bannerT', 'dirtyT', 'snapT', '_pullT', '_pullEvT', '_linesT']) { if (this[t]) { clearTimeout(this[t]); this[t] = null; } } for (const el of (this.chromeEls || [])) el.remove(); this.chromeEls = []; for (const el of (this.collChromeEls || [])) el.remove(); this.collChromeEls = []; for (const d of this.disposers) { try { d(); } catch (e) {} } this.disposers = []; if (this.ctx) { this.ctx.remove(); this.ctx = null; } for (const u of this.imgUrls.values()) { try { URL.revokeObjectURL(u); } catch (e) {} } }

	// Stacking order (his ask 2026-09-26). The scene's node order IS the paint order; the DOM is re-appended to match.
	reorderZ(sel, mode) {
		const ids = new Set(sel.map((n) => n.id)); const nodes = this.scene.nodes; const picked = nodes.filter((n) => ids.has(n.id)); if (!picked.length) return;
		this.pushHistory(); let out;
		if (mode === 'zfront') out = nodes.filter((n) => !ids.has(n.id)).concat(picked);
		else if (mode === 'zback') out = picked.concat(nodes.filter((n) => !ids.has(n.id)));
		else { out = nodes.slice(); const idx = out.map((n, i) => (ids.has(n.id) ? i : -1)).filter((i) => i >= 0); if (mode === 'zup') { for (let k = idx.length - 1; k >= 0; k--) { const i = idx[k]; if (i + 1 < out.length && !ids.has(out[i + 1].id)) { const t = out[i]; out[i] = out[i + 1]; out[i + 1] = t; } } } else { for (const i of idx) { if (i > 0 && !ids.has(out[i - 1].id)) { const t = out[i]; out[i] = out[i - 1]; out[i - 1] = t; } } } }
		this.scene.nodes = out;
		for (const n of out) { const el = this.nodeEls.get(n.id); if (el && el.parentNode === this.nodes) this.nodes.appendChild(el); }
		this.renderAll(); this.scheduleSave();
	}
	// --- context toolbar ----------------------------------------------------------
	// Line thickness (his ask 2026-09-22): one menu for relation lines and for shape borders. The rows draw the width itself.
	widthMenu(anchor, cur, onPick) {
		const rows = [[1, 'Thin'], [1.5, 'Regular'], [2.5, 'Medium'], [4, 'Thick'], [6, 'Heavy']].map(([v, label]) => ({ v: String(v), label, svg: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="' + Math.min(6, v * 1.3) + '"><path d="M3 12h18"></path></svg>' }));
		this.menu(anchor, rows, String(cur || 1.5), (v) => onPick(Number(v)));
	}
	styleSel(patch) {
		if (this.editing) { const el = this.nodeEls.get(this.editing); const txt = el && el.querySelector('.wb-txt'); const sel = window.getSelection(); if (txt && sel && sel.rangeCount && !sel.isCollapsed && txt.contains(sel.anchorNode)) { const cmd = { bold: 'bold', italic: 'italic', underline: 'underline', strike: 'strikeThrough' }; for (const k in patch) { if (cmd[k]) document.execCommand(cmd[k]); else if (k === 'hilite') document.execCommand('hiliteColor', false, patch[k] || 'transparent'); else if (k === 'textColor') document.execCommand('foreColor', false, patch[k] || 'inherit'); } return; } }
		const items = [...this.selected].map((id) => this.nodeById(id)).filter(Boolean); if (!items.length) return;
		this.pushHistory();
		for (const n of items) for (const k in patch) { if (patch[k] === 'toggle') n[k] = !n[k]; else n[k] = patch[k]; }
		this.renderAll(); this.scheduleSave();
	}
	styleEdge(patch) { const e = this.scene.edges.find((x) => x.id === this.selectedEdge); if (!e) return; if ('color' in patch && e.mm && this.mmSetBranchColor) { this.mmSetBranchColor(e, patch.color); return; } if (e.mm && patch.route && this.mmRootOf) { const root = this.mmRootOf(e.to); if (root) { this.mmSetLine(root, patch.route); return; } } if ('width' in patch && e.mm && this.mmRootOf) { const root = this.mmRootOf(e.to); if (root) { const ids = new Set([root.id].concat(this.mmDescendants(root.id))); this.pushHistory(); for (const x of this.scene.edges) if (x.mm && ids.has(x.to)) x.width = patch.width; this.renderEdges(); this.buildCtx(); this.scheduleSave(); return; } } this.pushHistory(); Object.assign(e, patch); this.renderEdges(); this.buildCtx(); this.scheduleSave(); }
	tb(html, title, fn, on) { const b = wbEl('div', 'wb-tb' + (on ? ' is-on' : ''), html); if (title) b.title = title; b.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); }); b.addEventListener('click', (e) => { e.stopPropagation(); fn(b); }); return b; }
	sep() { return wbEl('div', 'wb-tsep'); }
	// The colour control sits FIRST in every element toolbar, followed by a separator. Built branch by branch it had drifted:
	// first for a post-it, second for a shape or a frame, last for a bubble or a folder. One rule beats editing eight branches,
	// and it also catches the toolbars the overrides add later. Runs after the whole override chain has built the bar.
	hoistColor() {
		const c = this.ctx; if (!c) return;
		const dot = [...c.children].find((b) => b.classList && b.classList.contains('wb-tb') && b.querySelector('.wb-cdot'));
		if (dot && dot !== c.firstElementChild) { c.insertBefore(dot, c.firstElementChild); c.insertBefore(this.sep(), dot.nextSibling); }
		let prev = null; // no separator at either end, and never two in a row after the move
		for (const el of [...c.children]) { const isSep = el.classList.contains('wb-tsep'); if (isSep && (!prev || prev.classList.contains('wb-tsep'))) { el.remove(); continue; } prev = el; }
		while (c.lastElementChild && c.lastElementChild.classList.contains('wb-tsep')) c.lastElementChild.remove();
	}
	// Text size control: type any number, arrows step, the chevron lists presets. 'auto' allowed for stickies.
	sizeCtl(value, allowAuto, apply) {
		const box = wbEl('div', 'wb-size'); box.addEventListener('pointerdown', (e) => e.stopPropagation());
		const inp = document.createElement('input'); inp.value = value === 'auto' ? 'Auto' : String(value); inp.title = 'Text size';
		const commit = () => { const raw = inp.value.trim().toLowerCase(); if (allowAuto && (raw === 'auto' || raw === 'a' || raw === '')) { if (value !== 'auto') apply('auto'); return; } const n = Math.round(parseFloat(raw)); if (n >= 6 && n <= 400) { if (n !== value) apply(n); } else inp.value = value === 'auto' ? 'Auto' : String(value); };
		const step = (d) => { const cur = value === 'auto' ? 15 : Number(value) || 15; apply(wbClamp(cur + d, 6, 400)); };
		inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'ArrowUp') { e.preventDefault(); step(e.shiftKey ? 10 : 1); } else if (e.key === 'ArrowDown') { e.preventDefault(); step(e.shiftKey ? -10 : -1); } });
		inp.addEventListener('focus', () => inp.select()); inp.addEventListener('blur', commit); inp.addEventListener('click', (e) => e.stopPropagation());
		box.appendChild(inp);
		const st = wbEl('div', 'wb-step'); const up = wbEl('div', '', WB_SVG('<path d="M6 15l6-6 6 6"></path>')); const dn = wbEl('div', '', WB_SVG('<path d="M6 9l6 6 6-6"></path>'));
		up.addEventListener('click', (e) => { e.stopPropagation(); step(1); }); dn.addEventListener('click', (e) => { e.stopPropagation(); step(-1); }); st.appendChild(up); st.appendChild(dn); box.appendChild(st);
		const presets = this.tb(WB_I.chev, 'Presets', (b) => { const opts = allowAuto ? [{ v: 'auto', label: 'Auto' }] : []; for (const s of [10, 12, 14, 15, 18, 24, 36, 48, 64, 80, 144]) opts.push({ v: s, label: String(s) }); this.menu(b, opts, value, (v) => apply(v === 'auto' ? 'auto' : Number(v)), { width: 110 }); });
		presets.style.minWidth = '18px'; presets.style.padding = '0 2px'; box.appendChild(presets);
		return box;
	}
	menu(anchor, items, current, onPick, cfg) { wbMenu(anchor, items, current, onPick, Object.assign({ dots: false, width: 180 }, cfg || {})); }
	alignPop(anchor, sel) {
		this.plugin.closeMenus();
		const pop = wbEl('div', 'wb-pop'); pop.style.width = '176px'; pop.style.gap = '2px'; pop.addEventListener('pointerdown', (e) => e.stopPropagation());
		const bb = wbBBox(sel); const run = (fn) => { this.plugin.closeMenus(); this.pushHistory(); fn(); this.renderAll(); this.scheduleSave(); };
		const I = {
			l: WB_SVG('<path d="M4 4v16"></path><rect x="7" y="7" width="12" height="4" fill="currentColor" stroke="none"></rect><rect x="7" y="13" width="8" height="4" fill="currentColor" stroke="none"></rect>'),
			c: WB_SVG('<path d="M12 4v16"></path><rect x="5" y="7" width="14" height="4" fill="currentColor" stroke="none"></rect><rect x="8" y="13" width="8" height="4" fill="currentColor" stroke="none"></rect>'),
			r: WB_SVG('<path d="M20 4v16"></path><rect x="5" y="7" width="12" height="4" fill="currentColor" stroke="none"></rect><rect x="9" y="13" width="8" height="4" fill="currentColor" stroke="none"></rect>'),
			dh: WB_SVG('<path d="M3 4v16"></path><path d="M21 4v16"></path><rect x="8" y="8" width="3" height="8" fill="currentColor" stroke="none"></rect><rect x="13" y="8" width="3" height="8" fill="currentColor" stroke="none"></rect>'),
			t: WB_SVG('<path d="M4 4h16"></path><rect x="7" y="7" width="4" height="12" fill="currentColor" stroke="none"></rect><rect x="13" y="7" width="4" height="8" fill="currentColor" stroke="none"></rect>'),
			m: WB_SVG('<path d="M4 12h16"></path><rect x="7" y="5" width="4" height="14" fill="currentColor" stroke="none"></rect><rect x="13" y="8" width="4" height="8" fill="currentColor" stroke="none"></rect>'),
			b: WB_SVG('<path d="M4 20h16"></path><rect x="7" y="5" width="4" height="12" fill="currentColor" stroke="none"></rect><rect x="13" y="9" width="4" height="8" fill="currentColor" stroke="none"></rect>'),
			dv: WB_SVG('<path d="M4 3h16"></path><path d="M4 21h16"></path><rect x="8" y="8" width="8" height="3" fill="currentColor" stroke="none"></rect><rect x="8" y="13" width="8" height="3" fill="currentColor" stroke="none"></rect>'),
			row: WB_SVG('<rect x="3" y="8" width="5" height="8" fill="currentColor" stroke="none"></rect><rect x="9.5" y="8" width="5" height="8" fill="currentColor" stroke="none"></rect><rect x="16" y="8" width="5" height="8" fill="currentColor" stroke="none"></rect>'),
			col: WB_SVG('<rect x="8" y="3" width="8" height="5" fill="currentColor" stroke="none"></rect><rect x="8" y="9.5" width="8" height="5" fill="currentColor" stroke="none"></rect><rect x="8" y="16" width="8" height="5" fill="currentColor" stroke="none"></rect>'),
			grid: WB_SVG('<rect x="4" y="4" width="6" height="6" fill="currentColor" stroke="none"></rect><rect x="14" y="4" width="6" height="6" fill="currentColor" stroke="none"></rect><rect x="4" y="14" width="6" height="6" fill="currentColor" stroke="none"></rect><rect x="14" y="14" width="6" height="6" fill="currentColor" stroke="none"></rect>'),
		};
		const distH = () => { const s2 = [...sel].sort((a, b) => a.x - b.x); if (s2.length < 3) return; const total = s2.reduce((t, n) => t + n.w, 0); const gap = (bb.w - total) / (s2.length - 1); let x = bb.x; for (const n of s2) { n.x = Math.round(x); x += n.w + gap; } };
		const distV = () => { const s2 = [...sel].sort((a, b) => a.y - b.y); if (s2.length < 3) return; const total = s2.reduce((t, n) => t + n.h, 0); const gap = (bb.h - total) / (s2.length - 1); let y = bb.y; for (const n of s2) { n.y = Math.round(y); y += n.h + gap; } };
		const items = [
			['Align left', I.l, () => sel.forEach((n) => { n.x = bb.x; })], ['Align center', I.c, () => sel.forEach((n) => { n.x = bb.x + (bb.w - n.w) / 2; })], ['Align right', I.r, () => sel.forEach((n) => { n.x = bb.x + bb.w - n.w; })], ['Distribute horizontally', I.dh, distH],
			['Align top', I.t, () => sel.forEach((n) => { n.y = bb.y; })], ['Align middle', I.m, () => sel.forEach((n) => { n.y = bb.y + (bb.h - n.h) / 2; })], ['Align bottom', I.b, () => sel.forEach((n) => { n.y = bb.y + bb.h - n.h; })], ['Distribute vertically', I.dv, distV],
			['Arrange in a row', I.row, () => { const s2 = [...sel].sort((a, b) => a.x - b.x); let x = bb.x; for (const n of s2) { n.x = x; n.y = bb.y; x += n.w + 24; } }],
			['Arrange in a column', I.col, () => { const s2 = [...sel].sort((a, b) => a.y - b.y); let y = bb.y; for (const n of s2) { n.y = y; n.x = bb.x; y += n.h + 24; } }],
			['Arrange in a grid', I.grid, () => { const s2 = [...sel].sort((a, b) => (a.y - b.y) || (a.x - b.x)); const cols = Math.ceil(Math.sqrt(s2.length)); const cw = Math.max(...s2.map((n) => n.w)) + 24, ch = Math.max(...s2.map((n) => n.h)) + 24; s2.forEach((n, i) => { n.x = bb.x + (i % cols) * cw; n.y = bb.y + Math.floor(i / cols) * ch; }); }],
		];
		items.forEach(([title, icon, fn], i) => { const fi = wbEl('div', 'wb-fi', icon); fi.title = title; if (i === 8) fi.style.gridColumn = '1'; fi.addEventListener('click', (e) => { e.stopPropagation(); run(fn); }); pop.appendChild(fi); });
		this.host.appendChild(pop); const r = anchor.getBoundingClientRect(); const hr = this.host.getBoundingClientRect();
		pop.style.left = Math.max(hr.left + 8, Math.min(r.left, hr.right - pop.offsetWidth - 8)) + 'px'; pop.style.top = (r.bottom + 6) + 'px';
		this.plugin._pop = pop;
		const out = (e) => { if (!pop.contains(e.target)) this.plugin.closeMenus(); }; document.addEventListener('pointerdown', out, true); pop._out = out;
	}
	shapePop(anchor, current, onPick) {
		this.plugin.closeMenus();
		const pop = wbEl('div', 'wb-pop'); pop.style.width = '168px'; pop.style.gap = '2px'; pop.addEventListener('pointerdown', (e) => e.stopPropagation());
		for (const k of WB_SHAPES) { const fi = wbEl('div', 'wb-fi' + (k === current ? ' is-on' : ''), WB_SHAPE_ICON[k]); fi.title = k.charAt(0).toUpperCase() + k.slice(1); fi.addEventListener('click', (e) => { e.stopPropagation(); this.plugin.closeMenus(); onPick(k); }); pop.appendChild(fi); }
		this.host.appendChild(pop); const r = anchor.getBoundingClientRect(); const hr = this.host.getBoundingClientRect();
		pop.style.left = Math.max(hr.left + 8, Math.min(r.left, hr.right - pop.offsetWidth - 8)) + 'px'; pop.style.top = (r.bottom + 6) + 'px';
		this.plugin._pop = pop;
		const out = (e) => { if (!pop.contains(e.target)) this.plugin.closeMenus(); }; document.addEventListener('pointerdown', out, true); pop._out = out;
	}
	colorPop(anchor, current, onPick, cfg) {
		cfg = cfg || {}; this.plugin.closeMenus();
		const pop = wbEl('div', 'wb-pop'); pop.addEventListener('pointerdown', (e) => e.stopPropagation());
		if (cfg.auto) { const a = wbEl('div', 'wb-sw wb-sw-auto' + (!current ? ' is-on' : '')); a.title = cfg.auto; a.addEventListener('click', (e) => { e.stopPropagation(); this.plugin.closeMenus(); onPick(null); }); pop.appendChild(a); }
		for (const c of WB_STICKY_COLORS) { const sw = wbEl('div', 'wb-sw' + (c.id === current ? ' is-on' : '')); sw.style.background = c.hex; sw.title = c.id; sw.addEventListener('click', (e) => { e.stopPropagation(); this.plugin.closeMenus(); onPick(c.id); }); pop.appendChild(sw); }
		pop.classList.add('wb-pop-wheel');
		const cur = (current && String(current).startsWith('#')) ? current : (current ? wbStickyColor(current).hex : null); const hsl = wbHexHsl(cur) || { h: 40, s: 0.7, l: 0.6 };
		const wheel = wbEl('div', 'wb-wheel'); const cv = document.createElement('canvas'); cv.width = 280; cv.height = 280; cv.className = 'wb-wheelcv'; const mark = wbEl('div', 'wb-wheelmark'); wheel.appendChild(cv); wheel.appendChild(mark);
		const light = document.createElement('input'); light.type = 'range'; light.min = '5'; light.max = '95'; light.value = String(Math.round(hsl.l * 100)); light.className = 'wb-wheellight'; light.title = 'Lightness';
		const row = wbEl('div', 'wb-custom'); const inp = document.createElement('input'); inp.placeholder = '#hex'; inp.value = cur || ''; const prev = wbEl('span', 'wb-sw wb-wheelprev'); prev.style.background = cur || 'transparent'; row.appendChild(prev); row.appendChild(inp);
		// pick a colour from anywhere on the screen. The eyedropper is a browser API here; where it is missing the OS colour
		// panel is opened instead, which has its own magnifier.
		const drop = wbEl('div', 'wb-eyedrop', WB_SVG('<path d="M15.5 4.5l4 4"></path><path d="M17 7L7.5 16.5 4 17.5l1-3.5L14.5 4.5a1.8 1.8 0 012.5 2.5z"></path>'));
		drop.title = 'Pick a colour from the screen';
		drop.addEventListener('click', async (ev) => {
			ev.stopPropagation();
			const apply = (hex) => { const h2 = wbHexHsl(hex); if (!h2) return; st.h = h2.h; st.s = h2.s; st.l = h2.l; light.value = String(Math.round(st.l * 100)); draw(); place(); inp.value = hex; prev.style.background = hex; onPick(hex); };
			if (window.EyeDropper) { pop._picking = true; try { const got = await new window.EyeDropper().open(); if (got && got.sRGBHex) apply(String(got.sRGBHex).toLowerCase()); } catch (x) {} pop._picking = false; return; }
			const ci = document.createElement('input'); ci.type = 'color'; ci.value = /^#[0-9a-f]{6}$/i.test(inp.value || '') ? inp.value : '#65c8bb';
			ci.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
			pop.appendChild(ci); pop._picking = true;
			ci.addEventListener('input', () => apply(ci.value));
			ci.addEventListener('change', () => { apply(ci.value); pop._picking = false; ci.remove(); });
			ci.click();
		});
		row.appendChild(drop);
		const st = { h: hsl.h, s: hsl.s, l: hsl.l };
		const draw = () => { const g = cv.getContext('2d'); const img = g.createImageData(280, 280); const d = img.data; const R = 140; for (let y = 0; y < 280; y++) for (let x = 0; x < 280; x++) { const dx = x - R, dy = y - R; const r = Math.hypot(dx, dy) / R; const i = (y * 280 + x) * 4; if (r > 1) { d[i + 3] = 0; continue; } const h = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360; const hex = wbHslHex(h, Math.min(1, r), st.l); d[i] = parseInt(hex.slice(1, 3), 16); d[i + 1] = parseInt(hex.slice(3, 5), 16); d[i + 2] = parseInt(hex.slice(5, 7), 16); d[i + 3] = r > 0.985 ? Math.round((1 - r) / 0.015 * 255) : 255; } g.putImageData(img, 0, 0); };
		const place = () => { const a = st.h * Math.PI / 180; const rr = st.s * 70; mark.style.left = (70 + Math.cos(a) * rr) + 'px'; mark.style.top = (70 + Math.sin(a) * rr) + 'px'; const hex = wbHslHex(st.h, st.s, st.l); mark.style.background = hex; prev.style.background = hex; inp.value = hex; light.style.background = 'linear-gradient(90deg,#000,' + wbHslHex(st.h, st.s, 0.5) + ',#fff)'; };
		const fromPt = (e) => { const r = cv.getBoundingClientRect(); const dx = e.clientX - r.left - 70, dy = e.clientY - r.top - 70; st.h = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360; st.s = Math.min(1, Math.hypot(dx, dy) / 70); place(); };
		let dragging = false; cv.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); dragging = true; cv.setPointerCapture(e.pointerId); fromPt(e); }); cv.addEventListener('pointermove', (e) => { if (dragging) fromPt(e); }); cv.addEventListener('pointerup', (e) => { if (!dragging) return; dragging = false; fromPt(e); onPick(wbHslHex(st.h, st.s, st.l)); });
		light.addEventListener('input', () => { st.l = parseInt(light.value, 10) / 100; draw(); place(); }); light.addEventListener('change', () => onPick(wbHslHex(st.h, st.s, st.l))); light.addEventListener('pointerdown', (e) => e.stopPropagation()); light.addEventListener('keydown', (e) => e.stopPropagation());
		inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { const v = inp.value.trim().replace(/^([0-9a-f]{6})$/i, '#$1'); if (wbHexLum(v) != null) { this.plugin.closeMenus(); onPick(v); } } });
		draw(); place(); pop.appendChild(wheel); pop.appendChild(light); pop.appendChild(row);
		this.host.appendChild(pop); const r = anchor.getBoundingClientRect(); const hr = this.host.getBoundingClientRect();
		pop.style.left = Math.max(hr.left + 8, Math.min(r.left, hr.right - pop.offsetWidth - 8)) + 'px'; pop.style.top = Math.min(r.bottom + 6, hr.bottom - pop.offsetHeight - 8) + 'px';
		this.plugin._pop = pop;
		const out = (e) => { if (pop._picking) return; if (!pop.contains(e.target)) { this.plugin.closeMenus(); } }; document.addEventListener('pointerdown', out, true); pop._out = out;
	}
	buildCtx() {
		if (this.ctx) { this.ctx.remove(); this.ctx = null; }
		const sel = [...this.selected].map((id) => this.nodeById(id)).filter(Boolean);
		const edge = this.selectedEdge ? this.scene.edges.find((x) => x.id === this.selectedEdge) : null;
		if (!sel.length && !edge) return;
		const c = wbEl('div', 'wb-ctx'); c.addEventListener('pointerdown', (e) => e.stopPropagation());
		if (sel.length && sel.every((n) => n.locked)) { c.appendChild(this.tb(WB_I.lock + '<span>Locked</span>', 'Locked in place. Click to unlock', () => this.toggleLock(), true)); this.host.appendChild(c); this.ctx = c; this.placeCtx(); return; }
		const one = sel.length === 1 ? sel[0] : null;
		const allType = sel.length && sel.every((n) => n.type === sel[0].type) ? sel[0].type : null;
		const fontRow = (n) => {
			c.appendChild(this.sizeCtl(n.fontSize === 'auto' || !n.fontSize ? (n.type === 'sticky' ? 'auto' : 15) : n.fontSize, n.type === 'sticky', (v) => this.styleSel({ fontSize: v })));
			if (n.type !== 'sticky') c.appendChild(this.tb('<span class="wb-cdot" style="background:' + (n.textColor || 'currentColor') + '"></span>', 'Text color', (b) => this.colorPop(b, n.textColor || null, (id) => this.styleSel({ textColor: id ? (id.startsWith('#') ? id : wbStickyColor(id).hex) : null }), { auto: 'Automatic', custom: true })));
			if (n.type === 'text') c.appendChild(this.tb('<span class="wb-cdot" style="background:' + (n.bg || 'transparent') + ';border:1px dashed var(--wb-muted)"></span>', 'Text background', (b) => this.colorPop(b, n.bg || null, (id) => this.styleSel({ bg: id ? (id.startsWith('#') ? id : wbStickyColor(id).hex) : null }), { auto: 'No background', custom: true })));
			c.appendChild(this.tb(WB_I.bold, 'Bold (Cmd+B)', () => this.styleSel({ bold: 'toggle' }), n.bold));
			c.appendChild(this.tb(WB_I.italic, 'Italic (Cmd+I)', () => this.styleSel({ italic: 'toggle' }), n.italic));
			c.appendChild(this.tb(WB_I.underline, 'Underline (Cmd+U)', () => this.styleSel({ underline: 'toggle' }), n.underline));
			c.appendChild(this.tb(WB_I.strike, 'Strikethrough (Cmd+Shift+X)', () => this.styleSel({ strike: 'toggle' }), n.strike));
			c.appendChild(this.tb('<span class="wb-cdot" style="background:' + (n.hilite || 'transparent') + ';border:1px dashed var(--wb-muted)"></span>', 'Highlight the selected text', (b) => this.colorPop(b, null, (id) => this.styleSel({ hilite: id ? (id.startsWith('#') ? id : wbStickyColor(id).hex) : null }), { auto: 'No highlight' })));
			const al = n.align || (n.type === 'text' ? 'left' : 'center');
			c.appendChild(this.tb((al === 'left' ? WB_I.alignL : al === 'right' ? WB_I.alignR : WB_I.alignC) + WB_I.chev, 'Text alignment', (b) => this.menu(b, [{ v: 'left', label: 'Left', svg: WB_I.alignL }, { v: 'center', label: 'Center', svg: WB_I.alignC }, { v: 'right', label: 'Right', svg: WB_I.alignR }], al, (v) => this.styleSel({ align: v }), { width: 150, checks: false, isChecked: (v) => v === al })));
		};
		if (edge) {
			c.appendChild(this.tb(WB_I.straight, 'Straight', () => this.styleEdge({ route: 'straight' }), edge.route === 'straight'));
			c.appendChild(this.tb(WB_I.curved, 'Curved', () => this.styleEdge({ route: 'curved' }), (edge.route || 'curved') === 'curved'));
			c.appendChild(this.tb(WB_I.elbow, 'Elbow', () => this.styleEdge({ route: 'elbow' }), edge.route === 'elbow'));
			c.appendChild(this.sep());
			c.appendChild(this.tb(WB_I.lineSolid, 'Solid', () => this.styleEdge({ dash: 'solid' }), !edge.dash || edge.dash === 'solid'));
			c.appendChild(this.tb(WB_I.lineDash, 'Dashed', () => this.styleEdge({ dash: 'dashed' }), edge.dash === 'dashed'));
			c.appendChild(this.tb(WB_I.lineDot, 'Dotted', () => this.styleEdge({ dash: 'dotted' }), edge.dash === 'dotted'));
			c.appendChild(this.tb(WB_I.thick + WB_I.chev, edge.mm ? 'Thickness: every line in this map' : 'Line thickness', (b) => this.widthMenu(b, edge.width || 1.5, (v) => this.styleEdge({ width: v }))));
			c.appendChild(this.sep());
			c.appendChild(this.tb('<span class="wb-cdot" style="background:' + (edge.color || 'var(--wb-edge)') + '"></span>', edge.mm ? 'Branch colour: every line in this branch' : 'Line colour', (b) => this.colorPop(b, edge.color && edge.color.startsWith('#') ? edge.color : null, (id) => this.styleEdge({ color: id ? (id.startsWith('#') ? id : wbStickyColor(id).hex) : null }), { auto: 'Default', custom: true })));
			c.appendChild(this.sep());
			c.appendChild(this.tb(WB_I.arrowStart, 'Arrow at start', () => this.styleEdge({ startArrow: !edge.startArrow }), !!edge.startArrow));
			c.appendChild(this.tb(WB_I.arrowEnd, 'Arrow at end', () => this.styleEdge({ endArrow: edge.endArrow === false }), edge.endArrow !== false));
			c.appendChild(this.sep());
			if (edge.points && edge.points.length) c.appendChild(this.tb(WB_I.straight + '<span>Straighten</span>', 'Remove every bend on this line', () => { this.pushHistory(); delete edge.points; this.renderEdges(); this.renderOverlay(); this.buildCtx(); this.scheduleSave(); }));
			c.appendChild(this.tb(WB_I.label, 'Label', () => this.editLabel(edge.id), !!edge.label));
			if (edge.label) {
				c.appendChild(this.sizeCtl(edge.labelSize || 11, false, (v) => this.styleEdge({ labelSize: v })));
				c.appendChild(this.tb('<span class="wb-cdot" style="background:' + (edge.labelColor || 'currentColor') + '"></span>', 'Label text color', (b) => this.colorPop(b, edge.labelColor || null, (id) => this.styleEdge({ labelColor: id ? (id.startsWith('#') ? id : wbStickyColor(id).hex) : null }), { auto: 'Automatic', custom: true })));
				c.appendChild(this.tb('<span class="wb-cdot" style="background:' + (edge.labelBg && edge.labelBg !== 'none' ? edge.labelBg : 'transparent') + ';border:1px dashed var(--wb-muted)"></span>', 'Label background', (b) => this.colorPop(b, edge.labelBg && edge.labelBg !== 'none' ? edge.labelBg : null, (id) => this.styleEdge({ labelBg: id ? (id.startsWith('#') ? id : wbStickyColor(id).hex) : 'none' }), { auto: 'No background', custom: true })));
			}
			c.appendChild(this.tb(WB_I.trash, 'Delete', () => this.deleteSelection()));
		} else {
			if (allType === 'sticky') {
				const dot = '<span class="wb-cdot" style="background:' + wbStickyColor(one ? one.color : sel[0].color).hex + '"></span>' + WB_I.chev;
				c.appendChild(this.tb(dot, 'Color', (b) => this.colorPop(b, sel[0].color, (id) => this.styleSel({ color: id }))));
				c.appendChild(this.sep());
				const reshape = (wide) => { const items = [...this.selected].map((id) => this.nodeById(id)).filter((n) => n && n.type === 'sticky'); if (!items.length) return; this.pushHistory(); for (const n of items) { const area = n.w * n.h; if (wide) { n.w = Math.round(Math.sqrt(area * 260 / 150)); n.h = Math.round(area / n.w); } else { const side = Math.round(Math.sqrt(area)); n.w = side; n.h = side; } } this.renderAll(); this.scheduleSave(); };
				c.appendChild(this.tb(WB_I.sticky, 'Square', () => reshape(false), one && one.w <= one.h));
				c.appendChild(this.tb(WB_I.stickyWide, 'Wide', () => reshape(true), one && one.w > one.h));
				c.appendChild(this.sep());
				fontRow(sel[0]);
			} else if (allType === 'text') { fontRow(sel[0]); }
			else if (allType === 'shape') {
				const shapeBtn = this.tb(WB_SHAPE_ICON[sel[0].shape || 'rect'] + WB_I.chev, 'Shape', (b) => this.shapePop(b, sel[0].shape || 'rect', (k) => this.styleSel({ shape: k })));
				shapeBtn.classList.add('wb-big'); c.appendChild(shapeBtn);
				c.appendChild(this.sep());
				const fillDot = '<span class="wb-cdot" style="background:' + (sel[0].fill && sel[0].fill !== 'none' ? sel[0].fill : 'transparent') + ';border:1.5px solid ' + (sel[0].stroke || 'var(--wb-accent)') + '"></span><span>Fill</span>';
				c.appendChild(this.tb(fillDot, 'Fill and border', (b) => this.colorPop(b, sel[0].fill && sel[0].fill !== 'none' ? sel[0].fill : null, (id) => { if (!id) { this.styleSel({ fill: 'none', stroke: null }); return; } const hex = id.startsWith('#') ? id : wbStickyColor(id).hex; this.styleSel({ fill: hex, stroke: hex }); }, { auto: 'No fill', custom: true })));
				const strokeDot = '<span class="wb-cdot" style="background:transparent;border:2px solid ' + (sel[0].stroke || 'var(--wb-muted)') + '"></span>';
				c.appendChild(this.tb(strokeDot, 'Border colour', (b) => this.colorPop(b, sel[0].stroke && sel[0].stroke.startsWith('#') ? sel[0].stroke : null, (id) => this.styleSel({ stroke: id ? (id.startsWith('#') ? id : wbStickyColor(id).hex) : null }), { auto: 'Same as fill', custom: true })));
				c.appendChild(this.tb(WB_I.thick + WB_I.chev, 'Border thickness', (b) => this.widthMenu(b, sel[0].strokeWidth || 1.5, (v) => this.styleSel({ strokeWidth: v }))));
				c.appendChild(this.sep());
				fontRow(sel[0]);
			} else if (allType === 'image') { /* size lives on the handles */ }
			else if (allType === 'card' && one) { this.cardToolbar(c, one); }
			else if (allType === 'line' && one) { c.appendChild(this.tb(WB_I.open + '<span>Open line</span>', 'Zoom in on the line', () => this.plugin.openLine(one.recordGuid, one.lineGuid, this.panel))); c.appendChild(this.sep()); }
			if (sel.length > 1) {
				// a mixed selection (or several frames / stacks / mind nodes) still gets one colour and the text styles, applied to every member
				const colorable = sel.filter((n) => ['sticky', 'frame', 'stack', 'mind', 'shape', 'text'].includes(n.type)); const textable = sel.filter((n) => ['sticky', 'text', 'shape', 'mind'].includes(n.type));
				if (colorable.length && !(allType === 'sticky' || allType === 'text' || allType === 'shape')) {
					const dot = '<span class="wb-cdot" style="background:' + (colorable[0].color ? wbStickyColor(colorable[0].color).hex : (colorable[0].fill && colorable[0].fill !== 'none' ? colorable[0].fill : 'transparent')) + ';border:1px dashed var(--wb-muted)"></span>';
					c.appendChild(this.tb(dot, 'Colour of everything selected', (b) => this.colorPop(b, colorable[0].color || null, (id) => this.colorAll(colorable, id), { custom: true })));
					if (textable.length) { c.appendChild(this.tb(WB_I.bold, 'Bold (Cmd+B)', () => this.styleSel({ bold: 'toggle' }), textable.every((n) => n.bold))); c.appendChild(this.tb(WB_I.italic, 'Italic (Cmd+I)', () => this.styleSel({ italic: 'toggle' }), textable.every((n) => n.italic))); c.appendChild(this.tb(WB_I.underline, 'Underline (Cmd+U)', () => this.styleSel({ underline: 'toggle' }), textable.every((n) => n.underline))); }
					c.appendChild(this.sep());
				}
				const ab = this.tb(WB_I.objAlign + WB_I.chev, 'Align and arrange', (b) => this.alignPop(b, sel)); c.appendChild(ab);
				c.appendChild(this.sep());
			}
			if (one && one.type === 'stack') {
				const sc = wbStickyColor(one.color || 'yellow').hex; c.appendChild(this.tb('<span class="wb-cdot" style="background:' + sc + '"></span>', 'Colour of the notes this stack hands out', (b) => this.colorPop(b, one.color || 'yellow', (id) => { this.pushHistory(); one.color = id || 'yellow'; this.renderNode(one); this.buildCtx(); this.scheduleSave(); })));
				const sk = wbStackSizeKey(one); const setStack = (patch) => { this.pushHistory(); Object.assign(one, patch); if (patch.size && WB_STACK_SIZES[patch.size]) one.w = wbStackWidthFor(WB_STACK_SIZES[patch.size]); one.h = wbStackGeom(one).h; this.renderNode(one); this.renderEdges(); this.renderOverlay(); this.buildCtx(); this.scheduleSave(); };
				c.appendChild(this.tb('<span>' + (sk === 'custom' ? 'Custom' : sk.toUpperCase()) + '</span>' + WB_I.chev, 'Size of the notes this stack hands out (drag a corner for a custom size)', (b) => this.menu(b, [{ v: 's', label: 'Small' }, { v: 'm', label: 'Medium' }, { v: 'l', label: 'Large' }, { v: 'custom', label: 'Custom (drag a corner)' }], sk, (v) => { if (v !== 'custom') setStack({ size: v }); }, { width: 200, dots: false })));
				c.appendChild(this.tb(WB_I.sticky, 'Square notes', () => setStack({ shape: 'square' }), one.shape !== 'wide'));
				c.appendChild(this.tb(WB_I.stickyWide, 'Wide notes', () => setStack({ shape: 'wide' }), one.shape === 'wide'));
				c.appendChild(this.tb(WB_I.tag + '<span>Tag</span>' + WB_I.chev, 'Tags every note from this stack gets', (b) => this.tagMenu(b, [one])));
				c.appendChild(this.sep());
			}
			if (one && one.type === 'frame') {
				const cf = wbFrameFormat(one.format || 'custom');
				c.appendChild(this.tb(WB_SVG(cf.icon) + '<span>' + wbEsc(cf.label) + '</span>' + WB_I.chev, 'Frame format', (b) => this.menu(b, WB_FRAME_FORMATS.map((f) => ({ v: f.id, label: f.label, svg: WB_SVG(f.icon) })), one.format || 'custom', (v) => { const f = wbFrameFormat(v); this.pushHistory(); one.format = f.id; if (f.ratio) one.h = Math.round(one.w * f.ratio); this.renderAll(); this.scheduleSave(); }, { width: 180, dots: false })));
				const fc = wbStickyColor(one.color || 'white').hex; c.appendChild(this.tb('<span class="wb-cdot" style="background:' + fc + '"></span>', 'Frame color', (b) => this.colorPop(b, one.color || 'white', (id) => { this.pushHistory(); one.color = id || 'white'; this.renderNode(one); this.buildCtx(); this.scheduleSave(); })));
				c.appendChild(this.sep());
			}
			if (one && one.type === 'board') { c.appendChild(this.tb(WB_I.open + '<span>Open board</span>', 'Open this sub-board (or double-click the card)', () => this.plugin.openBoard(one.recordGuid, this.panel))); c.appendChild(this.tb(WB_I.label + '<span>Rename</span>', 'Rename the sub-board', (b) => this.renamePop(b, one.recordGuid))); c.appendChild(this.tb((one.icon ? '<span class="ti ' + wbEsc(one.icon) + '"></span>' : WB_I.subboard) + WB_I.chev, 'Folder icon', (b) => wbMenu(b, [{ v: '', label: 'Default', icon: 'ti-layout-board' }].concat(wbIconList().map((ic) => ({ v: ic, label: ic.slice(3).replace(/-/g, ' '), icon: ic }))), one.icon || '', (v) => { this.pushHistory(); one.icon = v || null; this.renderNode(one); this.buildCtx(); this.scheduleSave(); }, { width: 260, dots: false, search: true, startTop: true, maxRows: 600, searchPlaceholder: 'Search icons' }))); const bc = one.color ? wbStickyColor(one.color).hex : '#71BEF2'; c.appendChild(this.tb('<span class="wb-cdot" style="background:' + bc + '"></span>', 'Folder color', (b) => this.colorPop(b, one.color || null, (id) => { this.pushHistory(); one.color = id || null; this.renderNode(one); this.buildCtx(); this.scheduleSave(); }, { auto: 'Default blue' }))); c.appendChild(this.sep()); }
			if (sel.length) {
				const allLocked = sel.every((n) => n.locked);
				c.appendChild(this.tb(WB_I.subboard + '<span>Selection</span>' + WB_I.chev, 'Move it, or turn it into a page, a sub-board or a mind map', (b) => this.selectionMenu(b, sel)));
				c.appendChild(this.tb(allLocked ? WB_I.lockOpen : WB_I.lock, allLocked ? 'Unlock (Cmd+Shift+L)' : 'Lock in place (Cmd+Shift+L)', () => this.toggleLock(), allLocked));
				c.appendChild(this.tb(WB_I.dup, 'Duplicate', () => this.dupSelection()));
				c.appendChild(this.tb(WB_I.trash, 'Delete', () => this.deleteSelection()));
			}
		}
		this.host.appendChild(c); this.ctx = c; this.placeCtx();
	}
	placeCtx() {
		if (!this.ctx) return;
		const sel = [...this.selected].map((id) => this.nodeById(id)).filter(Boolean); let bb = wbBBox(sel);
		if (!bb && this.selectedEdge) { const e = this.scene.edges.find((x) => x.id === this.selectedEdge); const g = e && this.edgeGeom(e); if (g) bb = { x: g.mid.x, y: g.mid.y - 10, w: 0, h: 0 }; }
		if (!bb) return;
		const p = this.toScreen(bb.x, bb.y); const r = this.canvas.getBoundingClientRect(); const cw = this.ctx.offsetWidth;
		let left = p.x + (bb.w * this.cam.z - cw) / 2; left = wbClamp(left, 62, Math.max(62, r.width - cw - 8));
		const ch = this.ctx.offsetHeight || 34; let top = p.y - ch - 10; if (sel.length === 1 && sel[0].type === 'frame') top -= 26 * this.cam.z; if (top < 8) top = p.y + bb.h * this.cam.z + 10; if (top > r.height - ch - 8) top = r.height - ch - 8;
		this.ctx.style.left = left + 'px'; this.ctx.style.top = (top + this.canvas.offsetTop) + 'px';
	}
	boardMenu(anchor) {
		const s = this.scene.settings = this.scene.settings || { bg: 'dots', theme: 'auto', snap: true };
		const items = [
			{ v: 'bg:dots', label: 'Background: dots', icon: 'ti-dots' }, { v: 'bg:lines', label: 'Background: grid', icon: 'ti-layout-grid' }, { v: 'bg:blank', label: 'Background: blank', icon: 'ti-square' },
			{ v: 'theme:auto', label: 'Theme: follow Thymer', icon: 'ti-adjustments' }, { v: 'theme:light', label: 'Theme: light', icon: 'ti-sun' }, { v: 'theme:dark', label: 'Theme: dark', icon: 'ti-moon' },
			{ v: 'bgcolor', label: 'Background color', icon: 'ti-palette' },
			{ v: 'snap', label: 'Snap to grid', icon: 'ti-magnet' },

			{ v: 'banner', label: 'Update the board banner now', icon: 'ti-photo' },
			{ v: 'rename', label: 'Rename board', icon: 'ti-pencil' },
			{ v: 'record', label: 'Show the board page', icon: 'ti-file-text' },
			{ v: 'restore', label: 'Restore an earlier version', icon: 'ti-history' },
			{ v: 'export', label: 'Export board as JSON', icon: 'ti-download' },
			{ v: 'import', label: 'Import board from JSON', icon: 'ti-file-upload' },
			{ v: 'diag', label: 'Copy diagnostics', icon: 'ti-copy' },
		];
		this.menu(anchor, items, null, (v) => {
			if (v === 'banner') { this._bannerKey = null; this.updateBanner().then((ok) => this.plugin.toast(ok ? 'Board banner updated.' : 'Nothing to draw yet.')); return; }
			if (v.startsWith('bg:')) { s.bg = v.slice(3); this.applyBg(); this.scheduleSave(); }
			else if (v.startsWith('theme:')) { s.theme = v.slice(6); s.bgColor = null; this.applyTheme(); this.applyBg(); this.renderAll(); this.scheduleSave(); } // picking a theme drops a custom background colour: otherwise the colour hides the theme and 'follow Thymer' looks dead
			else if (v === 'bgcolor') { setTimeout(() => this.colorPop(anchor, s.bgColor || null, (id) => { s.bgColor = id ? (id.startsWith('#') ? id : wbStickyColor(id).hex) : null; this.applyBg(); this.renderAll(); this.scheduleSave(); }, { auto: 'Default', custom: true }), 0); }
			else if (v === 'snap') { s.snap = !s.snap; this.scheduleSave(); this.plugin.toast('Snap to grid ' + (s.snap ? 'on' : 'off')); }
			else if (v === 'rename') setTimeout(() => this.renamePop(anchor), 0);
			else if (v === 'attach') setTimeout(() => this.attachPagePop(anchor), 0);
			else if (v === 'record') this.plugin.showBoardRecord(this);
			else if (v === 'restore') setTimeout(() => this.restoreMenu(anchor), 0);
			else if (v === 'export') this.exportScene();
			else if (v === 'import') this.importScene();
			else if (v === 'diag') this.copyDiagnostics(anchor);
		}, { alignRight: true, width: 290, maxRows: 24, maxHeight: 640, checks: false, isChecked: (v) => (v === 'bg:' + (s.bg || 'dots')) || (v === 'theme:' + (s.theme || 'auto')) || (v === 'snap' && !!s.snap) });
	}
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------
class Plugin extends AppPlugin {
	onLoad() {
		if (WB_LISTENERS.length) { const gone = WB_LISTENERS.splice(0); for (const d of gone) { try { d(); } catch (e) {} } console.warn('[Whiteboard] removed ' + gone.length + ' document listeners left by an earlier instance'); }
		this.boards = new Map(); // panelId -> WbBoard
		this._pending = null; this._pop = null; this._boardsCol = null; this._noAuto = new Set(); this._evIds = [];
		this.ui.injectCSS(WB_CSS + '\n' + wbMENU_CSS + '\n' + WB_CARD_CSS + '\n' + WB_COLL_CSS);
		this.bindExternalDrag();
		this.ui.registerCustomPanelType(WB_PANEL, (panel) => this.mountPanel(panel));
		// New Board and Find Boards always; Add Board for This Page only while a page is the active panel, Add Board for This Collection
		// only while a collection is (his rulings 2026-09-27; both always make a NEW board). The palette has no visibility condition, so those two are added and removed as the
		// active panel changes (refreshCtxCommands).
		this._cmds = []; this._ctxCmds = {};
		try { this._cmds.push(this.ui.addCommandPaletteCommand({ label: 'Whiteboard: New Board', icon: 'ti-layout-board', onSelected: () => this.newBoard() })); } catch (e) {}
		try { this._cmds.push(this.ui.addCommandPaletteCommand({ label: 'Whiteboard: Find Boards', icon: 'ti-layout-board', onSelected: () => this.findBoards() })); } catch (e) {}
		try { this._evIds.push(this.events.on('panel.focused', () => this.refreshCtxCommands())); } catch (e) {}
		try { this._evIds.push(this.events.on('panel.navigated', () => this.refreshCtxCommands())); } catch (e) {}
		setTimeout(() => this.refreshCtxCommands(), 800);
		try { this._evIds.push(this.events.on('panel.navigated', (ev) => this.onPanelNavigated(ev && ev.panel))); } catch (e) {}
		try { this._evIds.push(this.events.on('record.updated', (ev) => this.onRecordUpdated(ev))); } catch (e) {}
		for (const name of ['lineitem.created', 'lineitem.updated', 'lineitem.deleted', 'lineitem.moved']) { try { this._evIds.push(this.events.on(name, (ev) => this.onPageLinesChanged(ev))); } catch (e) {} }
		this.decorate = () => { this.decoratePanels(); try { this.decorateOptionsMenus(); } catch (e) {} try { const pal = document.querySelector('.cmdpal--inline.active:not(.qb-menu), .cmdpal--dialog'); if (pal) { const rr = pal.getBoundingClientRect(); if (rr.width > 100) this._palRect = { left: rr.left, top: rr.top, width: rr.width, at: Date.now() }; } } catch (e) {} }; // where the command palette sat: Find Boards opens its menu in the same place and width
		this.bindNavHooks();
		this.refreshCols();
		this.mo = new MutationObserver(() => { if (this.moT) return; this.moT = setTimeout(() => { this.moT = null; this.decorate(); }, 150); });
		try { this.mo.observe(document.body, { childList: true, subtree: true }); } catch (e) {}
		setTimeout(this.decorate, 500);
		setTimeout(() => this.adoptOpenPanels(), 250); setTimeout(() => this.adoptOpenPanels(), 1500);
		this._syncTimer = setInterval(() => { if (WB_GEN !== window.__wbGen) return; this.watchSync(); }, 1000);
		window.__wb = this; window.__wbAll = window.__wbAll || {}; try { window.__wbAll[this.getWorkspaceGuid()] = this; } catch (e) {}
		console.log('%c[Whiteboard] v' + WB_VERSION + ' loaded', 'color:#65c8bb;font-weight:bold');
	}
	onUnload() {
		for (const h of [...(this._cmds || []), ...Object.values(this._ctxCmds || {})]) { try { if (h && h.remove) h.remove(); } catch (e) {} } this._cmds = []; this._ctxCmds = {};
		if (this._syncTimer) { clearInterval(this._syncTimer); this._syncTimer = null; }
		for (const b of this.boards.values()) { try { b.destroy(); } catch (e) {} } this.boards.clear();
		for (const id of this._evIds) { try { this.events.off(id); } catch (e) {} }
		if (this.mo) this.mo.disconnect(); this.closeMenus(); if (this._extDragOff) this._extDragOff(); if (this._navOff) this._navOff();
		document.querySelectorAll('.wb-pbtn, .wb-nb, .wb-optrow, .wb-tbtn').forEach((b) => b.remove());
		if (window.__wb === this) window.__wb = undefined;
	}
	pbtnCss() {
		return '.wb-pbtn{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px 0 6px;margin-right:6px;border-radius:var(--radius-normal,3px);border:1px solid color-mix(in srgb,var(--text-color) 18%,transparent);color:var(--color-text-600,#a1a1a1);font-size:12px;cursor:pointer;line-height:1;align-self:center;white-space:nowrap;}'
			+ '.wb-pbtn:hover{color:var(--text-color);border-color:color-mix(in srgb,var(--text-color) 35%,transparent);}'
			+ '.wb-pbtn.wb-has{color:var(--color-primary-500,#65c8bb);border-color:color-mix(in srgb,var(--color-primary-500,#65c8bb) 45%,transparent);}'
			+ '.wb-pbtn .ti{font-size:13px;}';
	}
	toast(title) { try { this.ui.addToaster({ title, dismissible: true, autoDestroyTime: 3500 }); } catch (e) {} }
	closeMenus() { try { wbCloseMenu(); } catch (e) {} if (this._pop) { try { document.removeEventListener('pointerdown', this._pop._out, true); } catch (e) {} const p = this._pop; this._pop = null; p.remove(); if (p._onClose) { try { p._onClose(); } catch (e) {} } } }

	// --- Boards collection ---------------------------------------------------------
	async boardsCollection(create) {
		if (this._boardsCol) return this._boardsCol;
		let remembered = null; try { remembered = (this.getConfiguration().custom || {}).boardsGuid || null; } catch (e) {}
		const pick = async () => {
			const all = (await this.data.getAllCollections()) || [];
			if (remembered) { const r = all.find((c) => { try { return c.getGuid() === remembered; } catch (e) { return false; } }); if (r) return r; }
			const named = all.filter((c) => { try { return c.getName() === WB_BOARDS && !c.isJournalPlugin(); } catch (e) { return false; } });
			if (named.length <= 1) return named[0] || null;
			// two "Boards" (a reload race once created a duplicate): the one holding the most boards wins
			let best = named[0], bestN = -1; for (const c of named) { let n = 0; try { n = ((await c.getAllRecords()) || []).length; } catch (e) {} if (n > bestN) { best = c; bestN = n; } }
			return best;
		};
		let col = await pick();
		if (!col && create) { await wbSleep(900); col = await pick(); } // never create on a half-loaded collection list
		if (!col && create) {
			col = await this.data.createCollection(); if (!col) return null;
			const conf = col.getConfiguration();
			conf.name = WB_BOARDS; conf.item_name = 'Board'; conf.icon = 'ti-layout-board'; conf.description = 'Whiteboards. Each board is a page here; the Page property links it to the page it belongs to.';
			conf.fields = conf.fields || [];
			for (const f of [WB_F.scene, WB_F.page, WB_F.rev, WB_F_COLL]) if (!conf.fields.find((x) => x.id === f.id)) conf.fields.push({ id: f.id, label: f.label, type: f.type, icon: f.icon, active: true, many: f.id === WB_F.page.id, read_only: false });
			await col.saveConfiguration(conf);
			await wbSleep(400);
			this.toast('Created the ' + WB_BOARDS + ' collection.');
			// the Boards view is otherwise only installed 3 s after a plugin load, when a fresh workspace has no collection yet: a new
			// user got the view only after restarting the app (found in the 1.0.0 first-run test)
			setTimeout(() => { if (this.ensureHomeView) this.ensureHomeView().catch((e) => console.warn('[Whiteboard] ensureHomeView', e)); }, 1500);
		}
		if (col) {
			this._boardsCol = col; if (!this._fieldsChecked) { this._fieldsChecked = true; this.ensureBoardsFields(); }
			try { const conf = this.getConfiguration(); conf.custom = conf.custom || {}; if (conf.custom.boardsGuid !== col.getGuid()) { conf.custom.boardsGuid = col.getGuid(); this.saveConfiguration(conf); } } catch (e) {}
		}
		return col;
	}
	async allBoards() { const col = await this.boardsCollection(false); if (!col) return []; let recs = []; try { recs = await col.getAllRecords(); } catch (e) {} return (recs || []).filter((r) => r && !r.isTrashed || !r.isTrashed); }
	async isBoardRecord(rec) { if (!rec) return false; const col = await this.boardsCollection(false); if (!col) return false; try { return rec._getRow && rec._getRow().pguid === col.getGuid(); } catch (e) { return false; } }
	isTopOf(li, rec) { const p = liRaw(li).pguid; return !p || p === rec.guid || p === rowGuid(rec); }
	boardPages(rec) { try { const many = rec.linkedRecords ? rec.linkedRecords(WB_F.page.label) : null; if (many && many.length) return many.filter(Boolean); } catch (e) {} try { const one = rec.linkedRecord(WB_F.page.label); return one ? [one] : []; } catch (e) { return []; } }
	async findBoardForPage(pageGuid) { const recs = await this.allBoards(); for (const r of recs) { if (this.boardPages(r).some((p) => p.guid === pageGuid)) return r; } return null; }
	async createBoard(title, pageGuid) {
		const col = await this.boardsCollection(true); if (!col) { this.toast('Could not find or create the ' + WB_BOARDS + ' collection.'); return null; }
		let guid = null; try { guid = col.createRecord(title || 'Untitled board'); } catch (e) {}
		if (typeof guid !== 'string') { this.toast('Could not create the board.'); return null; }
		const rec = await wbRecordPoll(this, guid, 30); if (!rec) return null;
		if (pageGuid) { try { rec.prop(WB_F.page.label).set([pageGuid]); } catch (e) {} this.linkBoardToPage(rec, pageGuid, null).catch(() => {}); }
		await this.saveScene(rec, wbNewScene());
		return rec;
	}

	// --- scene storage -------------------------------------------------------------
	// Three copies can exist: the server's, the one in memory and the work-in-progress one in IndexedDB. The newest wins,
	// by revision first and by timestamp within the same revision (a local copy at the same revision is the same save plus
	// later edits; another device's save always carries a HIGHER revision, so it still wins).
	async loadScene(rec) {
		let s = null;
		try { const p = rec.prop(WB_F.scene.label); const blob = p ? await p.fileBlob() : null; if (blob) { const ab = await blob.download(); if (ab) { const x = JSON.parse(new TextDecoder().decode(ab)); if (x && Array.isArray(x.nodes)) s = x; } } } catch (e) { console.warn('[Whiteboard] loadScene', e); }
		let best = { rev: Math.max((s && s.rev) || 0, this.serverRev(rec)), at: (s && s.savedAt) || 0, scene: s, src: 'server', serverJson: s ? wbSceneJson(Object.assign(wbNewScene(), s)) : null };
		let stray = null; // an unsaved local copy on an older revision: work from a board that could not save (2026-09-26: older in TIME too counts, a phone held back by the sync gate lost that race to a desktop save and was dropped without a word)
		// A copy wins on revision and time, but NEVER on a collapse: the board that was emptied in September had a local copy
		// one revision ahead and zero nodes, and it beat a server copy with 71. Content outranks the counter, and the loser is
		// kept as a restore point rather than dropped, because a collapse can also be real work the user has not saved yet.
		const consider = (c, src) => { if (!c || !c.json) return; const rev = c.rev || 0, at = c.at || 0; if (!c.pending && rev === best.rev && best.scene) return; /* a copy that is not unsaved, at the server's revision, IS the server's copy */ if (rev < best.rev || (rev === best.rev && at <= best.at)) { if (c.pending && rev < best.rev && (!stray || at > stray.at)) stray = c; return; } try { const x = JSON.parse(c.json); if (!x || !Array.isArray(x.nodes)) return; const have = (best.scene && best.scene.nodes && best.scene.nodes.length) || 0; if (have && x.nodes.length * 5 < have) { console.warn('[Whiteboard] ignored a ' + src + ' copy that lost ' + (have - x.nodes.length) + ' of ' + have + ' items (rev ' + rev + ')'); if (!stray || at > stray.at) stray = c; return; } best = { rev, at, scene: x, src, serverJson: best.serverJson }; } catch (e) {} }; // an empty or collapsed local copy never wins over a copy with content
		consider(WB_CACHE.get(rec.guid), 'memory');
		try { consider(await Promise.race([wbPendingGet(rec.guid), wbSleep(1500).then(() => null)]), 'this device'); } catch (e) {} // a mount must never wait on IndexedDB
		if (best.src !== 'server' && best.scene) { console.log('[Whiteboard] loaded the newer local copy (' + best.src + '), rev ' + best.rev); this.toast('Recovered changes that had not reached the server yet.'); }
		if (stray) { // it lost the comparison, but it is real work: keep it where he can get it back
			try { const x = JSON.parse(stray.json); if (x && Array.isArray(x.nodes) && x.nodes.length) { await wbBackupPut(rec.guid, stray.rev, stray.json, x.nodes.length); console.warn('[Whiteboard] kept unsaved local work (rev ' + stray.rev + ', ' + x.nodes.length + ' nodes) as a restore point'); this.toast('Unsaved changes from before were kept under Settings, Restore an earlier version.'); } } catch (e) {}
		}
		try { WB_LOADINFO.set(rec.guid, { src: best.src, serverJson: best.src !== 'server' && best.serverJson ? best.serverJson : null }); } catch (e) {}
		s = best.scene;
		try { const mx = Math.max(best.rev || 0, parseInt(localStorage.getItem('wb_maxrev_' + rec.guid) || '0', 10) || 0); if (mx) localStorage.setItem('wb_maxrev_' + rec.guid, String(mx)); } catch (e) {}
		return s ? Object.assign(wbNewScene(), s) : null;
	}
	// The revision written INSIDE the saved scene file. -1 means it could not be read, which is treated as a real conflict.
	async sceneRevOf(rec) {
		try { const p = rec.prop(WB_F.scene.label); const blob = p ? await p.fileBlob() : null; if (!blob) return 0; const ab = await blob.download(); if (!ab) return 0; const x = JSON.parse(new TextDecoder().decode(ab)); return (x && x.rev) || 0; } catch (e) { return -1; }
	}
	// The scene file exactly as the (synced) record points at it, no local copies considered: what another device saved.
	async serverScene(rec, skipBlob) { try { const p = rec.prop(WB_F.scene.label); const blob = p ? await p.fileBlob() : null; if (!blob) return null; if (skipBlob && blob.guid === skipBlob) return { same: true }; const ab = await blob.download(); if (!ab) return null; const x = JSON.parse(new TextDecoder().decode(ab)); return (x && Array.isArray(x.nodes)) ? { scene: Object.assign(wbNewScene(), x), blobGuid: blob.guid } : null; } catch (e) { return null; } }
	serverRev(rec) { try { return parseInt(rec.text(WB_F.rev.label) || '0', 10) || 0; } catch (e) { return 0; } }
	// Saves one board: local backup first, then a check that nobody saved a newer version, then the upload and the revision stamp.
	// Returns { ok } or { ok:false, conflict:true } or { ok:false, fatal:true }; plain failures (offline) are retried by the board.
	async saveScene(rec, scene, board, opts) {
		const guid = rec.guid; const viewOnly = !!(opts && opts.viewOnly);
		const rev = viewOnly ? (scene.rev || 0) : Math.max(scene.rev || 0, board ? board.knownRev || 0 : 0) + 1;
		const prevRev = scene.rev || 0; scene.rev = rev; scene.savedAt = Date.now();
		// Every content save is a VERSION with its own id and the ids it was built on (oldest first). Two devices saving within the
		// same second can land on one revision number; the ids are what tells a receiving device that the saves were concurrent and
		// which common ancestor to merge against (pullRemote).
		if (!viewOnly) { const pid = board ? board.baseId : scene.saveId; const ph = board ? (board.baseHist || []) : (scene.hist || []); scene.hist = pid ? ph.concat([pid]).slice(-30) : ph.slice(-30); scene.saveId = wbUid(); }
		let json = wbSceneJson(scene);
		wbCachePut(guid, { rev, json, at: scene.savedAt, pending: true }); // the freshest state, for a mount that comes before this upload lands
		if (!(opts && opts.noBackup)) { try { await wbBackupPut(guid, rev, json, scene.nodes.length); } catch (e) {} }
		if (!wbSyncReady()) { scene.rev = prevRev; return { ok: false, wait: true }; } // not in step with the server yet: the copy above stays on this device, nothing goes up
		try {
			const fresh = await this.record(guid);
			if (!fresh) { scene.rev = prevRev; console.warn('[Whiteboard] the board record could not be read, not saving blind'); return { ok: false }; } // 2026-09-25: an unread record skipped the conflict check and let a stale copy through; retry later instead
			// the highest revision this DEVICE has ever seen for the board: a save far below it is the stale-cache case, whatever the local record says
			let seen = 0; try { seen = parseInt(localStorage.getItem('wb_maxrev_' + guid) || '0', 10) || 0; } catch (e) {}
			if (seen > rev + 20 && !(opts && opts.force)) { console.warn('[Whiteboard] refusing to save rev ' + rev + ': this device has seen rev ' + seen); scene.rev = prevRev; return { ok: false, conflict: true, srv: seen }; }
			if (fresh) {
				const srv = this.serverRev(fresh); const mine = board ? board.knownRev : rev - 1;
				if (srv > mine && !(opts && opts.force)) {
					// The Revision FIELD says someone saved after us. Believe it only if the saved SCENE is newer too: the field can
					// run ahead on its own (a save whose upload failed after the stamp, or a torn-down instance retrying), and that
					// phantom used to stop the board from saving at all until it was reloaded.
					const other = await this.sceneRevOf(fresh);
					console.warn('[Whiteboard] refusing to save: Revision field ' + srv + ', ours ' + mine + ', saved scene ' + other);
					scene.rev = prevRev; return { ok: false, conflict: true, srv }; // never adopt someone else's revision: that is how a board with OLDER content wrote itself over newer work
				}
				// "Keep mine": HE chose to overwrite, so the counter is lifted above the server's. Nothing automatic ever does this.
				if (opts && opts.force && srv >= scene.rev) { scene.rev = srv + 1; json = wbSceneJson(scene); wbCachePut(guid, { rev: scene.rev, json, at: scene.savedAt, pending: true }); }
				rec = fresh;
			}
		} catch (e) {}
		try {
			const file = new File([json], WB_SCENE_FILE, { type: 'application/json' });
			const blob = await this.data.uploadBlob(file); if (!blob) { scene.rev = prevRev; return { ok: false }; }
			const p = rec.prop(WB_F.scene.label); if (!p) { this.toast('The board page has no Scene property, nothing was saved.'); return { ok: false, fatal: true }; }
			if (p.setFileFromBlob(blob) === false) { scene.rev = prevRev; return { ok: false }; }
			try { const mx = Math.max(scene.rev || rev, parseInt(localStorage.getItem('wb_maxrev_' + guid) || '0', 10) || 0); localStorage.setItem('wb_maxrev_' + guid, String(mx)); } catch (e) {}
			wbCachePut(guid, { rev: scene.rev || rev, json, at: scene.savedAt, pending: false }); wbPendingDel(guid); // on the server now: the local copy matches it and there is nothing pending any more
			if (!viewOnly) { try { const rp = rec.prop(WB_F.rev.label); if (rp) rp.set(String(scene.rev || rev)); } catch (e) {} if (board) board.knownRev = scene.rev || rev; }
			if (board) { board.baseJson = json; board.baseId = scene.saveId || null; board.baseHist = scene.hist || []; board.blobGuid = blob.guid; board.rememberVersion(scene.saveId, json); } // the merge base is now exactly what the server holds
			return { ok: true };
		} catch (e) { console.warn('[Whiteboard] saveScene', e); scene.rev = prevRev; wbCachePut(guid, { rev: prevRev, json, at: Date.now(), pending: true }); return { ok: false }; }
	}
	async blobUrl(guid, name) {
		try { const b = await this.data.getBlobFromPropertyFileValue({ name: name || 'image', error: null, guid, imgData: null, imgUrl: null, imgClass: null }); if (!b) return null; const ab = await b.download(); if (!ab) return null; return URL.createObjectURL(new Blob([ab])); } catch (e) { return null; }
	}

	// --- opening boards --------------------------------------------------------------
	async openBoard(guid, panel) {
		this._pending = guid;
		let p = panel || this.ui.getActivePanel();
		if (!p || p.isSidebar()) p = await this.ui.createPanel();
		if (!p) return;
		try { localStorage.setItem('wb_panel_' + p.getId(), guid); } catch (e) {}
		try { const cur = this.boards.get(p.getId()); if (cur && cur.rec && cur.rec.guid !== guid && !this._noHist) { this._boardHist = this._boardHist || new Map(); const st = this._boardHist.get(p.getId()) || []; st.push(cur.rec.guid); this._boardHist.set(p.getId(), st.slice(-30)); if (!this._viaForward && this._boardFwd) this._boardFwd.delete(p.getId()); } } catch (e) {}
		try { if (!(p.getType && p.getType() === WB_PANEL)) { let r0 = null; try { r0 = p.getActiveRecord(); } catch (e) {} if (!r0 || !(await this.isBoardRecord(r0))) { const nav = wbNavCopy(p.getNavigation()); if (nav) { this._lastNav = this._lastNav || new Map(); this._lastNav.set(p.getId(), nav); } } } } catch (e) {}
		p.navigateToCustomType(WB_PANEL);
		try { this.ui.setActivePanel(p); } catch (e) {}
	}
	// "Add Board for This Page" ALWAYS makes a new board linked to the page (his ruling 2026-09-27); an existing one is opened from the
	// page's Boards chip, the Boards collection or Find Boards.
	async addBoardForActivePage() {
		const panel = this.ui.getActivePanel(); let rec = null; try { rec = panel && panel.getActiveRecord ? panel.getActiveRecord() : null; } catch (e) {}
		if (!rec) { this.toast('Open a page first.'); return; }
		await this.refreshCols(); if (this.isExcludedRecord(rec)) { this.toast('Boards are not available for Journal or Timer pages.'); return; }
		if (await this.isBoardRecord(rec)) { this.toast('This is a board already.'); return; }
		const board = await this.createBoard(rec.getName() || 'Board', rec.guid); if (!board) return;
		return this.openBoard(board.guid, panel);
	}
	async openBoardForRecord(rec, panel) {
		if (await this.isBoardRecord(rec)) return this.openBoard(rec.guid, panel);
		let board = await this.findBoardForPage(rec.guid);
		if (!board) { board = await this.createBoard(rec.getName() || 'Board', rec.guid); if (!board) return; }
		return this.openBoard(board.guid, panel);
	}
	async newBoard() { const rec = await this.createBoard('Untitled board', null); if (rec) this.openBoard(rec.guid, null); }
	// A mount that gives up leaves Thymer's own "This is a custom panel" on screen, which is what his phone showed after Done
	// (recording 2026-09-22). Every quiet exit is now traced (Copy diagnostics shows the ring) and the two that can be timing,
	// no element yet and an element that Thymer replaced while the scene was loading, retry a few times instead of returning.
	async mountPanel(panel, retry) {
		const again = (why) => { wbTrace('mount ' + why + (retry ? ' retry ' + retry : '')); if ((retry || 0) < 5) setTimeout(() => { if (WB_GEN !== window.__wbGen) return; this._pending = this._pending || this._retryGuid || null; this.mountPanel(panel, (retry || 0) + 1); }, 300); };
		try { return await this.mountPanelInner(panel, retry, again); } catch (e) { console.warn('[Whiteboard] mount failed', e); wbTrace('mount threw ' + (e && e.message)); this.toast('The board could not be drawn. Open it again.'); }
	}
	async mountPanelInner(panel, retry, again) {
		let el = panel.getElement(); if (!el) { this._retryGuid = this._pending; return again('no element'); }
		const pid = panel.getId();
		const old = this.boards.get(pid);
		let guid = this._pending; this._pending = null; this._retryGuid = guid;
		if (this._homeNext) { this._homeNext = false; try { localStorage.removeItem('wb_panel_' + pid); } catch (e) {} this.renderPicker(panel, el); return; } // a panel opened to show the boards page, never a remembered board
		if (old && !old.destroyed && old.host === el && el.isConnected && (!guid || (old.rec && old.rec.guid === guid))) { console.log('[Whiteboard] mount skipped: board already live in panel', pid); return; }
		if (old) { old.destroy(); this.boards.delete(pid); try { await Promise.race([old.finalSave || Promise.resolve(), wbSleep(6000)]); } catch (e) {} } // its last save must land before we read anything back
		this._mounts = (this._mounts || 0) + 1; const now = Date.now(); this._mountLog = (this._mountLog || []).filter((t) => now - t < 5000); this._mountLog.push(now);
		if (this._mountLog.length > 6) { console.error('[Whiteboard] mount storm: ' + this._mountLog.length + ' mounts in 5 s, refusing'); wbTrace('mount storm'); this.toast('Whiteboard stopped: the board was re-mounted too often. Check the console.'); return; }
		if (!guid) { try { guid = localStorage.getItem('wb_panel_' + pid); } catch (e) {} }
		if (!guid && this._phoneReturn && Date.now() - this._phoneReturn.at < 30000) { guid = this._phoneReturn.guid; wbTrace('mount took the phone return guid'); try { localStorage.setItem('wb_panel_' + pid, guid); } catch (e) {} } // a custom panel that mounts with nothing right after a note was edited on the phone is the board coming back
		if (guid && WB_INFLIGHT.get(guid)) { try { await Promise.race([WB_INFLIGHT.get(guid), wbSleep(6000)]); } catch (e) {} } // a save from before a code reload must land before we read the record
		let rec = guid ? await wbRecordPoll(this, guid, 10) : null;
		if (!rec) { wbTrace('mount no record for ' + (guid || 'none') + ': boards page'); this.renderPicker(panel, el); return; }
		panel.setTitle(rec.getName() || 'Board');
		this.boardsCollection(false).catch(() => {}); // makes sure the Boards fields (Revision among them) exist before the first save
		const scene = (await this.loadScene(rec)) || wbNewScene();
		if (!el.isConnected) { let fresh = null; try { fresh = panel.getElement(); } catch (e) {} if (fresh && fresh.isConnected) { wbTrace('mount element replaced during load, using the new one'); el = fresh; } else { this._retryGuid = rec.guid; return again('element gone after load'); } } // Thymer can rebuild the panel while the scene downloads (a slow phone); the old element is not the panel any more
		wbTrace('mount ok ' + rec.guid.slice(0, 6) + ' ' + scene.nodes.length + ' nodes');
		if (this._phoneReturn && this._phoneReturn.guid === rec.guid) this._phoneReturn = null;
		const board = new WbBoard(this, panel, el, rec, scene);
		board.knownRev = Math.max(scene.rev || 0, this.serverRev(rec)); board.lastSavedNodes = scene.nodes.length;
		const li = WB_LOADINFO.get(rec.guid); board.baseJson = (li && li.src !== 'server' && li.serverJson) ? li.serverJson : wbSceneJson(scene);
		try { const bs = JSON.parse(board.baseJson); board.baseId = bs.saveId || null; board.baseHist = bs.hist || []; board.rememberVersion(bs.saveId, board.baseJson); } catch (e) {}
		if (li && li.src !== 'server') setTimeout(() => { if (!board.destroyed) board.scheduleSave(); }, 1500); // recovered local work goes up (through the gate, merged if the server moved on meanwhile)
		// A board that MOUNTS empty used to set lastSavedNodes = 0, which switches the empty-board guard off: the first save then
		// writes the empty state over a real board (that is how the September loss happened, twice in three seconds). If this
		// device still holds a backup with content, the guard is armed from THAT count and the board refuses to save until the
		// user decides. Never awaited by the mount itself, and it degrades to "no local copy" if IndexedDB is slow or wedged.
		if (!scene.nodes.length) Promise.race([wbBackupList(rec.guid), wbSleep(2000).then(() => [])]).then((list) => {
			const had = (list || []).find((b) => (b.count || 0) > 2); if (!had || board.destroyed || board.scene.nodes.length) return;
			board.lastSavedNodes = had.count; board.setSaveState('refused');
			this.toast('This board opened empty, but this device has a version with ' + had.count + ' items. Saving is paused: use the board menu, Restore an earlier version.');
			console.warn('[Whiteboard] mounted empty with a local backup of ' + had.count + ' items (rev ' + had.rev + '): saving is refused until the user decides');
		}).catch(() => {});
		this.boards.set(pid, board);
		// His phone: the trace said "mount ok" and the screen showed Thymer's "This is a custom panel". Thymer painted its placeholder
		// over a board that had mounted. So the mount is checked twice afterwards: a canvas no longer in the panel means remount.
		const guard = (ms) => setTimeout(() => { if (board.destroyed || WB_GEN !== window.__wbGen || this.boards.get(pid) !== board) return; const inPanel = board.canvas && board.canvas.isConnected && el.contains(board.canvas); if (inPanel) return; wbTrace('board painted over after mount, remounting' + (retry ? ' retry ' + retry : '')); if ((retry || 0) >= 5) return; this._pending = rec.guid; this.mountPanel(panel, (retry || 0) + 1); }, ms);
		guard(400); guard(1500);
		try { if (board.mmRecolorAll) { board.mmRecolorAll(); board.renderEdges(); } } catch (e) {} // boards saved before 0.9.4 carry hand-pinned line colours
		board.initCollectionBoard();
		if (Array.isArray(scene.reveal) && scene.reveal.length) { const ids = scene.reveal; delete scene.reveal; setTimeout(() => { if (board.destroyed) return; const sel = ids.map((id) => board.nodeById(id)).filter(Boolean); if (sel.length) { board.selected = new Set(sel.map((n) => n.id)); board.renderAll(); board.fitAll(sel); } board.scheduleSave(); }, 250); }
		setTimeout(() => { if (!board.destroyed && board.host.isConnected && !board.editing && !document.querySelector('.focused-panel')) board.host.focus({ preventScroll: true }); }, 50);
	}
	async renderPicker(panel, el) { panel.setTitle('Whiteboard'); el.innerHTML = ''; el.classList.add('wb-host'); this.renderHome(el, panel, true); }
	// Find Boards from the palette: the menu takes the palette's own place and width (his ruling 2026-09-27: not the panel's
	// full width, which is what anchoring to the tab bar gave). A hidden 1 px anchor sits on the palette's top edge.
	findBoards() {
		const r = this._palRect && Date.now() - this._palRect.at < 8000 ? this._palRect : null;
		let a = document.getElementById('wb-palanchor'); if (!a) { a = document.createElement('div'); a.id = 'wb-palanchor'; a.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;height:1px;'; document.body.appendChild(a); }
		let left, top, width;
		if (r) { left = r.left; top = r.top; width = r.width; }
		else { const pe = document.querySelector('.focused-panel') || document.body; const pr = pe.getBoundingClientRect(); width = Math.min(480, pr.width - 32); left = pr.left + (pr.width - width) / 2; top = pr.top + 60; }
		a.style.left = left + 'px'; a.style.top = top + 'px'; a.style.width = width + 'px';
		this.openBoardMenu(a, null, width);
	}
	refreshCtxCommands() {
		if (this._ctxT) return; this._ctxT = setTimeout(() => { this._ctxT = null; this.refreshCtxCommandsNow(); }, 60);
	}
	refreshCtxCommandsNow() {
		let p = null, rec = null, col = null, type = '';
		try { p = this.ui.getActivePanel(); } catch (e) {}
		try { type = (p && p.getType && p.getType()) || ''; } catch (e) {}
		try { rec = p && p.getActiveRecord ? p.getActiveRecord() : null; } catch (e) {}
		try { col = !rec && p && p.getActiveCollection ? p.getActiveCollection() : null; } catch (e) {}
		const bg = this._boardsCol && this._boardsCol.getGuid ? this._boardsCol.getGuid() : null;
		let isBoard = false; try { const row = rec ? wbRow(rec) : null; isBoard = !!(bg && row && row.pguid === bg); } catch (e) {}
		const onPage = !!(rec && type !== 'custom' && !isBoard && !this.isExcludedRecord(rec));
		const onColl = !!(!rec && col && col.getName && col.getName() !== WB_BOARDS && !this.isExcludedCollection(col));
		this.ctxCommand('page', onPage, { label: 'Whiteboard: Add Board for This Page', icon: 'ti-layout-board', onSelected: () => this.addBoardForActivePage() });
		this.ctxCommand('coll', onColl, { label: 'Whiteboard: Add Board for This Collection', icon: 'ti-layout-kanban', onSelected: () => this.addBoardForActiveCollection() });
	}
	ctxCommand(key, on, spec) {
		this._ctxCmds = this._ctxCmds || {}; const h = this._ctxCmds[key];
		if (on && !h) { try { this._ctxCmds[key] = this.ui.addCommandPaletteCommand(spec); } catch (e) {} }
		else if (!on && h) { try { h.remove(); } catch (e) {} this._ctxCmds[key] = null; }
	}
	async openBoardMenu(anchor, board, width) {
		const recs = await this.allBoards();
		const items = [{ v: '__new', label: 'New Board', icon: 'ti-plus' }].concat(recs.map((r) => ({ v: r.guid, label: r.getName() || 'Untitled', icon: 'ti-layout-board' })));
		const a = anchor || document.querySelector('.focused-panel .panel-bar--tabsbar') || document.body;
		wbMenu(a, items, board ? board.rec.guid : null, (v) => { if (v === '__new') this.newBoard(); else this.openBoard(v, board ? board.panel : null); }, { search: recs.length > 8, searchPlaceholder: 'Find a board', width: width || 260, dots: false });
	}
	async openPage(page, board) { if (await this.isBoardRecord(page)) return this.openBoard(page.guid, board.panel); const p = await this.ui.createPanel({ afterPanel: board.panel }); if (!p) return; p.navigateTo({ type: 'edit_panel', rootId: page.guid, subId: null, workspaceGuid: this.getWorkspaceGuid(), state: { positions: [page.guid, 'empty-' + page.guid, 0, 'L'] } }); }
	async openLinkedPage(board) {
		const pages = this.boardPages(board.rec); if (!pages.length) return;
		const open = (page) => this.openPage(page, board);
		if (pages.length === 1) return open(pages[0]);
		wbMenu(board.pageBtn || board.host, pages.map((pg) => ({ v: pg.guid, label: pg.getName() || 'Untitled', icon: (pg.getIcon && pg.getIcon(true)) || 'ti-file-text' })), null, (v) => { const pg = pages.find((x) => x.guid === v); if (pg) open(pg); }, { width: 260, dots: false });
	}
	async renameBoard(board, name) {
		let ok = false; try { const t = board.rec.prop('Title'); if (t) { t.set(name); ok = true; } } catch (e) {}
		if (!ok) { this.toast('Could not rename the board.'); return; }
		try { board.panel.setTitle(name); } catch (e) {}
	}
	showBoardRecord(board) {
		const guid = board.rec.guid; this._noAuto.add(guid); setTimeout(() => this._noAuto.delete(guid), 4000);
		board.panel.navigateTo({ type: 'edit_panel', rootId: guid, subId: null, workspaceGuid: this.getWorkspaceGuid(), state: { positions: [guid, 'empty-' + guid, 0, 'L'] } });
	}
	async onPanelNavigated(panel) {
		if (!panel) return;
		const pid = panel.getId();
		const b = this.boards.get(pid);
		if (b && panel.getType && panel.getType() !== WB_PANEL) { b.destroy(); this.boards.delete(pid); }
		let rec = null; try { rec = panel.getActiveRecord ? panel.getActiveRecord() : null; } catch (e) {}
		// A Board page opens as a board. The "Show the board page" menu item sets a short grace so it can be seen.
		if (rec && !this._noAuto.has(rec.guid) && await this.isBoardRecord(rec)) { this.openBoard(rec.guid, panel); return; }
		// Anything that is not a board is a place the board's Back can return to.
		if (!(panel.getType && panel.getType() === WB_PANEL)) { try { const nav = wbNavCopy(panel.getNavigation()); if (nav) { this._lastNav = this._lastNav || new Map(); this._lastNav.set(pid, nav); } } catch (e) {} }
		setTimeout(this.decorate, 200);
	}
	// The board that a DOM event belongs to: inside its host, or (keys on <body>) the one in the active panel, or the only one.
	boardForEvent(e) {
		const t = e.target;
		for (const b of this.boards.values()) { if (!b.destroyed && b.host && b.host.isConnected && (b.host.contains(t) || (b.host.closest('.panel') && b.host.closest('.panel').contains(t)))) return b; }
		if (t === document.body || t === document.documentElement || t === window || t === document) {
			const live = [...this.boards.values()].filter((b) => !b.destroyed && b.host && b.host.isConnected && b.host.offsetParent !== null);
			return live.find((b) => b.isActivePanel()) || (live.length === 1 && !document.querySelector('.focused-panel') ? live[0] : null);
		}
		return null;
	}
	bindNavHooks() {
		if (this._navHooked) return; this._navHooked = true;
		const arrow = (e) => {
			const t = e.target && e.target.closest ? e.target.closest("span.ti-arrow-left[data-tooltip-html^='Back'], span.ti-arrow-right[data-tooltip-html^='Forward']") : null; if (!t) return;
			const root = t.closest('.panel'); const b = root && [...this.boards.values()].find((x) => !x.destroyed && x.host && root.contains(x.host)); if (!b) return;
			e.stopImmediatePropagation(); e.preventDefault();
			if (e.type === 'click') { if (t.classList.contains('ti-arrow-left')) this.goBack(b.panel); else this.goForward(b.panel); }
		};
		const key = (e) => {
			if (e.key === 'Escape') { const eb = [...this.boards.values()].find((x) => !x.destroyed && x._noteEditor); if (eb) { if (document.querySelector('.wb-dpop')) { eb.closeDestPicker(); } else if (document.querySelector('.cmdpal--inline.active, .autocomplete.active')) { return; } else { eb.noteEditClose(); } e.stopImmediatePropagation(); e.preventDefault(); } return; }
			if (!(e.metaKey || e.ctrlKey || e.altKey)) return; const act = wbMatchAction(e, this); if (!act) return;
			const b = this.boardForEvent(e); if (!b || b._noteEditor) return;
			e.stopImmediatePropagation(); e.preventDefault();
			if (act === 'panel.history_back') this.goBack(b.panel); else if (act === 'panel.history_forward') this.goForward(b.panel); else this.goJournal(b.panel);
		};
		for (const ev of ['pointerdown', 'mousedown', 'click']) window.addEventListener(ev, arrow, true);
		window.addEventListener('keydown', key, true);
		this._navOff = () => { for (const ev of ['pointerdown', 'mousedown', 'click']) window.removeEventListener(ev, arrow, true); window.removeEventListener('keydown', key, true); };
	}
	// Back out of a board: Thymer's own Back (button and Cmd+[) resolves the panel through its focused component, which a
	// custom panel has none of, so the board does it itself with the navigation it replaced.
	goBack(panel) {
		const pid = panel.getId();
		const hist = this._boardHist && this._boardHist.get(pid);
		if (hist && hist.length) { const prev = hist.pop(); try { const cur = this.boards.get(pid); if (cur && cur.rec) { this._boardFwd = this._boardFwd || new Map(); const f = this._boardFwd.get(pid) || []; f.push(cur.rec.guid); this._boardFwd.set(pid, f); } } catch (e) {} this._noHist = true; try { this.openBoard(prev, panel); } finally { this._noHist = false; } return true; }
		const nav = this._lastNav && this._lastNav.get(pid);
		try { const b = this.boards.get(pid); if (b && b.rec) { this._fwd = this._fwd || new Map(); this._fwd.set(pid, b.rec.guid); } } catch (e) {}
		if (nav) { try { panel.navigateTo(nav); return true; } catch (e) {} }
		try { const me = this.me(); if (me && panel.navigateToJournal(me)) return true; } catch (e) {}
		this.toast('Nothing to go back to.'); return false;
	}
	goForward(panel) { const pid = panel.getId();
		const fwd = this._boardFwd && this._boardFwd.get(pid); if (fwd && fwd.length) { const next = fwd.pop(); this._viaForward = true; try { this.openBoard(next, panel); } finally { this._viaForward = false; } return true; } // openBoard pushes the current board onto the back stack
		const g = this._fwd && this._fwd.get(pid); if (!g) { this.toast('Nothing to go forward to.'); return false; } const cur = this.boards.get(pid); if (cur && !cur.destroyed && cur.rec && cur.rec.guid === g) return false; this._fwd.delete(pid); this.openBoard(g, panel); return true; }
	me() { try { const g = (this.user && this.user.guid) || (window.g_universe && window.g_universe.activeUser && window.g_universe.activeUser.guid); const us = this.data.getActiveUsers() || []; return us.find((u) => u.guid === g) || us[0] || null; } catch (e) { return null; } }
	goJournal(panel) { try { const me = this.me(); if (!me) return false; let d = null; try { d = DateTime.parseDateTimeString('today'); } catch (e) {} return !!panel.navigateToJournal(me, d || undefined); } catch (e) { return false; } }
	// Runs every second while the plugin is loaded. The moment this client has caught up with the server, every open board is
	// checked against the (now synced) record: a board the server is ahead of was drawn from an old copy. Untouched, it is
	// reopened from the server; with his edits on it, the conflict bar asks (Keep mine backs up the server version first).
	watchSync() {
		wbHookSyncProcessed();
		const ready = wbSyncReady(); const was = this._syncWas; this._syncWas = ready;
		if (!ready || was) return;
		wbTrace('sync ready (' + (WB_SYNC.why || '?') + ')');
		for (const b of [...this.boards.values()]) this.checkBoardFresh(b).catch(() => {});
	}
	async checkBoardFresh(b) { if (b && !b.destroyed) return b.pullRemote('sync ready'); } // drawn from an older copy? the pull merges what the server has
	// The sync gate needs a finished sync round as evidence. On a quiet workspace none may come, so a save that has waited 5 s writes
	// a timestamp into a record of a hidden collection of its own: that commit forces a round trip, and its reply is the evidence.
	// Nothing on a board is touched, so even a device that is out of step cannot overwrite anything with it.
	syncPing() {
		if (this._pingP || Date.now() - (this._pingAt || 0) < 15000) return this._pingP;
		this._pingAt = Date.now();
		this._pingP = (async () => {
			try {
				const all = (await this.data.getAllCollections()) || [];
				let col = all.find((c) => { try { return c.getName() === WB_SYNC_COL; } catch (e) { return false; } });
				if (!col) {
					col = await this.data.createCollection(); if (!col) return;
					const conf = col.getConfiguration(); conf.name = WB_SYNC_COL; conf.icon = 'ti-skull'; conf.item_name = 'Check'; conf.description = 'Whiteboard writes a timestamp here to make Thymer finish a sync round before a board is saved. Nothing else lives here.'; conf.sidebar_display_mode = { mode: 'hidden_completely' }; conf.show_cmdpal_items = false;
					await col.saveConfiguration(conf); await wbSleep(400);
				}
				let recs = []; try { recs = (await col.getAllRecords()) || []; } catch (e) {}
				let rec = recs[0] ? await this.record(recs[0].guid) : null;
				if (!rec) { let g = null; try { g = col.createRecord('Sync check'); } catch (e) {} if (typeof g !== 'string') return; rec = await wbRecordPoll(this, g, 20); if (!rec) return; }
				rec.prop('Title').set('Sync check ' + new Date().toISOString()); wbTrace('sync ping');
			} catch (e) { console.warn('[Whiteboard] sync ping', e); } finally { this._pingP = null; }
		})();
		return this._pingP;
	}
	// A note card that shows lines of another page (sent there, or the page's whole body) keeps a saved picture of them. Lines
	// written on that page elsewhere used to leave the picture stale until the card was reopened; now the card is redrawn a moment
	// after its page's lines change. The card being edited is left alone (its own typing lands here too).
	onPageLinesChanged(ev) {
		const g = ev && ev.recordGuid; if (!g) return;
		for (const b of this.boards.values()) {
			if (b.destroyed || g === b.rec.guid || !b.scene.nodes.some((n) => n.type === 'note' && n.recordGuid === g && n.lines)) continue;
			b._linesChanged = b._linesChanged || new Set(); b._linesChanged.add(g);
			if (b._linesT) clearTimeout(b._linesT);
			b._linesT = setTimeout(() => { b._linesT = null; const set = b._linesChanged; b._linesChanged = null; if (!b.destroyed && set) b.refreshNoteCards(set); }, 1200);
		}
	}
	onRecordUpdated(ev) {
		const guid = ev && (ev.recordGuid || (ev.record && ev.record.guid)); if (!guid) return; // the event carries recordGuid; there is no ev.record, so this handler never ran before 0.29
		if (this._recs && this._recs.has(guid)) { this.refetch(guid).then(() => { for (const b of this.boards.values()) { let hit = false; for (const n of b.scene.nodes) if ((n.type === 'card' || n.type === 'line') && n.recordGuid === guid && !(b.nativeEdit && b.nativeEdit.n === n)) { n._rev = (n._rev || 0) + 1; hit = true; } if (hit) b.invalidate(); } }); } // a card whose property is being edited on the card is left alone: endNativeEdit redraws it
		for (const b of this.boards.values()) if (b.rec.guid === guid) { try { b.panel.setTitle(b.rec.getName() || 'Board'); b.refreshPageBtn(); } catch (e) {} if (!b.destroyed) { if (b._pullEvT) clearTimeout(b._pullEvT); b._pullEvT = setTimeout(() => { b._pullEvT = null; b.pullRemote('event'); }, 150); } }
		this.syncBoardsFromPage(guid).catch(() => {});
	}
	// A page's Boards property is the user's side of the link (his ask 2026-09-26: a board added there must show under the board's
	// Page menu). Whenever a page changes, its Boards list is compared with every board's Page list and the boards are brought
	// in line, both ways. Only pages whose collection carries the field take part; a board record never does (sub-boards).
	async syncBoardsFromPage(guid) {
		if (!wbSyncReady()) return; // while the store catches up, the two sides of a link can each be half synced
		this._bsync = this._bsync || new Map(); const last = this._bsync.get(guid) || 0; if (Date.now() - last < 1500) return; this._bsync.set(guid, Date.now());
		let page = null; try { page = await this.data.getRecord(guid); } catch (e) {} if (!page) return;
		if (await this.isBoardRecord(page)) return;
		let pr = null; try { pr = page.prop(WB_F_BOARDS.label); } catch (e) {} if (!pr || !pr.linkedRecords) return;
		let listed = []; try { listed = (pr.linkedRecords() || []).filter(Boolean).map((r) => r.guid); } catch (e) { return; }
		const boards = await this.allBoards();
		for (const b of boards) {
			const cur = this.boardPages(b).map((p) => p.guid); const has = cur.includes(guid), want = listed.includes(b.guid); if (has === want) continue;
			const next = want ? [...new Set(cur.concat([guid]))] : cur.filter((g) => g !== guid);
			try { b.prop(WB_F.page.label).set(next); console.log('[Whiteboard] page ' + guid.slice(0, 6) + (want ? ' added to' : ' removed from') + ' board ' + (b.getName() || b.guid)); } catch (e) {}
			for (const ob of this.boards.values()) if (ob.rec.guid === b.guid) setTimeout(() => ob.refreshPageBtn(), 400);
		}
	}

	// --- reload safety: re-mount boards into custom panels that are already open ---------------------------------
	adoptOpenPanels() {
		let panels = []; try { panels = this.ui.getPanels() || []; } catch (e) {}
		for (const panel of panels) {
			try {
				if (!(panel.getType && panel.getType() === 'custom')) continue;
				const live = this.boards.get(panel.getId()); if (live && !live.destroyed && live.host && live.host.isConnected) continue;
				const el = panel.getElement(); const nav = panel.getNavigation() || {};
				const ours = (el && (el.classList.contains('wb-host') || el.querySelector('.wb-host'))) || (nav.subId && String(nav.subId).indexOf(WB_PANEL) >= 0);
				if (ours) { console.log('[Whiteboard] adopting an open board panel after reload', panel.getId()); this.mountPanel(panel); }
			} catch (e) {}
		}
	}
	// --- Journal and Timer never get boards -----------------------------------------------
	isExcludedCollection(col) { try { if (col.isJournalPlugin && col.isJournalPlugin()) return true; const nm = String(col.getName() || '').trim().toLowerCase(); return nm === 'timer' || nm === 'journal'; } catch (e) { return false; } }
	isExcludedRecord(rec) { try { const row = wbRow(rec); const cols = this._colsCache || []; const c = cols.find((x) => x.getGuid && x.getGuid() === (row && row.pguid)); return c ? this.isExcludedCollection(c) : false; } catch (e) { return false; } }
	// --- a "Board" row in Thymer's own page options menu (the "..." next to the title) ----
	decorateOptionsMenus() {
		// Thymer's page options menu is an inline command palette: an <input placeholder="<title>: options..."> over a
		// VIRTUALIZED row list (absolute rows, fixed heights). We append one row at the end and grow the two heights.
		const menu = [...document.querySelectorAll('.cmdpal--inline')].find((m) => { const inp = m.querySelector('input.cmdpal--inline-input'); return inp && /: options/.test(inp.placeholder || '') && m.getBoundingClientRect().width > 0; });
		if (!menu || menu.querySelector('.wb-optrow')) return;
		const rows = [...menu.querySelectorAll('.autocomplete--option')]; if (!rows.length) return;
		const texts = rows.map((r) => r.textContent.trim()); if (!texts.some((t) => /^Copy Page Link|^Move to Trash|^Set Title/.test(t))) return; // not a page menu
		if ((menu.querySelector('input.cmdpal--inline-input').value || '').trim()) return; // user is filtering: leave the list alone
		const panel = this.ui.getActivePanel(); let rec = null; try { rec = panel && panel.getActiveRecord ? panel.getActiveRecord() : null; } catch (e) {}
		if (!rec || this.isExcludedRecord(rec)) return;
		const title = (menu.querySelector('input.cmdpal--inline-input').placeholder || '').split(': options')[0].trim(); if (title && rec.getName && String(rec.getName() || '').trim() !== title) return;
		const ref = rows.find((r) => /^Copy Page Link/.test(r.textContent.trim())) || rows[rows.length - 1];
		const content = ref.parentElement; const scroller = content.parentElement; const autoc = scroller && scroller.parentElement;
		const rowH = ref.getBoundingClientRect().height || 31; const count = rows.length;
		const cTop = content.getBoundingClientRect().top; let maxBottom = 0; for (const r of rows) { const rb = r.getBoundingClientRect(); maxBottom = Math.max(maxBottom, rb.bottom - cTop); } for (const d of content.children) { if (d.classList.contains('autocomplete--option')) continue; const rb = d.getBoundingClientRect(); if (rb.height) maxBottom = Math.max(maxBottom, rb.bottom - cTop); }
		const mine = ref.cloneNode(true); mine.classList.add('wb-optrow'); mine.classList.remove('autocomplete--option-selected'); mine.removeAttribute('data-idx'); mine.style.transform = 'translateY(' + Math.round(maxBottom) + 'px)'; mine.style.visibility = 'hidden';
		const ic = mine.querySelector('.ti, [class*="ti-"]'); if (ic) ic.className = 'ti ti-layout-board';
		const setLabel = (t) => { const w = document.createTreeWalker(mine, NodeFilter.SHOW_TEXT); let node; while ((node = w.nextNode())) { if (node.textContent.trim()) { node.textContent = t; return; } } };
		setLabel('Board');
		const go = (e) => { e.stopPropagation(); e.preventDefault(); try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })); } catch (x) {} try { menu.remove(); } catch (x) {} let r3 = null; try { r3 = panel.getActiveRecord(); } catch (x) {} if (r3) this.openBoardForRecord(r3, panel); };
		mine.addEventListener('pointerdown', (e) => e.stopPropagation(), true); mine.addEventListener('mousedown', (e) => e.stopPropagation(), true); mine.addEventListener('click', go, true);
		mine.addEventListener('mouseenter', () => mine.classList.add('autocomplete--option-selected')); mine.addEventListener('mouseleave', () => mine.classList.remove('autocomplete--option-selected'));
		content.appendChild(mine);
		// the Boards property already opens an existing board (his ruling): the row exists only to ADD one
		this.findBoardForPage(rec.guid).then((b) => { if (!mine.isConnected) return; if (b) { mine.remove(); return; } setLabel('Add Board'); mine.style.visibility = ''; try { content.style.height = (parseFloat(content.style.height) || count * rowH) + rowH + 'px'; if (autoc && autoc.classList.contains('autocomplete')) autoc.style.height = (parseFloat(autoc.style.height) || count * rowH) + rowH + 'px'; } catch (e) {} }).catch(() => { mine.remove(); });
	}
	// --- page header button: the obvious way into a page's board ----------------------
	decoratePanels() {
		let panels = []; try { panels = this.ui.getPanels() || []; } catch (e) {}
		for (const panel of panels) {
			let el = null; try { el = panel.getElement(); } catch (e) {}
			const root = el && el.closest ? el.closest('.panel') : null; if (!root) continue;
			const isBoardPanel = panel.getType && panel.getType() === WB_PANEL;
			if (isBoardPanel) { const b = this.boards.get(panel.getId()); if (b && !b.destroyed) b.ensureChrome(); continue; }
			this.decorateViewTabs(panel, root);
		}
	}
	// A "Board" tab among the collection's view tabs. Real custom views need a plugin ON the collection (CollectionPlugin.views),
	// so this is a DOM tab that opens the collection board in this panel; native tab markup is cloned so it looks like one.
	decorateViewTabs(panel, root) {
		// His ruling 2026-09-05: not a view tab. One toolbar icon, native markup, next to Saved Searches (or the filter button).
		let rec = null; try { rec = panel.getActiveRecord ? panel.getActiveRecord() : null; } catch (e) {}
		const old = root.querySelector('.wb-tbtn');
		if (rec) { if (old) old.remove(); return; }
		let col = null; try { col = panel.getActiveCollection ? panel.getActiveCollection() : null; } catch (e) {}
		if (!col || !col.getName || col.getName() === WB_BOARDS || this.isExcludedCollection(col)) { if (old) old.remove(); return; }
		const bar = root.querySelector('.records-view-toolbar-actions'); if (!bar) { if (old) old.remove(); return; }
		// The button must be REBUILT after a code load: its click listener closes over the plugin instance that made it, and a
		// stale one asks a dead instance for the boards, which answers with nothing. That is why the picker said "no other
		// boards" on the first click after every deploy while the live instance could list all three. WB_GEN stamps the load.
		if (old && old.parentElement === bar && old.dataset.wbGen === String(WB_GEN)) return;
		if (old) old.remove();
		const btn = document.createElement('button'); btn.className = 'button-none button-small button-minimal-hover tooltip wb-tbtn'; btn.type = 'button';
		btn.setAttribute('data-tooltip-dir', 'top'); btn.setAttribute('data-tooltip', 'Board'); btn.setAttribute('aria-label', 'Board'); btn.innerHTML = '<span class="ti ti-layout-board"></span>';
		btn.dataset.wbGen = String(WB_GEN);
		const stop = (e) => e.stopPropagation(); btn.addEventListener('pointerdown', stop, true); btn.addEventListener('mousedown', stop, true);
		btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); let c2 = null; try { c2 = panel.getActiveCollection(); } catch (x) {} if (c2) this.collectionBoardMenu(btn, c2, panel); }, true);
		const ss = bar.querySelector('.ssq-btn'); const filt = bar.querySelector('.id--active-filter-button');
		if (ss) ss.insertAdjacentElement('afterend', btn); else if (filt) bar.insertBefore(btn, filt); else bar.appendChild(btn);
	}
	// --- Boards property on the page: the page lists its boards; a click opens the board -----------------
	async linkBoardToPage(boardRec, pageGuid, prevPageGuid) {
		const boardsCol = await this.boardsCollection(false); if (!boardsCol) return;
		const cols = await this.refreshCols();
		const colOf = (rec) => { try { const row = wbRow(rec); return cols.find((c) => c.getGuid && c.getGuid() === (row && row.pguid)) || null; } catch (e) { return null; } };
		if (prevPageGuid && prevPageGuid !== pageGuid) { try { let prev = null; try { prev = await this.data.getRecord(prevPageGuid); } catch (e) {} if (!prev) prev = await this.record(prevPageGuid); if (prev) { const pr = prev.prop(WB_F_BOARDS.label); if (pr && pr.removeValue) pr.removeValue(boardRec.guid); } } catch (e) {} }
		if (!pageGuid) return;
		let page = null; try { page = await this.data.getRecord(pageGuid); } catch (e) {} if (!page) page = await this.record(pageGuid); if (!page) return;
		const col = colOf(page); if (!col || this.isExcludedCollection(col)) return;
		try {
			const conf = col.getConfiguration(); conf.fields = conf.fields || [];
			if (!conf.fields.find((f) => f.id === WB_F_BOARDS.id)) {
				conf.fields.push({ id: WB_F_BOARDS.id, label: WB_F_BOARDS.label, type: 'record', icon: WB_F_BOARDS.icon, active: true, many: true, read_only: false, filter_colguid: boardsCol.getGuid() });
				if (Array.isArray(conf.page_field_ids) && conf.page_field_ids.length && !conf.page_field_ids.includes(WB_F_BOARDS.id)) conf.page_field_ids.push(WB_F_BOARDS.id);
				await col.saveConfiguration(conf); await wbSleep(400);
			}
		} catch (e) { console.warn('[Whiteboard] could not add the Boards property', e); return; }
		try { const pr = page.prop(WB_F_BOARDS.label); if (pr && pr.addValue) pr.addValue(boardRec.guid); else if (pr) pr.set([boardRec.guid]); } catch (e) { console.warn('[Whiteboard] could not link the board on the page', e); }
	}
}

// ===========================================================================
// Phase 2: Thymer cards. Cards are rendered by Thymer's own collection component
// (reached through the sidebar registry), so they ARE the native board/gallery cards.
// ===========================================================================
function wbRoot() { try { if (window.g_focusedComponent && window.g_focusedComponent.root) return window.g_focusedComponent.root; } catch (e) {} try { if (window.g_view && window.g_view.root) return window.g_view.root; } catch (e) {} return null; }
let wbColsLast = [];
function wbTi(icon, fallback) { const i = (icon || '').trim(); if (!i) return fallback || 'ti-file'; return i.startsWith('ti-') ? i : 'ti-' + i; } // record icons sometimes come without the ti- prefix
function wbComponentFor(colGuid) {
	const root = wbRoot(); const items = (root && root.sideBar && root.sideBar.items) || [];
	for (const it of items) { const p = it && it.plugin; if (p && p.collectionRoot && p.collectionRoot.guid === colGuid && typeof p.renderBoardViewCard === 'function') return p; }
	// collections tucked into folders (Dumb Folders) are not sidebar items: the collection API hands out its component
	for (const c of wbColsLast) { try { if (c.getGuid && c.getGuid() === colGuid && c._getPlugin) { const p = c._getPlugin(); if (p && typeof p.renderBoardViewCard === 'function') return p; } } catch (e) {} }
	return null;
}
function wbViewProto() {
	if (window.__wbViewProto && window.__wbViewBase) return window.__wbViewProto;
	const seen = new Set(); let found = null, n = 0;
	const has = (o) => { try { let pr = o; for (let i = 0; i < 5 && pr && pr !== Object.prototype; i++) { if (Object.getOwnPropertyNames(pr).includes('createCardPropertyEditor')) return true; pr = Object.getPrototypeOf(pr); } } catch (e) {} return false; };
	const scan = (o, d) => { if (found || !o || typeof o !== 'object' || d > 14 || seen.has(o) || n > 150000) return; seen.add(o); n++; if (o instanceof Node) return; if (has(o)) { found = o; return; } if (o instanceof Map) { for (const [k, v] of o) scan(v, d + 1); return; } if (Array.isArray(o)) { for (const v of o) scan(v, d + 1); return; } for (const k of Object.getOwnPropertyNames(o)) { if (k === 'parent') continue; let v; try { v = o[k]; } catch (e) { continue; } if (v && typeof v === 'object') scan(v, d + 1); } };
	try { scan(wbRoot(), 0); } catch (e) {} if (!found) { try { scan(window.g_focusedComponent, 0); } catch (e) {} } if (!found) { try { scan(window.g_view, 0); } catch (e) {} }
	if (!found) return null;
	window.__wbViewProto = Object.getPrototypeOf(found); window.__wbViewBase = found; return window.__wbViewProto;
}
function wbRow(rec) { try { return rec && rec._getRow ? rec._getRow() : null; } catch (e) { return null; } }
function wbFieldsOf(comp) { try { return (comp.getConfiguration().fields || []).filter((f) => f.active !== false && f.id !== 'title' && f.id !== 'parent_page'); } catch (e) { return []; } }
function wbViewDefaults(comp, style) {
	// The collection's first board (or gallery) view decides the default properties and cover, like native.
	let fieldIds = null, cover = '';
	try { const views = (comp.getConfiguration().views || []).filter((x) => (x.type === 'board' || x.type === 'gallery') && (x.field_ids || []).some((id) => id !== 'title')); const v = views.find((x) => x.type === (style === 'gallery' ? 'gallery' : 'board')) || views[0]; if (v) { fieldIds = (v.field_ids || []).filter((id) => id !== 'title'); cover = (v.opts && v.opts.cover_image_field_id) || ''; } } catch (e) {}
	if (!fieldIds || !fieldIds.length) fieldIds = wbFieldsOf(comp).slice(0, 3).map((f) => f.id);
	return { fieldIds, cover };
}
const WB_CARD_CSS = [
'.wb-cardscale{position:absolute;left:0;top:0;transform-origin:0 0;}',
'.wb-cardnode .board-card,.wb-cardnode .gallery-view-card{border-radius:var(--radius-normal,3px);}.wb-cardnode .propsl-row-choice > .propsl-icon{display:inline !important;}',
'.wb-cardnode{cursor:default;overflow:visible;font-size:var(--text-size-normal,14.25px);font-weight:var(--font-weight-normal,300);color:var(--text-color);}',
'.wb-cardnode .boards-view-scroller,.wb-cardnode .boards-view,.wb-cardnode .board-column,.wb-cardnode .body-column-body,.wb-cardnode .body-column-body-content{display:block;width:100%;min-width:0;min-height:0;padding:0;margin:0;background:transparent;border:0;box-shadow:none;overflow:visible;position:static;}',
'.wb-cardnode .board-card{margin:0 !important;width:100% !important;min-width:0 !important;max-width:none !important;box-sizing:border-box;}',
'.wb-cardnode .board-card-title-text:hover,.wb-cardnode .gallery-view-card-title-text:hover{text-decoration:underline;text-decoration-color:var(--wb-line);text-underline-offset:2px;cursor:pointer;}',
'.wb-cardnode .gallery-view,.wb-cardnode .gallery-view-cards{display:block;width:100%;margin:0;padding:0;position:static;}',
'.wb-cardnode .gallery-view-card{position:relative;margin:0 !important;width:100% !important;min-width:0 !important;box-sizing:border-box;translate:none;}',
'.wb-cardnode .propsl-row.wb-editing{box-shadow:0 0 0 1px var(--wb-accent);border-radius:var(--radius-normal);}',
'.wb-cardnode .wb-cinput{width:100%;box-sizing:border-box;height:22px;padding:0 4px;border:1px solid var(--wb-accent);border-radius:var(--radius-normal);background:transparent;color:var(--text-color);font:inherit;font-size:var(--text-size-smaller);outline:none;}',
'.wb-cardnode .wb-card-missing{color:var(--wb-muted);font-size:12px;}',
'.wb-cardnode .wb-fallback-title{font-weight:600;margin-bottom:8px;}',
'.wb-linenode{height:auto !important;background:var(--cards-bg);border:1px solid var(--cards-border-color);border-radius:var(--radius-larger);box-shadow:var(--cards-shadow);padding:12px 16px;color:var(--cards-fg,var(--text-color));font-size:13.3px;cursor:default;}',
'.wb-linenode .wb-ltext{line-height:1.4;}',
'.wb-linenode .wb-lchild{font-size:12.35px;line-height:1.4;color:var(--wb-muted);padding-left:12px;border-left:1px solid var(--wb-line);margin-top:4px;}',
'.wb-linenode .wb-lfoot{font-size:11px;color:var(--wb-muted);margin-top:8px;display:flex;align-items:center;gap:5px;}',
'.wb-linenode .wb-lfoot .ti{font-size:11px;}',
'.wb-picker{position:fixed;z-index:100003;width:320px;background:var(--wb-surface,var(--cmdpal-bg-color,#212126));border:1px solid var(--wb-line,rgba(196,196,196,.14));border-radius:var(--radius-normal,3px);box-shadow:var(--color-shadow-cards,0 4px 6px rgba(0,0,0,.2));padding:5px;}',
'.wb-picker input{width:100%;box-sizing:border-box;height:30px;padding:0 8px;border:0;border-bottom:1px solid var(--wb-line,rgba(196,196,196,.14));background:transparent;color:var(--text-color);font:inherit;font-size:13px;outline:none;margin-bottom:4px;}',
'.wb-picker .wb-prow{height:28px;padding:0 8px;display:flex;align-items:center;gap:8px;border-radius:var(--radius-normal,3px);font-size:13px;color:var(--text-color);cursor:pointer;white-space:nowrap;overflow:hidden;}',
'.wb-picker .wb-prow .ti{font-size:14px;color:var(--wb-muted);flex:none;width:16px;text-align:center;}',
'.wb-picker .wb-prow .wb-plabel{overflow:hidden;text-overflow:ellipsis;}',
'.wb-picker .wb-prow .wb-pmeta{margin-left:auto;font-size:11px;color:var(--wb-faint);flex:none;padding-left:8px;}',
'.wb-picker .wb-prow.is-on{background:color-mix(in srgb,var(--wb-accent) 16%,transparent);}',
'.wb-picker .wb-psec{font-size:10.5px;color:var(--wb-faint);padding:6px 8px 2px;}',
'.wb-picker .wb-plist{max-height:320px;overflow:auto;}',
'.wb-edges g.wb-smart path.wb-line{stroke:var(--wb-accent);}',
'.wb-edges g.wb-smart path.wb-head{fill:var(--wb-accent);}',
'.wb-edges g.wb-smart path.wb-line2{fill:none;stroke:var(--wb-accent);opacity:.35;pointer-events:none;}',
'.wb-elabel.wb-smartlbl{color:var(--wb-accent);border-color:color-mix(in srgb,var(--wb-accent) 45%,transparent);}',
'.wb-confirm{position:fixed;z-index:100003;width:300px;padding:12px;background:var(--wb-surface,var(--cmdpal-bg-color,#212126));border:1px solid var(--wb-line,rgba(196,196,196,.14));border-radius:var(--radius-normal,3px);box-shadow:var(--color-shadow-cards,0 4px 6px rgba(0,0,0,.2));font-size:12.5px;color:var(--text-color);}',
'.wb-confirm .wb-cbtns{display:flex;gap:6px;justify-content:flex-end;margin-top:10px;}',
'.wb-confirm .wb-cbtn{height:26px;padding:0 10px;display:inline-flex;align-items:center;border-radius:var(--radius-normal,3px);border:1px solid var(--button-border-color,#4c4c57);background:var(--button-bg-color,#2b2b31);color:var(--text-color);cursor:pointer;font-size:12px;}',
'.wb-confirm .wb-cbtn.wb-primary{background:var(--button-primary-bg-color,#4caea1);color:var(--button-primary-fg-color,#eee);border-color:transparent;}',
'.wb-cardnode .gallery-view-card{background-color:var(--cards-bg);border:1px solid var(--cards-border-color);box-shadow:var(--cards-shadow);}', // Thymer's gallery card is transparent by design (it sits on the panel); on a board it needs the board card's surface (his question 2026-09-26)
].join('\n');

Object.assign(WbBoard.prototype, {
	// ---- card node rendering -------------------------------------------------------
	renderCardNode(n, el) {
		if (!el.classList.contains('wb-cardnode')) { el.classList.add('wb-cardnode'); }
		// The native card is drawn at its base width and SCALED to n.w, so a resize needs no re-render: rebuilding it per pointermove
		// made the card vanish and reappear on every step (his recording 2026-09-26). Only a new revision rebuilds it.
		const key = String(n._rev || 0) + ':' + (n._showAll ? 1 : 0);
		if (el.dataset.rev === key && el.childElementCount) { this.cardRescale(n, el); return; }
		el.dataset.rev = key;
		el.innerHTML = '';
		const rec = this.plugin.recordSync(n.recordGuid);
		if (!rec) {
			// Fetch once; a page that cannot be found (trashed, other workspace) renders a placeholder and never re-fetches in a loop.
			if (n._missing) { el.innerHTML = '<div class="board-card"><div class="board-card-title"><span class="board-card-title-text">Page not found</span></div><div class="wb-card-missing">The page was trashed or moved. Remove this card.</div></div>'; this.measureCard(n, el); return; }
			if (n._fetching) { el.innerHTML = '<div class="board-card"><div class="wb-card-missing">Loading page</div></div>'; return; }
			n._fetching = true; el.innerHTML = '<div class="board-card"><div class="wb-card-missing">Loading page</div></div>';
			this.plugin.record(n.recordGuid).then((r) => { n._fetching = false; if (this.destroyed) return; if (!r) n._missing = true; n._rev = (n._rev || 0) + 1; this.renderNode(n); }).catch(() => { n._fetching = false; n._missing = true; });
			return;
		}
		const row = wbRow(rec); const comp = row ? wbComponentFor(row.pguid) : null;
		const cfg = this.cardConfig(n, comp);
		if (comp && row) {
			const vc = { id: 'wb-' + n.id, type: cfg.style === 'gallery' ? 'gallery' : 'board', field_ids: ['title'].concat(cfg.fieldIds), opts: { gallery_style: 'cover', cover_image_field_id: cfg.cover || '' }, read_only: false, shown: true };
			const baseW = n.baseW || 220; const sc = n.w / baseW;
			const scaleWrap = wbEl('div', 'wb-cardscale'); scaleWrap.style.width = baseW + 'px'; scaleWrap.style.transform = 'scale(' + sc + ')'; el.appendChild(scaleWrap); n._scale = sc;
			try {
				if (cfg.style === 'gallery') {
					// Same markup chain as Thymer's gallery view, so every native rule applies.
					const gv = wbEl('div', 'gallery-view animate-filter no-inline-card-properties-edit no-selection'); const gcs = wbEl('div', 'gallery-view-cards'); gv.appendChild(gcs);
					const wrap = wbEl('div', 'gallery-view-card gallery-view-card-cover-image gallery-view-card-stacked'); wrap.dataset.guid = rec.guid; wrap.dataset.bannerDrop = rec.guid; gcs.appendChild(wrap);
					let coverField = null; try { coverField = cfg.cover ? comp.fieldsById.get(cfg.cover) || null : null; } catch (e) {}
					const covers = cfg.galleryStyle === 'cover'; vc.opts.gallery_style = covers ? 'cover' : 'cover-banner';
					const node = comp.renderGalleryViewCard(vc, wrap, row, null, { showAllProperties: !!n._showAll, editingFieldId: null, overlayContent: false, previewMode: 'cover-image', imageStyle: covers ? 'book-hardcover' : 'none', coverImageField: coverField });
					if (node) wrap.appendChild(node);
					wrap.appendChild(this.cardMenuNode(rec.guid, 31));
					scaleWrap.appendChild(gv);
				} else {
					const card = wbEl('div', 'board-card'); card.dataset.guid = rec.guid; card.dataset.bannerDrop = rec.guid;
					comp.renderBoardViewCard(vc, card, row, null, null, { showAllProperties: !!n._showAll });
					card.appendChild(this.cardMenuNode(rec.guid, 25));
					scaleWrap.appendChild(card);
				}
			} catch (e) { console.warn('[Whiteboard] native card render failed', e); scaleWrap.innerHTML = ''; scaleWrap.appendChild(this.fallbackCard(rec)); }
		} else { const baseW = n.baseW || 220; const sc = n.w / baseW; const scaleWrap = wbEl('div', 'wb-cardscale'); scaleWrap.style.width = baseW + 'px'; scaleWrap.style.transform = 'scale(' + sc + ')'; n._scale = sc; scaleWrap.appendChild(this.fallbackCard(rec)); el.appendChild(scaleWrap); }
		const innerEl = el.querySelector('.board-card, .gallery-view-card'); const iw = innerEl ? Math.max(innerEl.offsetWidth, innerEl.scrollWidth) : 0; const sw = el.querySelector('.wb-cardscale');
		if (iw && sw && Math.abs(iw - parseFloat(sw.style.width)) > 1) { const sc2 = n.w / iw; sw.style.width = iw + 'px'; sw.style.transform = 'scale(' + sc2 + ')'; n._scale = sc2; }
		this.measureCard(n, el); this.cardRemeasure(n, el);
	},
	cardRescale(n, el) {
		const sw = el.querySelector('.wb-cardscale'); if (!sw) return; const iw = parseFloat(sw.style.width) || (n.baseW || 220); const sc = n.w / iw;
		if (Math.abs((n._scale || 0) - sc) > 0.0005) { sw.style.transform = 'scale(' + sc + ')'; n._scale = sc; }
		this.measureCard(n, el);
	},
	// Thymer's native card fills in AFTER our synchronous measure (205 px at 0 ms, 454 px at 50 ms with its cover image, measured
	// 2026-09-26), and ResizeObserver callbacks were never delivered in this window even for a fresh observer, so the height is
	// measured again a few times after every render; measureCard is a no-op once it agrees.
	cardRemeasure(n, el) {
		for (const t of (el._wbReT || [])) clearTimeout(t);
		el._wbReT = [80, 300, 1200].map((ms) => setTimeout(() => { if (!this.destroyed && el.isConnected && this.nodeEls.get(n.id) === el) this.measureCard(n, el); }, ms));
	},
	// Thymer's own card menu / drag handle markup (Options menu is handled by Thymer's global click handling).
	cardMenuNode(guid, right) {
		const m = wbEl('div', right === 31 ? 'card-menu' : 'board-card-menu'); m.style.cssText = 'position:absolute;top:10px;right:' + right + 'px;z-index:2';
		m.innerHTML = '<span data-guid="' + wbEsc(guid) + '" class="' + (right === 31 ? 'id--dots ' : '') + 'link-menu-opener item-drag-handle tooltip" data-mode="drag-handle-opener" data-tooltip-style="tooltip-drag-handle" data-tooltip-dir="top" data-tooltip-delay="750" aria-label="Options"><span class="board-card-mobile-grip ti ti-grip-vertical"></span></span>';
		return m;
	},
	fallbackCard(rec) {
		const card = wbEl('div', 'board-card'); card.appendChild(wbEl('div', 'wb-fallback-title', wbEsc(rec.getName() || 'Untitled')));
		const props = wbEl('div', 'propsl propsl-show-some');
		try { for (const p of (rec.getAllProperties() || []).slice(0, 6)) { let t = ''; try { const linked = p.linkedRecords ? (p.linkedRecords() || []) : []; if (linked.length) t = linked.map((r) => r.getName() || 'Untitled').join(', '); else t = (p.texts() || []).filter((x) => typeof x === 'string' && !/^[0-9A-Z]{26}$/.test(x)).join(', '); } catch (e) {} if (!t) continue; const row = wbEl('div', 'propsl-row'); row.appendChild(wbEl('span', 'propsl-icon ti ti-align-left')); row.appendChild(wbEl('span', 'propsl-val', wbEsc(t))); props.appendChild(row); } } catch (e) {}
		card.appendChild(props); return card;
	},
	// Edges + overlay + toolbar are re-rendered at most once per frame, however many cards report a new height.
	// (A dynamic collection mirroring the whole workspace produced thousands of cards, each re-rendering the overlay: the freeze of 2026-09-05.)
	invalidateChrome() {
		if (this._chromeRaf) return;
		this._chromeRaf = requestAnimationFrame(() => {
			this._chromeRaf = 0; if (this.destroyed) return;
			if (this._mmDirty && this._mmDirty.size) { for (const id of this._mmDirty) { if (this.nodeById(id)) this.mmLayout(id); } this._mmDirty.clear(); this.renderNodesFast(this.scene.nodes); }
			this.renderEdges(); this.renderOverlay(); this.placeCtx();
		});
	},
	measureCard(n, el) {
		const self = el.classList.contains('wb-linenode');
		const inner = self ? null : (el.querySelector('.board-card, .gallery-view-card') || el.firstElementChild);
		const sc = self ? 1 : (n._scale || 1);
		const h = Math.max(24, Math.round(self ? el.scrollHeight : (inner ? inner.offsetHeight * sc : el.offsetHeight)));
		if (h && Math.abs(h - n.h) > 1) { n.h = h; el.style.height = h + 'px'; if (this.mmIsTree && this.mmIsTree(n.id)) { const root = this.mmRootOf(n.id); this._mmDirty = this._mmDirty || new Set(); this._mmDirty.add(root.id); } this.invalidateChrome(); }
		// The inner card is REBUILT on every re-render (a resize re-renders it per move), and the observer used to stay on the first
		// one, so a cover image that loaded after a resize never corrected the height: the selection frame sat across the middle of
		// the card (his screenshot 2026-09-24). The observer now follows the current inner element.
		if (!self) { const target = inner || el; if (!el._wbRo) el._wbRo = new ResizeObserver(() => { if (this.destroyed || !el.isConnected) return; const c = el.querySelector('.board-card, .gallery-view-card'); const hh = Math.round(c ? c.offsetHeight * (n._scale || 1) : 0); if (hh && Math.abs(hh - n.h) > 1) { n.h = hh; el.style.height = hh + 'px'; this.invalidateChrome(); } }); if (el._wbRoTarget !== target) { el._wbRo.disconnect(); el._wbRo.observe(target); el._wbRoTarget = target; } }
	},
	cardConfig(n, comp) {
		const row = null; const st = this.scene.settings || {}; const defs = (st.cardDefaults && comp && st.cardDefaults[comp.collectionRoot.guid]) || null;
		const style = n.style || (defs && defs.style) || 'board';
		let fieldIds = n.fieldIds || (defs && defs.fieldIds) || null; let cover = n.cover != null ? n.cover : (defs && defs.cover != null ? defs.cover : null);
		if (comp && (!fieldIds || cover == null)) { const vd = wbViewDefaults(comp, style); if (!fieldIds) fieldIds = vd.fieldIds; if (cover == null) cover = vd.cover; }
		return { style, fieldIds: fieldIds || [], cover: cover || '', galleryStyle: n.galleryStyle || (defs && defs.galleryStyle) || 'cover-banner' };
	},
	// ---- line node rendering ----------------------------------------------------------
	renderLineNode(n, el) {
		if (!el.classList.contains('wb-linenode')) el.classList.add('wb-linenode');
		const lsc = n.w / (n.baseW || n.w); el.style.transform = 'scale(' + lsc + ')'; el.style.transformOrigin = '0 0'; el.style.width = (n.baseW || n.w) + 'px'; n._scale = lsc;
		if (el.dataset.rev === String(n._rev || 0) && el.childElementCount) return;
		el.dataset.rev = String(n._rev || 0); if (n._missing) { el.innerHTML = '<div class="wb-ltext wb-card-missing">Line not found</div>'; return; } el.innerHTML = '<div class="wb-ltext" style="color:var(--wb-muted)">Loading</div>';
		this.plugin.lineInfo(n.recordGuid, n.lineGuid).then((info) => {
			if (this.destroyed || !el.isConnected) return; el.innerHTML = '';
			if (!info) { el.innerHTML = '<div class="wb-ltext wb-card-missing">Line not found</div>'; n._missing = true; return; }
			el.appendChild(wbEl('div', 'wb-ltext', wbEsc(info.text || '(empty)')));
			for (const c of info.children.slice(0, 3)) el.appendChild(wbEl('div', 'wb-lchild', wbEsc(c)));
			if (info.children.length > 3) el.appendChild(wbEl('div', 'wb-lchild', '+ ' + (info.children.length - 3) + ' more'));
			el.appendChild(wbEl('div', 'wb-lfoot', '<span class="ti ' + wbEsc(info.icon || 'ti-file-text') + '"></span><span>' + wbEsc(info.page) + '</span>'));
			this.measureCard(n, el);
		});
	},
});

// ---- wire card/line node types into the board renderer -----------------------------------
{
	const baseRenderNode = WbBoard.prototype.renderNode;
	WbBoard.prototype.renderNode = function (n) {
		if (n.type !== 'card' && n.type !== 'line') return baseRenderNode.call(this, n);
		let el = this.nodeEls.get(n.id);
		if (el && ((el.dataset.wbType && el.dataset.wbType !== n.type) || (el.childElementCount && !el.classList.contains('wb-cardnode') && !el.classList.contains('wb-linenode')))) { el.remove(); this.nodeEls.delete(n.id); el = null; }
		if (!el) { el = wbEl('div', 'wb-node'); el.dataset.id = n.id; el.dataset.wbType = n.type; this.nodes.appendChild(el); this.nodeEls.set(n.id, el); }
		el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; el.style.width = n.w + 'px'; el.style.height = n.h + 'px';
		if (n.type === 'card') this.renderCardNode(n, el); else this.renderLineNode(n, el);
	};
	const baseBeginEdit = WbBoard.prototype.beginEdit;
	WbBoard.prototype.beginEdit = function (id) { const n = this.nodeById(id); if (n && (n.type === 'card' || n.type === 'line')) return; return baseBeginEdit.call(this, id); };
	const baseOnDbl = WbBoard.prototype.onDbl;
	WbBoard.prototype.onDbl = function (e) { const hit = this.hitNode(e); if (hit && hit.type === 'card') { this.plugin.openRecord(hit.recordGuid, this.panel, e.altKey); return; } if (hit && hit.type === 'line') { this.plugin.openLine(hit.recordGuid, hit.lineGuid, this.panel); return; } return baseOnDbl.call(this, e); };
	// A plain click (no drag) inside a card: title opens the page, a property row opens its editor, openers work natively.
	const baseOnUp = WbBoard.prototype.onUp;
	WbBoard.prototype.onUp = function (e, cancelled) {
		const d = this.drag; const wasMove = d && d.kind === 'move' && !d.moved && !cancelled; const target = d && d.downTarget;
		baseOnUp.call(this, e, cancelled);
		if (!wasMove || !target || !target.closest) return;
		const nodeEl = target.closest('.wb-node'); const n = nodeEl && this.nodeById(nodeEl.dataset.id); if (!n) return;
		if ((n.type === 'note' || n.type === 'line') && e.metaKey && e.shiftKey && n.recordGuid && n.recordGuid !== this.rec.guid) { this.plugin.openLine(n.recordGuid, n.lineGuid, this.panel, true); return; }
		if (n.type !== 'card') return;
		if (e.metaKey && e.shiftKey) { this.plugin.openRecord(n.recordGuid, this.panel, true); return; }
		if (target.closest('.property-link-opener, .board-card-open, .gallery-view-card-open')) { const g = target.closest('[data-guid]'); const guid = g && g.dataset.guid; if (guid) this.plugin.openRecord(guid, this.panel, true); return; }
		if (target.closest('.board-card-title-text, .gallery-view-card-title-text')) { this.plugin.openRecord(n.recordGuid, this.panel, e.altKey); return; }
		const row = target.closest('.propsl-row'); if (row && row.dataset.fieldId) { this.editCardProp(n, row.dataset.fieldId, row); }
	};
	const baseStartDrag = WbBoard.prototype.startDrag;
	WbBoard.prototype.startDrag = function (e, d) { d.downTarget = e.target; return baseStartDrag.call(this, e, d); };
}

Object.assign(WbBoard.prototype, {
	// ---- property editing on the card ---------------------------------------------------
	async editCardProp(n, fieldId, rowEl) {
		const rec = await this.plugin.record(n.recordGuid); if (!rec) return;
		const row = wbRow(rec); const comp = row ? wbComponentFor(row.pguid) : null; if (!comp) { this.plugin.toast('Open the page to edit this property.'); return; }
		let field = null; try { field = comp.fieldsById.get(fieldId) || null; } catch (e) {}
		if (!field) return;
		const prop = rec.prop(field.label); if (!prop) return;
		const done = async () => { await wbSleep(120); await this.plugin.refetch(n.recordGuid); n._showAll = false; n._rev = (n._rev || 0) + 1; this.renderNode(n); this.scheduleSave(); };
		const type = field.type;
		if (this.nativeEdit) this.endNativeEdit(true);
		if (this.nativeEditStart(n, field.id, rowEl, comp, row)) return;
		if (type === 'text' || type === 'number' || type === 'url') {
			const val = rowEl.querySelector('.propsl-val'); if (!val) return; rowEl.classList.add('wb-editing');
			let cur = ''; try { cur = type === 'number' ? String(prop.number() == null ? '' : prop.number()) : (prop.text() || ''); } catch (e) {}
			const inp = document.createElement('input'); inp.className = 'wb-cinput'; inp.value = cur; val.innerHTML = ''; val.appendChild(inp); inp.focus(); inp.select();
			const commit = (save) => { inp.removeEventListener('blur', onBlur); if (save) { const v = inp.value.trim(); try { prop.set(type === 'number' ? (v === '' ? null : Number(v)) : v); } catch (e) {} } setTimeout(done, 60); };
			const onBlur = () => commit(true);
			inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); commit(true); } else if (e.key === 'Tab') { e.preventDefault(); commit(true); } });
			inp.addEventListener('blur', onBlur); inp.addEventListener('pointerdown', (e) => e.stopPropagation());
			return;
		}
		if (type === 'choice') {
			const choices = (field.choices || []).filter((c) => c.active !== false); let current = []; try { current = prop.selectedChoices ? prop.selectedChoices() : []; } catch (e) {}
			const curIds = new Set(choices.filter((c) => current.includes(c.label) || current.includes(c.id)).map((c) => c.id));
			const items = choices.map((c) => ({ v: c.id, label: c.label, color: c.color, icon: c.icon || null }));
			items.push({ v: '__clear', label: 'Clear', icon: 'ti-x' });
			wbMenu(rowEl, items, field.many ? null : [...curIds][0] || null, (v) => {
				try { if (v === '__clear') prop.set(field.many ? [] : null); else if (field.many) { if (curIds.has(v)) curIds.delete(v); else curIds.add(v); prop.set([...curIds]); } else prop.setChoice ? prop.setChoice(v) : prop.set(v); } catch (e) { console.warn('[Whiteboard] choice set', e); }
				if (!field.many) done(); else { n._rev = (n._rev || 0) + 1; this.renderNode(n); this.scheduleSave(); }
			}, { width: 220, keepOpen: !!field.many, checks: false, isChecked: field.many ? (v) => curIds.has(v) : null, search: choices.length > 8 });
			return;
		}
		if (type === 'record') {
			const cols = await this.plugin.data.getAllCollections(); const target = field.filter_colguid ? cols.find((c) => c.getGuid && c.getGuid() === field.filter_colguid) : null;
			let recs = []; try { recs = target ? await target.getAllRecords() : (await Promise.all(cols.filter((c) => !c.isJournalPlugin || !c.isJournalPlugin()).map((c) => c.getAllRecords().catch(() => [])))).flat(); } catch (e) {}
			let current = []; try { current = (rec.linkedRecords(field.label) || []).map((r) => r.guid); } catch (e) {}
			const curIds = new Set(current);
			const items = recs.slice(0, 800).map((r) => ({ v: r.guid, label: r.getName() || 'Untitled', icon: (r.getIcon && r.getIcon(true)) || 'ti-file-text' }));
			items.unshift({ v: '__clear', label: 'Clear', icon: 'ti-x' });
			wbMenu(rowEl, items, field.many ? null : current[0] || null, (v) => {
				try { if (v === '__clear') prop.set([]); else if (field.many) { if (curIds.has(v)) curIds.delete(v); else curIds.add(v); prop.set([...curIds]); } else prop.set([v]); } catch (e) { console.warn('[Whiteboard] record set', e); }
				if (!field.many) done(); else { n._rev = (n._rev || 0) + 1; this.renderNode(n); this.scheduleSave(); }
			}, { width: 280, keepOpen: !!field.many, checks: false, isChecked: field.many ? (v) => curIds.has(v) : null, search: true, searchPlaceholder: 'Find a page' });
			return;
		}
		if (type === 'datetime') {
			const val = rowEl.querySelector('.propsl-val'); if (!val) return; rowEl.classList.add('wb-editing');
			let cur = ''; try { const dt = prop.datetime ? prop.datetime() : null; const d = dt && dt.toDate ? dt.toDate() : (prop.date ? prop.date() : null); if (d) cur = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + (d.getHours() || d.getMinutes() ? ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') : ''); } catch (e) {}
			const inp = document.createElement('input'); inp.className = 'wb-cinput'; inp.value = cur; inp.placeholder = 'YYYY-MM-DD HH:MM'; val.innerHTML = ''; val.appendChild(inp); inp.focus(); inp.select();
			const parse = (s) => { s = s.trim().toLowerCase(); if (!s) return null; const now = new Date(); if (s === 'today' || s === 'idag') return now; if (s === 'tomorrow' || s === 'imorgon') { const t = new Date(now); t.setDate(t.getDate() + 1); return t; } const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ t](\d{1,2}):(\d{2}))?$/.exec(s); if (!m) return undefined; return new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0); };
			const commit = (save) => { inp.removeEventListener('blur', onBlur); if (save) { const d = parse(inp.value); if (d === null) { try { prop.set(null); } catch (e) {} } else if (d instanceof Date) { try { prop.setFromDate(d); } catch (e) { console.warn('[Whiteboard] date set', e); } } else { this.plugin.toast('Use YYYY-MM-DD, optionally with HH:MM, or today / tomorrow.'); } } setTimeout(done, 60); };
			const onBlur = () => commit(true);
			inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); commit(true); } });
			inp.addEventListener('blur', onBlur); inp.addEventListener('pointerdown', (e) => e.stopPropagation());
			return;
		}
		this.plugin.openRecord(n.recordGuid, this.panel, true);
	},
	// Show the card with its empty rows just long enough to edit one of them.
	async fillIn(n, fieldId) {
		n._showAll = true; n._rev = (n._rev || 0) + 1; this.renderNode(n); await wbSleep(50);
		const el = this.nodeEls.get(n.id); const row = el && el.querySelector('.propsl-row[data-field-id="' + fieldId + '"]');
		if (!row) { n._showAll = false; n._rev++; this.renderNode(n); return; }
		await this.editCardProp(n, fieldId, row);
	},
	// ---- Thymer's own inline card editor, borrowed from a live board/gallery view ----------------------
	nativeEditStart(n, fieldId, rowEl, comp, row) {
		const proto = wbViewProto(); if (!proto || typeof proto.createCardPropertyEditor !== 'function') return false;
		const cardEl = rowEl.closest('.board-card, .gallery-view-card'); if (!cardEl) return false;
		const self = this;
		const fake = { plugin: comp, editingCardFieldId: fieldId, currentFieldEditor: null, provisionalCreatedCardGuid: null, renderAnimationClass: {}, editedItemGuids: new Set(), children: [], mixins: [], node: cardEl,
			destroyInlinePropertyEditor() { if (this.currentFieldEditor) { try { this.currentFieldEditor.onShouldSaveValue(); } catch (e) {} try { this.currentFieldEditor.destroy(); } catch (e) {} this.currentFieldEditor = null; } },
			canEditCardProperty: () => true, getCardPropertyValueNode: (card, f) => card.querySelector('.propsl-row[data-field-id="' + f + '"] .propsl-val'),
			shouldForceInlineCardPropertyEditor: () => false, bustCardNodeCache() {}, isDestroyed: () => self.destroyed, finishCardPropertyEdit: () => self.endNativeEdit(true), setTimeout: (f, ms) => setTimeout(f, ms),
			$: (sel) => cardEl.querySelector(sel), $$: (sel) => [...cardEl.querySelectorAll(sel)] };
		const base = window.__wbViewBase;
		const prox = new Proxy(fake, { get: (t, k) => (k in t) ? t[k] : base[k], set: (t, k, v) => { t[k] = v; return true; } });
		try { proto.createCardPropertyEditor.call(prox, cardEl, row); } catch (e) { console.warn('[Whiteboard] native editor', e); return false; }
		if (!fake.currentFieldEditor) return false;
		rowEl.classList.add('wb-editing'); this.nativeEdit = { prox, n, rowEl }; return true;
	},
	endNativeEdit(save) {
		const ne = this.nativeEdit; if (!ne) return; this.nativeEdit = null;
		const ed = ne.prox.currentFieldEditor; ne.prox.currentFieldEditor = null;
		if (ed) { if (save) { try { ed.onShouldSaveValue(); } catch (e) {} } try { if (ed.destroyAutoComplete) ed.destroyAutoComplete(); } catch (e) {} try { ed.destroy(); } catch (e) {} }
		try { ne.rowEl.classList.remove('wb-editing'); } catch (e) {}
		setTimeout(async () => { if (this.destroyed) return; await this.plugin.refetch(ne.n.recordGuid); ne.n._showAll = false; ne.n._rev = (ne.n._rev || 0) + 1; this.renderNode(ne.n); this.scheduleSave(); }, 150);
	},
	// ---- card toolbar: properties, style, cover ----------------------------------------
	cardToolbar(c, n) {
		const rec = this.plugin.recordSync(n.recordGuid); const row = wbRow(rec); const comp = row ? wbComponentFor(row.pguid) : null;
		const cfg = this.cardConfig(n, comp);
		c.appendChild(this.tb(WB_I.card + '<span>' + (cfg.style === 'gallery' ? 'Gallery' : 'Board') + '</span>' + WB_I.chev, 'Page card style', (b) => this.menu(b, [{ v: 'board', label: 'Board card', icon: 'ti-layout-kanban' }, { v: 'gallery', label: 'Gallery card', icon: 'ti-layout-grid' }], cfg.style, (v) => { this.pushHistory(); n.style = v; n._rev = (n._rev || 0) + 1; this.renderAll(); this.scheduleSave(); }, { width: 160 })));
		if (comp) {
			const fields = wbFieldsOf(comp); const chosen = new Set(cfg.fieldIds);
			const items = fields.map((f) => ({ v: f.id, label: f.label, icon: f.icon || 'ti-align-left' }));
			if (cfg.style !== 'gallery') items.push({ v: 'banner', label: 'Banner', icon: 'ti-photo' });
			items.push({ v: '__default', label: 'Use for all ' + (comp.getConfiguration().name || '') + ' cards here', icon: 'ti-pin' });
			c.appendChild(this.tb('<span>Properties</span>' + WB_I.chev, 'Properties shown on the page card', (b) => wbMenu(b, items, null, (v) => {
				if (v === '__default') { const st = this.scene.settings = this.scene.settings || {}; st.cardDefaults = st.cardDefaults || {}; st.cardDefaults[comp.collectionRoot.guid] = { fieldIds: [...chosen], style: cfg.style, cover: cfg.cover }; for (const x of this.scene.nodes) if (x.type === 'card' && x.fieldIds == null) x._rev = (x._rev || 0) + 1; this.renderAll(); this.scheduleSave(); this.plugin.toast('Saved as the default for this collection on this board.'); return; }
				if (chosen.has(v)) chosen.delete(v); else chosen.add(v); n.fieldIds = fields.map((f) => f.id).concat(['banner']).filter((id) => chosen.has(id)); n._rev = (n._rev || 0) + 1; this.renderNode(n); this.scheduleSave();
			}, { width: 240, keepOpen: true, checks: false, isChecked: (v) => chosen.has(v), search: fields.length > 10 })));
			if (cfg.style === 'gallery') {
				const imgs = fields.filter((f) => f.type === 'image'); const covItems = [{ v: '', label: 'Banner (default)', icon: 'ti-photo' }].concat(imgs.map((f) => ({ v: f.id, label: f.label, icon: f.icon || 'ti-photo' })));
				c.appendChild(this.tb('<span>Cover</span>' + WB_I.chev, 'Cover image', (b) => this.menu(b, covItems, cfg.cover || '', (v) => { n.cover = v; n._rev = (n._rev || 0) + 1; this.renderNode(n); this.scheduleSave(); }, { width: 200 })));
				c.appendChild(this.tb('<span>' + (n.galleryStyle === 'cover' ? 'Cover images' : 'Cover banner') + '</span>' + WB_I.chev, 'Gallery style, as in the gallery view', (b) => this.menu(b, [{ v: 'cover-banner', label: 'Cover banner', icon: 'ti-photo' }, { v: 'cover', label: 'Cover images', icon: 'ti-book' }], n.galleryStyle || 'cover-banner', (v) => { n.galleryStyle = v; n._rev = (n._rev || 0) + 1; this.renderNode(n); this.scheduleSave(); }, { width: 180 })));
			}
		}
		if (comp && rec) {
			const shown = new Set(cfg.fieldIds); const empties = wbFieldsOf(comp).filter((f) => shown.has(f.id)).filter((f) => { try { return !(rec.prop(f.label) && rec.prop(f.label).count && rec.prop(f.label).count()); } catch (e) { return true; } });
			if (empties.length) c.appendChild(this.tb(WB_I.plus + '<span>Fill in</span>' + WB_I.chev, 'Fill in an empty property', (b) => this.menu(b, empties.map((f) => ({ v: f.id, label: f.label, icon: f.icon || 'ti-align-left' })), null, (fid) => this.fillIn(n, fid), { width: 220 })));
		}
	},
	// ---- creating cards: the Card tool picker ---------------------------------------------
	// A page board creates in its page's collection; a collection board in its collection (a dynamic one asks); else the remembered preference.
	async homeCollection() {
		const cols = await this.plugin.refreshCols();
		try { if (this.isCollectionBoard && this.isCollectionBoard() && this.collection && !this.plugin.isDynamicCollection(this.collection)) return this.collection; } catch (e) {}
		try { const pg = this.rec.linkedRecord(WB_F.page.label); const row = pg && wbRow(pg); if (row) { const c = cols.find((x) => x.getGuid && x.getGuid() === row.pguid); if (c && !this.plugin.isExcludedCollection(c)) return c; } } catch (e) {}
		return null;
	},
	openCardPicker(wx, wy, anchorPt, onPlace) {
		this.plugin.closeMenus();
		const pop = wbEl('div', 'wb-picker'); pop.addEventListener('pointerdown', (e) => e.stopPropagation());
		const inp = document.createElement('input'); inp.placeholder = 'Find a page, or type a title for a new one'; pop.appendChild(inp);
		const list = wbEl('div', 'wb-plist'); pop.appendChild(list);
		let rows = [], active = 0, seq = 0;
		const place = (guid) => { this.plugin.closeMenus(); if (onPlace) onPlace(guid); else this.addCard(guid, wx, wy); };
		const createCol = async () => { if (this._createCol) return this._createCol; const own = await this.homeCollection(); return own || this.plugin.createCollectionPref(); };
		const paint = async () => {
			const q = inp.value.trim(); const my = ++seq; list.innerHTML = ''; rows = [];
			const add = (icon, label, meta, fn) => { const r = wbEl('div', 'wb-prow', '<span class="ti ' + wbEsc(icon) + '"></span><span class="wb-plabel">' + wbEsc(label) + '</span>' + (meta ? '<span class="wb-pmeta">' + wbEsc(meta) + '</span>' : '')); r.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); r.addEventListener('mouseenter', () => { active = rows.indexOf(r); mark(); }); list.appendChild(r); rows.push(r); };
			const col = await createCol(); if (my !== seq) return;
			if (q) { list.appendChild(wbEl('div', 'wb-psec', 'Pages')); let res = null; try { res = await this.plugin.data.searchByQuery(q, 30); } catch (e) {} if (my !== seq) return; const recs = (res && res.records) || []; if (!recs.length) list.appendChild(wbEl('div', 'wb-psec', 'No matches')); for (const r of recs.slice(0, 30)) add((r.getIcon && r.getIcon(true)) || 'ti-file-text', r.getName() || 'Untitled', this.plugin.collectionNameOf(r), () => place(r.guid)); }
			list.appendChild(wbEl('div', 'wb-psec', 'Create'));
			add('ti-plus', q ? 'New page "' + q + '"' : 'New page', 'in ' + (col ? col.getName() : '?'), async () => { const guid = await this.plugin.createPage(q || 'Untitled', col); if (guid) place(guid); });
			add('ti-folder', 'Create in another collection', '', () => this.plugin.pickCollection(pop, async (c2) => { this._createCol = c2; this.plugin.setCreateCollectionPref(c2); paint(); }));
			active = 0; mark();
		};
		const mark = () => rows.forEach((r, i) => r.classList.toggle('is-on', i === active));
		inp.addEventListener('input', () => { clearTimeout(inp._t); inp._t = setTimeout(paint, 120); });
		inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(rows.length - 1, active + 1); mark(); } else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); mark(); } else if (e.key === 'Enter') { e.preventDefault(); if (rows[active]) rows[active].click(); } });
		this.host.appendChild(pop); this.plugin._pop = pop;
		const hr = this.host.getBoundingClientRect(); pop.style.left = Math.max(hr.left + 8, Math.min(anchorPt.x, hr.right - 328)) + 'px'; pop.style.top = Math.max(hr.top + 8, Math.min(anchorPt.y, hr.bottom - 380)) + 'px';
		const out = (e) => { if (!pop.contains(e.target)) this.plugin.closeMenus(); }; document.addEventListener('pointerdown', out, true); pop._out = out;
		paint(); setTimeout(() => inp.focus(), 0);
	},
	addCard(recordGuid, wx, wy, opts) {
		this.pushHistory();
		const w = (opts && opts.w) || 220; const n = wbNode('card', Math.round(wx - w / 2), Math.round(wy - 40), w, 80, { recordGuid }); if (this.isCollectionBoard()) setTimeout(() => this.syncCollection(), 50);
		this.scene.nodes.push(n); this.selected = new Set([n.id]); this.selectedEdge = null; this.setTool('select'); this.renderAll(); this.scheduleSave();
		return n;
	},
	addLineCard(recordGuid, lineGuid, wx, wy) {
		this.pushHistory();
		const n = wbNode('line', Math.round(wx - 120), Math.round(wy - 30), 240, 60, { recordGuid, lineGuid });
		this.scene.nodes.push(n); this.selected = new Set([n.id]); this.selectedEdge = null; this.setTool('select'); this.renderAll(); this.scheduleSave();
		return n;
	},
	// ---- promote a sticky / text / shape to a page -----------------------------------------------
	async promoteToPage(n, col) {
		const title = (n.text || '').trim().split('\n')[0].slice(0, 120) || 'Untitled';
		const guid = await this.plugin.createPage(title, col); if (!guid) return;
		const rest = (n.text || '').trim().split('\n').slice(1).join('\n').trim();
		if (rest) { try { const rec = await this.plugin.record(guid); if (rec && rec.insertFromPlainText) rec.insertFromPlainText(rest, null, null); } catch (e) {} }
		this.pushHistory();
		const card = wbNode('card', n.x, n.y, Math.max(200, n.w), 80, { recordGuid: guid });
		this.scene.nodes = this.scene.nodes.map((x) => (x.id === n.id ? card : x));
		for (const e of this.scene.edges) { if (e.from === n.id) e.from = card.id; if (e.to === n.id) e.to = card.id; }
		this.selected = new Set([card.id]); this.renderAll(); this.scheduleSave();
		this.plugin.toast('Made a page in ' + (col ? col.getName() : 'the collection') + '.');
	},
});

Object.assign(Plugin.prototype, {
	recordSync(guid) { return (this._recs && this._recs.get(guid)) || null; },
	async refetch(guid) { this._recs = this._recs || new Map(); let rec = null; try { rec = await this.data.getRecord(guid); } catch (e) {} if (rec) this._recs.set(guid, rec); return rec; },
	async record(guid) {
		// A record instance handed out by getAllRecords()/search may be detached: property writes on it are silently
		// dropped (the Boards link that never appeared, 2026-09-05). data.getRecord() is authoritative, the cache is a fallback.
		this._recs = this._recs || new Map();
		let rec = null; try { rec = await this.data.getRecord(guid); } catch (e) {}
		if (!rec && this._recs.has(guid)) return this._recs.get(guid);
		if (rec && rec.isTrashed && rec.isTrashed()) rec = null;
		if (rec) this._recs.set(guid, rec); return rec;
	},
	collectionNameOf(rec) { try { const row = wbRow(rec); const cols = this._colsCache || []; const c = cols.find((x) => x.getGuid && x.getGuid() === (row && row.pguid)); return c ? c.getName() : ''; } catch (e) { return ''; } },
	async refreshCols() {
		try { const a = (await this.data.getAllCollections()) || []; let d = []; try { d = (this.data.getAllDynamicCollections ? await this.data.getAllDynamicCollections() : []) || []; } catch (e) {} for (const c of d) { try { c._wbDynamic = true; } catch (e) {} } const merged = a.concat(d); if (merged.length || !(this._colsCache || []).length) { this._colsCache = merged; wbColsLast = this._colsCache; } } catch (e) {}
		return this._colsCache || [];
	},
	isDynamicCollection(col) { try { return !!(col && (col._wbDynamic || (!col.createRecord && col.getAllRecords))); } catch (e) { return false; } },
	async createCollectionPref() {
		const cols = await this.refreshCols(); let guid = null; try { guid = localStorage.getItem('wb_create_col'); } catch (e) {}
		let col = guid ? cols.find((c) => c.getGuid && c.getGuid() === guid) : null;
		if (!col) col = cols.find((c) => /^notes$/i.test(c.getName())) || cols.find((c) => /^(captures|inbox|pages)$/i.test(c.getName())) || null;
		if (!col) { for (const b of this.boards.values()) { try { const pg = b.rec.linkedRecord(WB_F.page.label); const row = wbRow(pg); if (row) col = cols.find((c) => c.getGuid && c.getGuid() === row.pguid) || null; } catch (e) {} if (col) break; } }
		if (!col) col = cols.find((c) => !(c.isJournalPlugin && c.isJournalPlugin()) && c.getName() !== WB_BOARDS && !/plexus/i.test(c.getName())) || null;
		return col;
	},
	setCreateCollectionPref(col) { try { localStorage.setItem('wb_create_col', col.getGuid()); } catch (e) {} },
	async pickCollection(anchor, onPick) {
		// Right after a code reload the data layer can answer with nothing for a moment. Retry instead of opening a menu
		// with no rows in it, which is what "No matches" under Make page was.
		let cols = [];
		for (let i = 0; i < 4; i++) { cols = (await this.refreshCols()).filter((c) => !(c.isJournalPlugin && c.isJournalPlugin()) && c.getName() !== WB_BOARDS); if (cols.length) break; await wbSleep(180); }
		if (!cols.length) { this.toast('The collections have not loaded yet. Try again in a moment.'); return; }
		wbMenu(anchor, cols.map((c) => { let icon = 'ti-folder'; try { icon = c.getConfiguration().icon || icon; } catch (e) {} return { v: c.getGuid(), label: c.getName(), icon }; }), null, (v) => { const c = cols.find((x) => x.getGuid() === v); if (c) onPick(c); }, { width: 260, search: cols.length > 8, searchPlaceholder: 'Find a collection' });
	},
	// today's (or a date's) journal page of the current user: journal collection + { workspaceGuid, guid: USER guid }
	async journalRecord(dt) {
		try {
			const cols = (await this.data.getAllCollections()) || []; const jc = cols.find((c) => c.isJournalPlugin && c.isJournalPlugin()); if (!jc) return null;
			// ref.guid is interpolated into the record id, so a non-string mints a page
			// called S-<coll>-[object Object]-0-<date> that breaks Markdown Mirror sync
			const me = this.me(); const userGuid = (me && me.guid) || (this.user && this.user.guid);
			if (typeof userGuid !== 'string' || !userGuid) return null;
			return await jc.getJournalRecord({ workspaceGuid: this.getWorkspaceGuid(), guid: userGuid }, dt || undefined);
		} catch (e) { console.warn('[Whiteboard] journal lookup failed', e); return null; }
	},
	async createPage(title, col) {
		if (!col) col = await this.createCollectionPref(); if (!col) { this.toast('No collection to create the page in.'); return null; }
		let guid = null; try { guid = col.createRecord(title); } catch (e) {}
		if (typeof guid !== 'string') { this.toast('Could not create the page.'); return null; }
		await wbRecordPoll(this, guid, 30); return guid;
	},
	async openRecord(guid, panel, beside) {
		const nav = { type: 'edit_panel', rootId: guid, subId: null, workspaceGuid: this.getWorkspaceGuid(), state: { positions: [guid, 'empty-' + guid, 0, 'L'] } };
		if (beside) { const p = await this.ui.createPanel({ afterPanel: panel }); if (p) p.navigateTo(nav); return; }
		this._noAuto.add(guid); setTimeout(() => this._noAuto.delete(guid), 4000); panel.navigateTo(nav);
	},
	async openLine(recordGuid, lineGuid, panel, beside) {
		let p = panel; if (beside || !p) { p = await this.ui.createPanel({ afterPanel: panel }); if (!p) return; }
		const ws = this.getWorkspaceGuid(); const nav = { type: 'edit_panel', rootId: recordGuid, subId: null, workspaceGuid: ws, state: { positions: [lineGuid || recordGuid, 'empty-' + recordGuid, 0, 'L'] } };
		try { p.navigateTo(nav); } catch (e) { try { p.navigateTo({ type: 'edit_panel', rootId: recordGuid, subId: null, workspaceGuid: ws }); } catch (x) {} }
		try { this.ui.setActivePanel(p); } catch (e) {}
	},
	async lineInfo(recordGuid, lineGuid) {
		const rec = await this.record(recordGuid); if (!rec) return null;
		let items = []; try { items = await rec.getLineItems(); } catch (e) {}
		const find = (list) => { for (const li of list || []) { if (li.guid === lineGuid) return li; const k = find(li.children || []); if (k) return k; } return null; };
		const li = find(items); if (!li) return null;
		const txt = (l) => { try { return (l.segments || []).map((s) => (s.type === 'ref' && s.text && s.text.title) ? s.text.title : (typeof s.text === 'string' ? s.text : (s.text && s.text.title) || '')).join(''); } catch (e) { return ''; } };
		let kids = []; try { kids = li.children || (await li.getChildren()) || []; } catch (e) {}
		return { text: txt(li), children: kids.map(txt), page: rec.getName() || 'Untitled', icon: (rec.getIcon && rec.getIcon(true)) || 'ti-file-text' };
	},
});

// ===========================================================================
// Smart Links: property pairs (Bidirectional Fields' model). An edge with `smart` writes
// the relation into the pages; a plain edge lives only on the board.
// ===========================================================================
function wbParsePairs(raw) {
	const out = [];
	for (const p of raw || []) {
		try {
			if (Array.isArray(p) && p.length === 2) out.push({ aName: String(p[0]), aCol: null, bName: String(p[1]), bCol: null });
			else if (p && typeof p === 'object') { const a = p.a || p.left || p[0] || {}, b = p.b || p.right || p[1] || {}; const nm = (x) => (typeof x === 'string' ? x : (x.name || x.field || x.label || '')); const col = (x) => (typeof x === 'string' ? null : (x.col || x.collection || x.colguid || null)); if (nm(a) && nm(b)) out.push({ aName: nm(a), aCol: col(a), bName: nm(b), bCol: col(b), oneWay: !!p.oneWay }); }
		} catch (e) {}
	}
	return out;
}
Object.assign(Plugin.prototype, {
	async smartPairs() {
		let mine = []; try { mine = wbParsePairs((this.getConfiguration().custom || {}).pairs); } catch (e) {}
		let bf = [];
		try { const all = await this.data.getAllGlobalPlugins(); for (const g of all || []) { const conf = g.getConfiguration ? g.getConfiguration() : (g.kv && g.kv.$config) || null; const name = conf && conf.name; if (/bidirectional fields/i.test(String(name || ''))) { bf = wbParsePairs(conf.custom && conf.custom.pairs); break; } } } catch (e) {}
		const key = (p) => p.aName + '|' + (p.aCol || '') + '|' + p.bName + '|' + (p.bCol || '');
		const seen = new Set(); const out = [];
		for (const p of mine.concat(bf)) { const k = key(p); if (seen.has(k)) continue; seen.add(k); out.push(Object.assign({ fromBF: !mine.includes(p) }, p)); }
		return out;
	},
	saveSmartPairs(pairs) {
		try { const conf = this.getConfiguration(); conf.custom = conf.custom || {}; conf.custom.pairs = pairs.filter((p) => !p.fromBF).map((p) => ({ a: { name: p.aName, col: p.aCol || null }, b: { name: p.bName, col: p.bCol || null }, oneWay: !!p.oneWay })); this.saveConfiguration(conf); } catch (e) { console.warn('[Whiteboard] saveSmartPairs', e); }
	},
	// Which pairs fit an edge from record A (collection ca) to record B (collection cb)?
	pairsFor(pairs, compA, compB) {
		const has = (comp, name) => { try { return wbFieldsOf(comp).some((f) => f.label === name && f.type === 'record'); } catch (e) { return false; } };
		const out = [];
		for (const p of pairs) {
			const aOk = has(compA, p.aName) && (!p.aCol || p.aCol === compA.collectionRoot.guid); const bOk = has(compB, p.bName) && (!p.bCol || p.bCol === compB.collectionRoot.guid);
			if (aOk && (bOk || p.oneWay)) out.push({ pair: p, srcName: p.aName, dstName: p.oneWay ? null : p.bName, label: p.oneWay ? p.aName : p.aName + ' ↔ ' + p.bName });
			const aOk2 = has(compA, p.bName) && (!p.bCol || p.bCol === compA.collectionRoot.guid); const bOk2 = has(compB, p.aName) && (!p.aCol || p.aCol === compB.collectionRoot.guid);
			if (!p.oneWay && aOk2 && bOk2 && p.aName !== p.bName) out.push({ pair: p, srcName: p.bName, dstName: p.aName, label: p.bName + ' ↔ ' + p.aName });
		}
		// one-directional: any record field on A that may point at B's collection
		try { for (const f of wbFieldsOf(compA)) if (f.type === 'record' && (!f.filter_colguid || f.filter_colguid === compB.collectionRoot.guid) && !out.some((o) => o.srcName === f.label && !o.dstName)) out.push({ pair: null, srcName: f.label, dstName: null, label: f.label + ' →' }); } catch (e) {}
		return out;
	},
	async writeRelation(recA, recB, srcName, dstName, add) {
		const apply = (rec, name, otherGuid) => { try { const prop = rec.prop(name); if (!prop) return false; let cur = []; try { cur = (rec.linkedRecords(name) || []).map((r) => r.guid); } catch (e) {} if (add && cur.includes(otherGuid)) return true; if (!add && !cur.includes(otherGuid)) return true; if (add && prop.addValue && prop.isMultiValue && prop.isMultiValue()) prop.addValue(otherGuid); else if (!add && prop.removeValue && prop.isMultiValue && prop.isMultiValue()) prop.removeValue(otherGuid); else prop.set(add ? (prop.isMultiValue && prop.isMultiValue() ? cur.concat([otherGuid]) : [otherGuid]) : cur.filter((g) => g !== otherGuid)); return true; } catch (e) { console.warn('[Whiteboard] writeRelation', e); return false; } };
		const ok1 = apply(recA, srcName, recB.guid); const ok2 = dstName ? apply(recB, dstName, recA.guid) : true;
		return ok1 && ok2;
	},
});
Object.assign(WbBoard.prototype, {
	async smartLinkMenu(anchor, edge) {
		const a = this.nodeById(edge.from), b = this.nodeById(edge.to); if (!a || !b || a.type !== 'card' || b.type !== 'card') return;
		const recA = await this.plugin.record(a.recordGuid), recB = await this.plugin.record(b.recordGuid); const compA = recA && wbComponentFor(wbRow(recA).pguid), compB = recB && wbComponentFor(wbRow(recB).pguid);
		if (!compA || !compB) { this.plugin.toast('Could not read the collections of these pages.'); return; }
		const pairs = await this.plugin.smartPairs(); const fits = this.plugin.pairsFor(pairs, compA, compB);
		const items = fits.map((f, i) => ({ v: String(i), label: f.label, icon: f.dstName ? 'ti-arrows-left-right' : 'ti-arrow-right', alt: f.dstName ? 'writes both' : 'source only' }));
		items.push({ v: '__plain', label: 'Plain connector (board only)', icon: 'ti-line-dotted' });
		items.push({ v: '__pairs', label: 'Manage pairs', icon: 'ti-settings' });
		const cur = edge.smart ? String(fits.findIndex((f) => f.srcName === edge.smart.srcName && (f.dstName || null) === (edge.smart.dstName || null))) : '__plain';
		wbMenu(anchor, items, cur, async (v) => {
			if (v === '__pairs') { this.managePairs(anchor); return; }
			if (edge.smart) { await this.plugin.writeRelation(recA, recB, edge.smart.srcName, edge.smart.dstName, false); }
			if (v === '__plain') { this.pushHistory(); delete edge.smart; this.renderEdges(); this.buildCtx(); this.scheduleSave(); return; }
			const f = fits[Number(v)]; if (!f) return;
			const ok = await this.plugin.writeRelation(recA, recB, f.srcName, f.dstName, true);
			if (!ok) { this.plugin.toast('Could not write the relation.'); return; }
			this.pushHistory(); edge.smart = { srcName: f.srcName, dstName: f.dstName || null, label: f.label }; edge.route = edge.route || 'curved'; this.renderEdges(); this.buildCtx(); this.scheduleSave();
			this.plugin.toast('Linked: ' + f.label);
		}, { width: 280, dots: false });
	},
	async managePairs(anchor) {
		const pairs = await this.plugin.smartPairs();
		const items = pairs.map((p, i) => ({ v: String(i), label: p.aName + ' ↔ ' + p.bName + (p.fromBF ? '  (Bidirectional Fields)' : ''), icon: p.fromBF ? 'ti-lock' : 'ti-arrows-left-right' }));
		items.push({ v: '__add', label: 'Add a pair', icon: 'ti-plus' });
		wbMenu(anchor, items, null, async (v) => {
			if (v === '__add') { this.addPairFlow(anchor); return; }
			const p = pairs[Number(v)]; if (!p || p.fromBF) { this.plugin.toast('That pair comes from Bidirectional Fields. Edit it there.'); return; }
			wbMenu(anchor, [{ v: 'del', label: 'Remove ' + p.aName + ' ↔ ' + p.bName, icon: 'ti-trash' }], null, () => { this.plugin.saveSmartPairs(pairs.filter((x) => x !== p)); this.plugin.toast('Pair removed.'); }, { width: 260, dots: false });
		}, { width: 320, dots: false });
	},
	async addPairFlow(anchor) {
		// Two picks: a record field (with its collection), then its partner.
		const cols = await this.plugin.refreshCols(); const fields = [];
		for (const c of cols) { let conf = null; try { conf = c.getConfiguration(); } catch (e) {} for (const f of (conf && conf.fields) || []) if (f.type === 'record' && f.active !== false) fields.push({ v: c.getGuid() + '|' + f.label, label: f.label, alt: c.getName(), icon: f.icon || 'ti-link', col: c.getGuid(), name: f.label, colName: c.getName() }); }
		const pick = (title, cb) => wbMenu(anchor, fields.map((f) => ({ v: f.v, label: f.label + '  · ' + f.colName, icon: f.icon })), null, (v) => cb(fields.find((f) => f.v === v)), { width: 320, search: true, searchPlaceholder: title, dots: false });
		pick('First field', (a) => { if (!a) return; setTimeout(() => pick('Its partner', async (b) => { if (!b) return; const pairs = await this.plugin.smartPairs(); pairs.push({ aName: a.name, aCol: a.col, bName: b.name, bCol: b.col }); this.plugin.saveSmartPairs(pairs); this.plugin.toast('Pair added: ' + a.name + ' ↔ ' + b.name); }), 50); });
	},
	confirmSmartDelete(edge, then) {
		const a = this.nodeById(edge.from), b = this.nodeById(edge.to);
		this.plugin.closeMenus();
		const pop = wbEl('div', 'wb-confirm'); pop.addEventListener('pointerdown', (e) => e.stopPropagation());
		pop.appendChild(wbEl('div', '', 'This connector wrote <b>' + wbEsc(edge.smart.label) + '</b> into the pages. Remove the relation too?'));
		const btns = wbEl('div', 'wb-cbtns');
		const mk = (label, cls, fn) => { const x = wbEl('div', 'wb-cbtn ' + (cls || ''), label); x.addEventListener('click', (e) => { e.stopPropagation(); this.plugin.closeMenus(); fn(); }); btns.appendChild(x); };
		mk('Keep relation', '', () => then(false)); mk('Remove both', 'wb-primary', async () => { try { const recA = await this.plugin.record(a.recordGuid), recB = await this.plugin.record(b.recordGuid); if (recA && recB) await this.plugin.writeRelation(recA, recB, edge.smart.srcName, edge.smart.dstName, false); } catch (e) {} then(true); });
		pop.appendChild(btns); this.host.appendChild(pop); this.plugin._pop = pop;
		const r = this.canvas.getBoundingClientRect(); pop.style.left = (r.left + r.width / 2 - 150) + 'px'; pop.style.top = (r.top + 80) + 'px';
		const out = (e) => { if (!pop.contains(e.target)) this.plugin.closeMenus(); }; document.addEventListener('pointerdown', out, true); pop._out = out;
	},
});
{
	// Edge rendering: smart edges get a second faint line and a teal label; toolbar gets the Smart Link menu; delete confirms.
	const baseRenderEdges = WbBoard.prototype.renderEdges;
	WbBoard.prototype.renderEdges = function () {
		baseRenderEdges.call(this);
		for (const e of this.scene.edges) {
			const ent = this.edgeEls.get(e.id); if (!ent) continue;
			const smart = !!e.smart; ent.grp.classList.toggle('wb-smart', smart);
			let l2 = ent.grp.querySelector('.wb-line2');
			if (smart) { if (!l2) { l2 = wbSvgEl('path', { class: 'wb-line2' }); ent.grp.insertBefore(l2, ent.line); } l2.setAttribute('d', ent.line.getAttribute('d')); l2.setAttribute('stroke-width', (e.width || 1.5)); l2.setAttribute('transform', 'translate(0,-4)'); }
			else if (l2) l2.remove();
			ent.label.classList.toggle('wb-smartlbl', smart);
			if (smart && !e.label && ent.label.getAttribute('contenteditable') !== 'true') ent.label.textContent = e.smart.label;
		}
	};
	const baseBuildCtx = WbBoard.prototype.buildCtx;
	WbBoard.prototype.buildCtx = function () {
		baseBuildCtx.call(this);
		const edge = this.selectedEdge ? this.scene.edges.find((x) => x.id === this.selectedEdge) : null; if (!edge || !this.ctx) return;
		const a = this.nodeById(edge.from), b = this.nodeById(edge.to); if (!a || !b || a.type !== 'card' || b.type !== 'card') return;
		const btn = this.tb(WB_SVG('<path d="M10 14a3.5 3.5 0 0 0 5 0l4-4a3.5 3.5 0 0 0-5-5l-.5.5"></path><path d="M14 10a3.5 3.5 0 0 0-5 0l-4 4a3.5 3.5 0 0 0 5 5l.5-.5"></path>') + '<span>' + (edge.smart ? wbEsc(edge.smart.label) : 'Smart Link') + '</span>' + WB_I.chev, 'Write this connection into the pages as a relation', (x) => this.smartLinkMenu(x, edge), !!edge.smart);
		const del = [...this.ctx.querySelectorAll('.wb-tb')].find((x) => x.title === 'Delete');
		this.ctx.insertBefore(this.sep(), del || null); this.ctx.insertBefore(btn, del || null);
	};
	const baseDelete = WbBoard.prototype.deleteSelection;
	WbBoard.prototype.deleteSelection = function () {
		if (this.selectedEdge) { const e = this.scene.edges.find((x) => x.id === this.selectedEdge); if (e && e.smart) { this.confirmSmartDelete(e, () => baseDelete.call(this)); return; } }
		return baseDelete.call(this);
	};
}

// ===========================================================================
// Drag pages and lines in from Thymer's own views (sidebar, table, board, gallery, list, editor lines).
// Observed at document level; Thymer's own drag keeps working, we only act on a drop over a board.
// ===========================================================================
const WB_DRAG_SRC = '.sidebar-item[data-guid], .table-view-row[data-guid], .board-card[data-guid], .gallery-view-card[data-guid], .collection-list-card[data-guid], .listitem[data-guid]';
Object.assign(Plugin.prototype, {
	bindExternalDrag() {
		const st = { cand: null, active: false, ghost: null };
		const down = (e) => {
			if (e.button !== 0 || !this.boards.size) return; const t = e.target; if (!t || !t.closest || t.closest('.wb-host')) return;
			const src = t.closest(WB_DRAG_SRC); if (!src) return;
			const guid = src.dataset.guid; if (!guid) return;
			st.cand = { guid, isLine: src.classList.contains('listitem'), x: e.clientX, y: e.clientY, label: (src.textContent || '').trim().slice(0, 60) }; st.active = false;
		};
		const move = (e) => {
			if (!st.cand) return;
			if (!st.active) { if (Math.hypot(e.clientX - st.cand.x, e.clientY - st.cand.y) < 8) return; st.active = true; st.ghost = wbEl('div', 'wb-dragghost', '<span class="ti ti-file-text"></span><span>' + wbEsc(st.cand.label || 'Page') + '</span>'); document.body.appendChild(st.ghost); }
			st.ghost.style.left = (e.clientX + 12) + 'px'; st.ghost.style.top = (e.clientY + 12) + 'px';
			const over = this.boardAtPoint(e.clientX, e.clientY); st.ghost.classList.toggle('is-over', !!over);
		};
		const up = async (e) => {
			const c = st.cand; const was = st.active; st.cand = null; st.active = false; if (st.ghost) { st.ghost.remove(); st.ghost = null; }
			if (!c || !was) return;
			const b = this.boardAtPoint(e.clientX, e.clientY); if (!b) return;
			const pt = b.localPt(e); const w = b.toWorld(pt.x, pt.y);
			if (c.isLine) { const recGuid = this.recordGuidOfLine(c.guid); if (recGuid) b.addLineCard(recGuid, c.guid, w.x, w.y); else this.toast('Could not find the page of that line.'); return; }
			const cols = await this.refreshCols(); if (cols.some((x) => x.getGuid && x.getGuid() === c.guid)) { this.toast('Drop a page, not a collection.'); return; }
			b.addCard(c.guid, w.x, w.y);
		};
		document.addEventListener('pointerdown', down, true); document.addEventListener('pointermove', move, true); document.addEventListener('pointerup', up, true); document.addEventListener('pointercancel', up, true);
		this._extDragOff = () => { document.removeEventListener('pointerdown', down, true); document.removeEventListener('pointermove', move, true); document.removeEventListener('pointerup', up, true); document.removeEventListener('pointercancel', up, true); if (st.ghost) st.ghost.remove(); };
	},
	boardAtPoint(x, y) {
		// Thymer's own drag clone (and our ghost) sit under the pointer: look through all layers for a board canvas.
		const els = document.elementsFromPoint(x, y);
		for (const el of els) { if (el.closest && el.closest('.wb-dragghost, .drag-clone')) continue; const cv = el.closest ? el.closest('.wb-canvas') : null; if (!cv) { if (el.closest && el.closest('.wb-host')) continue; else break; } const host = cv.closest('.wb-host'); for (const b of this.boards.values()) if (b.host === host && !b.destroyed) return b; }
		return null;
	},
	recordGuidOfLine(lineGuid) { try { const it = window.g_universe && window.g_universe.itemsByGuid && window.g_universe.itemsByGuid[lineGuid]; if (!it) return null; let cur = it, n = 0; while (cur && n++ < 200) { if (cur.type === 'document' || cur.type === 'page' || (cur.pguid && window.g_universe.itemsByGuid[cur.pguid] && window.g_universe.itemsByGuid[cur.pguid].type === 'collection')) return cur.guid; const parent = cur.pguid ? window.g_universe.itemsByGuid[cur.pguid] : null; if (!parent) return cur.rguid || null; cur = parent; } } catch (e) {} return null; },
});

// ===========================================================================
// Collection board: a board bound to a collection. Its records stream in as cards, grouped by a property.
// ===========================================================================
// ==== wbMergeScene (extracted verbatim by the offline test) ====
// Three-way merge of a board: base = the server state this device last knew, local = what is on screen, remote = the newer server
// state another device saved. Per element (by id) and per property: a property only this side changed keeps this side's value,
// one only the other side changed takes theirs, and when both changed it, this device wins, because its save comes last.
// An element deleted on one side and untouched on the other is gone; deleted on one side and edited on the other, the side that
// deleted wins if it is local (his last action here), the edit survives if the deletion came from elsewhere.
function wbMergeVal(b, l, r) {
	const jb = JSON.stringify(b), jl = JSON.stringify(l), jr = JSON.stringify(r);
	if (jl === jb) return r; if (jr === jb || jr === jl) return l;
	const idArr = (a) => Array.isArray(a) && a.every((x) => x && typeof x === 'object' && typeof x.id === 'string');
	if (idArr(l) && idArr(r) && (b === undefined || idArr(b))) return wbMergeById(b || [], l, r);
	const obj = (x) => x && typeof x === 'object' && !Array.isArray(x);
	if (obj(l) && obj(r) && (b === undefined || obj(b))) { const bb = b || {}; const out = {}; for (const k of new Set([...Object.keys(bb), ...Object.keys(l), ...Object.keys(r)])) { const v = wbMergeVal(bb[k], l[k], r[k]); if (v !== undefined) out[k] = v; } return out; }
	return l;
}
function wbMergeById(bA, lA, rA) {
	const B = new Map(bA.map((x) => [x.id, x])), L = new Map(lA.map((x) => [x.id, x])), R = new Map(rA.map((x) => [x.id, x]));
	const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
	const keep = new Map();
	for (const id of new Set([...B.keys(), ...L.keys(), ...R.keys()])) {
		const b = B.get(id), l = L.get(id), r = R.get(id);
		if (!b) { if (l && r) keep.set(id, wbMergeVal(undefined, l, r)); else if (l || r) keep.set(id, l || r); continue; }
		if (!l && !r) continue;
		if (!l) continue; // deleted here: his last action on this device wins
		if (!r) { if (!same(l, b)) keep.set(id, l); continue; } // deleted elsewhere: gone, unless it was edited here since
		keep.set(id, wbMergeVal(b, l, r));
	}
	// paint order: the remote order, unless only this side reordered; elements new on the other side go on top (they are the newest),
	// an old element brought back (edited here, deleted elsewhere) returns after its predecessor
	const common = (arr) => arr.map((x) => x.id).filter((id) => B.has(id) && L.has(id) && R.has(id));
	const primary = (JSON.stringify(common(rA)) === JSON.stringify(common(bA))) ? lA : rA; const other = primary === lA ? rA : lA;
	const ids = primary.map((x) => x.id).filter((id) => keep.has(id));
	other.forEach((x, i) => { if (!keep.has(x.id) || ids.includes(x.id)) return; let at = ids.length; if (!B.has(x.id)) { ids.push(x.id); return; } for (let j = i - 1; j >= 0; j--) { const k = ids.indexOf(other[j].id); if (k >= 0) { at = k + 1; break; } } ids.splice(at, 0, x.id); });
	return ids.map((id) => keep.get(id));
}
function wbMergeScene(base, local, remote) {
	const out = {};
	for (const k of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
		if (k === 'rev' || k === 'savedAt' || k === 'view' || k === 'saveId' || k === 'hist') continue;
		const v = wbMergeVal(base[k], local[k], remote[k]); if (v !== undefined) out[k] = v;
	}
	out.view = local.view; out.rev = remote.rev; out.savedAt = remote.savedAt; if (remote.saveId) out.saveId = remote.saveId; if (remote.hist) out.hist = remote.hist;
	return out;
}
// ==== end wbMergeScene ====
function wbSceneJson(scene) { return JSON.stringify(scene, (k, v) => (typeof k === 'string' && k.startsWith('_')) ? undefined : v); } // runtime-only fields stay out of the file
const WB_REFS_HEADING = 'On this board';
function wbSpawnable(n) { return !!n && (n.type === 'sticky' || n.type === 'shape' || n.type === 'text'); }
function wbOppositeSide(s) { return { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }[s] || null; }
const WB_FOLDER_AR = 280 / 225; // the folder drawing (folder-icon.svg, designed in Figma) is 280 x 225
const WB_COLL_MAX = 300; // cards a collection board will mirror at once
const WB_F_COLL = { id: 'FWBCOLL00000001', label: 'Mirrors', type: 'text', icon: 'ti-folder' }; // guid of the collection a collection board mirrors (not "Collection": native already has that property)
Object.assign(Plugin.prototype, {
	async ensureBoardsFields() {
		const col = await this.boardsCollection(false); if (!col) return;
		try {
			const conf = col.getConfiguration(); conf.fields = conf.fields || []; let changed = false;
			for (const f of [WB_F.scene, WB_F.page, WB_F.rev, WB_F_COLL]) { const ex = conf.fields.find((x) => x.id === f.id); if (!ex) { conf.fields.push({ id: f.id, label: f.label, type: f.type, icon: f.icon, active: true, many: f.id === WB_F.page.id, read_only: false }); changed = true; } else if (ex.label !== f.label) { ex.label = f.label; changed = true; } }
			const pf = conf.fields.find((x) => x.id === WB_F.page.id); if (pf && !pf.many) { pf.many = true; changed = true; } // 0.2.67: a board can sit on several pages
			const old = conf.fields.find((x) => x.id === WB_F_KIND_OLD); if (old && old.active !== false) { old.active = false; changed = true; } // retire Kind
			if (changed) await col.saveConfiguration(conf);
		} catch (e) {}
	},
	collFieldLabel() { try { const f = (this._boardsCol.getConfiguration().fields || []).find((x) => x.id === WB_F_COLL.id); return (f && f.label) || WB_F_COLL.label; } catch (e) { return WB_F_COLL.label; } },
	boardCollectionGuid(rec) { try { return (rec.text(this.collFieldLabel()) || '').trim() || null; } catch (e) { return null; } },
	async findCollectionBoard(colGuid) { for (const r of await this.allBoards()) if (this.boardCollectionGuid(r) === colGuid) return r; return null; },
	async openCollectionBoard(col, panel) {
		this._collOpen = this._collOpen || new Map(); const key = col.getGuid();
		if (this._collOpen.has(key)) return this._collOpen.get(key);
		const run = (async () => {
			await this.ensureBoardsFields();
			let board = await this.findCollectionBoard(key);
			if (!board) { board = await this.createBoard(col.getName() + ' board', null); if (!board) return; try { board.prop(this.collFieldLabel()).set(key); } catch (e) {} await wbSleep(300); }
			this.openBoard(board.guid, panel);
		})();
		this._collOpen.set(key, run); try { await run; } finally { this._collOpen.delete(key); }
	},
	// His ruling 2026-09-19: the toolbar icon opens a picker, not a board. Built like Thymer's own Seed picker: "New Board"
	// above the search field, then the boards that belong to THIS collection (a collection can have several), and the search
	// reaches every other board as well — those rows stay hidden until something is typed, so the default list stays short.
	async collectionBoardMenu(anchor, col, panel) {
		const key = col.getGuid();
		await this.ensureBoardsFields();
		let recs = await this.allBoards();
		// Straight after a code reload the collection list can still be empty, and an empty answer would show a picker that
		// claims there are no boards at all (measured: it happened on the first click after every deploy, and 400 ms was not
		// enough). Backs off up to three times, and only on that path — a warm lookup answers in about 90 ms.
		for (let i = 0; !recs.length && i < 3; i++) { await wbSleep(300 * (i + 1)); recs = await this.allBoards(); }
		const mine = recs.filter((r) => this.boardCollectionGuid(r) === key);
		// A board also belongs here when it hangs on a PAGE in this collection, which is how every board on his workspace is
		// attached today; without this the picker would say "no boards" for a collection that plainly has some.
		const onPage = recs.filter((r) => !mine.includes(r) && this.boardPages(r).some((pg) => { try { const row = wbRow(pg); return !!row && row.pguid === key; } catch (e) { return false; } }));
		const others = recs.filter((r) => !mine.includes(r) && !onPage.includes(r));
		const name = (r) => r.getName() || 'Untitled';
		const upd = (r) => { try { const row = wbRow(r); return (row && (row.u_at || row.c_at)) || 0; } catch (e) { return 0; } };
		// Above the search field: New Board and everything that already belongs here, so the section you came for never
		// scrolls away or gets filtered out. Below it: the search, and the five most recently touched boards from elsewhere.
		const here = mine.concat(onPage);
		const bar = anchor.closest('.records-view-toolbar-actions');
		const gutter = Math.max(24, bar ? Math.round(window.innerWidth - bar.getBoundingClientRect().right) : 24);
		const rows = [{ v: 'new', label: 'New Board', icon: 'ti-plus', head: true }];
		if (here.length) rows.push({ title: 'Boards in this collection', head: true });
		for (const r of here) rows.push({ v: 'b:' + r.guid, label: name(r), icon: 'ti-layout-board', head: true });
		// No section title down here (his ruling): the search field's own placeholder says what the lower half is, so the
		// divider is the only thing separating it from the collection's own boards.
		rows.push({ sep: true, head: true });
		const recent = others.slice().sort((a, b) => upd(b) - upd(a)).slice(0, 5);
		for (const r of recent) rows.push({ v: 'b:' + r.guid, label: name(r), icon: 'ti-layout-board', idle: true });
		for (const r of others) rows.push({ v: 'b:' + r.guid, label: name(r), icon: 'ti-layout-board', hidden: true });
		// The list must never be empty, or the menu reads "No matches" when the truth is simply that there are none yet.
		if (!others.length) rows.push({ v: 'none', label: 'No other boards yet', icon: 'ti-layout-board', idle: true });
		wbMenu(anchor, rows, null, (v) => {
			if (v === 'none') return;
			if (v === 'new') { this.newCollectionBoard(col, panel); return; }
			if (v.indexOf('b:') === 0) this.openBoard(v.slice(2), panel);
				// The button sits near the right end of the panel, so hanging the menu from its LEFT edge pressed it against the window.
		// The keep-clear margin is measured from where the TOOLBAR ROW ends (his panel: 65 px of gutter), so the menu stops
		// level with the row it belongs to rather than with the screen. alignTo would have done it too, but that element also
		// sets the menu's minimum width, and the row is 381 px wide.
		}, { width: 280, dots: false, search: true, searchPlaceholder: 'Find Other Boards', checks: false, startTop: true, edge: gutter });
	},
	// A second, third ... board for the same collection: same Collection field, a name that says which one it is.
	async newCollectionBoard(col, panel) {
		await this.ensureBoardsFields();
		const key = col.getGuid();
		const n = (await this.allBoards()).filter((r) => this.boardCollectionGuid(r) === key).length;
		const board = await this.createBoard(col.getName() + ' board' + (n ? ' ' + (n + 1) : ''), null);
		if (!board) return;
		try { board.prop(this.collFieldLabel()).set(key); } catch (e) {}
		await wbSleep(300);
		this.openBoard(board.guid, panel);
	},
	// "Add Board for This Collection" ALWAYS makes a new board for the collection (his ruling 2026-09-27); existing ones are opened from
	// the board icon in the collection's toolbar, the Boards collection or Find Boards.
	async addBoardForActiveCollection() {
		const panel = this.ui.getActivePanel(); let col = null; try { col = panel && panel.getActiveCollection ? panel.getActiveCollection() : null; } catch (e) {}
		let rec = null; try { rec = panel && panel.getActiveRecord ? panel.getActiveRecord() : null; } catch (e) {}
		if (!col || rec) { this.toast('Open a collection first.'); return; } // a page reports its collection too; that is not a collection view
		if (this.isExcludedCollection(col)) { this.toast('Boards are not available for Journal or Timer.'); return; }
		await this.ensureBoardsFields();
		const board = await this.createBoard(col.getName() + ' board', null); if (!board) return;
		try { board.prop(this.collFieldLabel()).set(col.getGuid()); } catch (e) {}
		await wbSleep(300); return this.openBoard(board.guid, panel);
	},
});
const WB_COLL_CSS = [
'.wb-dragghost{position:fixed;z-index:100005;pointer-events:none;display:flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:var(--radius-normal,3px);background:var(--cmdpal-bg-color,#212126);border:1px dashed var(--color-primary-500,#65c8bb);color:var(--text-color);font-size:12px;box-shadow:0 4px 6px rgba(0,0,0,.2);opacity:.9;}',
'.wb-dragghost.is-over{border-style:solid;}',
'.wb-section{position:absolute;border:1px solid var(--wb-line);border-radius:var(--wb-radius);background:color-mix(in srgb,var(--wb-text) 3%,transparent);pointer-events:none;}',
'.wb-section .wb-secname{position:absolute;left:10px;top:-9px;padding:0 6px;background:var(--wb-bg);font-size:11px;color:var(--wb-muted);white-space:nowrap;}',
'.wb-section .wb-secadd{position:absolute;right:10px;top:-11px;height:22px;padding:0 8px 0 6px;display:inline-flex;align-items:center;gap:4px;border-radius:var(--wb-radius);background:var(--wb-surface);border:1px solid var(--wb-line);font-size:11px;color:var(--wb-muted);cursor:pointer;pointer-events:auto;}',
'.wb-section .wb-secadd:hover{color:var(--wb-text);}',
'.wb-section .wb-secadd svg{width:11px;height:11px;}',
'.wb-cbar{position:absolute;left:66px;top:calc(var(--wb-bar,35px) + 18px);display:flex;align-items:center;gap:6px;z-index:6;}',
'.wb-fchip{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;border-radius:var(--wb-radius);background:var(--wb-surface);border:1px solid var(--wb-line);font-size:11.5px;color:var(--wb-text);cursor:pointer;box-shadow:var(--wb-shadow);}',
'.wb-fchip:hover{filter:brightness(1.15);}',
'.wb-fchip svg{width:12px;height:12px;color:var(--wb-muted);}',
'.wb-fchip.is-muted{color:var(--wb-muted);}',
'.wb-host.empty-msg-panel{margin:0 !important;padding:0 !important;}',
].join('\n');
Object.assign(WbBoard.prototype, {
	isCollectionBoard() { return !!this.collectionGuid; },
	async initCollectionBoard() {
		this.collectionGuid = this.plugin.boardCollectionGuid(this.rec); if (!this.collectionGuid) return;
		let cols = await this.plugin.refreshCols(); this.collection = cols.find((c) => c.getGuid && c.getGuid() === this.collectionGuid) || null;
		if (!this.collection) { await wbSleep(1500); if (this.destroyed) return; cols = await this.plugin.refreshCols(); this.collection = cols.find((c) => c.getGuid && c.getGuid() === this.collectionGuid) || null; }
		if (!this.collection) { this.plugin.toast('Could not find the collection this board mirrors. Reopen the board once the workspace has loaded.'); return; }
		this.comp = wbComponentFor(this.collectionGuid); this.collFields = await this.collectionFields();
		this.buildCollectionBar();
		await this.syncCollection();
		const bump = () => { if (this._syncT) clearTimeout(this._syncT); this._syncT = setTimeout(() => { this._syncT = null; this.syncCollection(); }, 600); };
		try { this._collEv = [this.plugin.events.on('record.created', bump), this.plugin.events.on('record.moved', bump), this.plugin.events.on('record.updated', (ev) => { const g = ev && (ev.recordGuid || (ev.record && ev.record.guid)); if (g && this.scene.nodes.some((n) => n.type === 'card' && n.recordGuid === g)) bump(); })]; } catch (e) {}
		this.disposers.push(() => { for (const id of this._collEv || []) { try { this.plugin.events.off(id); } catch (e) {} } });
	},
	// Fields a board can group / filter on. A dynamic collection has none of its own: take the union (by type + label) of
	// its source collections' fields; values are read by label, so one field works across the sources.
	// Fields a board can group / filter on: the union (by type + label) of the fields of the collections that the page
	// cards ON the board belong to. Boards never pull pages in, so the mirrored collection's own fields say nothing about
	// what is here; pages may come from any collection. Values are read by label, so one field spans the collections.
	async collectionFields() {
		const pick = (comp) => wbFieldsOf(comp).filter((f) => f.type === 'choice' || (f.type === 'record' && !f.many));
		const cards = this.scene.nodes.filter((n) => n.type === 'card' && n.recordGuid); if (!cards.length) return [];
		const seenCol = new Set(), seen = new Set(), out = [];
		for (const n of cards) {
			let rec = null; try { rec = await this.plugin.record(n.recordGuid); } catch (e) {}
			const row = wbRow(rec); const cg = row && row.pguid; if (!cg || seenCol.has(cg)) continue; seenCol.add(cg);
			const comp = wbComponentFor(cg); if (!comp) continue;
			for (const f of pick(comp)) { const k = f.type + ':' + String(f.label || '').toLowerCase(); if (seen.has(k)) continue; seen.add(k); out.push(f); }
		}
		return out;
	},
	// a chip click while its menu is open closes it
	chipMenu(b, open) { if (this._menuAnchor === b && document.querySelector('.qb-menu')) { this.plugin.closeMenus(); this._menuAnchor = null; return; } this._menuAnchor = b; open(); },
	// [Group by v] [Filter v] [<icon> Collection v] in Thymer's panel bar, left of [Boards v]. Group/Filter only when there is a field.
	buildCollectionBar() {
		for (const el of this.collChromeEls || []) el.remove(); this.collChromeEls = [];
		if (this.cbar) { this.cbar.remove(); this.cbar = null; }
		const icons = this.ensureTopbar().querySelector('.wb-tbcoll'); if (!icons) return;
		const st = this.scene.settings = this.scene.settings || {}; st.coll = st.coll || { groupBy: null, filter: null };
		const fields = this.collFields || [];
		const chev = WB_I.chev.replace('style="width:11px;height:11px"', 'class="wb-chev"');
		const mk = (html, title, fn) => { const b = wbEl('span', 'wb-nb', html); b.title = title; b.addEventListener('pointerdown', (e) => e.stopPropagation()); b.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); fn(b); }); return b; };
		const els = [];
		if (fields.length) {
			const gField = fields.find((f) => f.id === st.coll.groupBy);
			const grp = mk(WB_SVG('<rect x="4" y="4" width="6" height="6"></rect><rect x="14" y="4" width="6" height="6"></rect><rect x="4" y="14" width="6" height="6"></rect><rect x="14" y="14" width="6" height="6"></rect>') + '<span>' + (gField ? 'Group: ' + wbEsc(gField.label) : 'Group by') + '</span>' + chev, 'Lay the pages out in sections by a field', (b) => this.chipMenu(b, () => wbMenu(b, [{ v: '', label: 'No grouping', icon: 'ti-layout-grid' }].concat(fields.map((f) => ({ v: f.id, label: f.label, icon: f.icon || 'ti-list' }))), st.coll.groupBy || '', (v) => { st.coll.groupBy = v || null; this.scene.sections = null; this.buildCollectionBar(); this.syncCollection(true); this.scheduleSave(); }, { width: 220, dots: false })));
			if (!gField) grp.classList.add('is-muted');
			els.push(grp);
		}
		const tags = this.tags ? this.tags() : [];
		if (fields.length || tags.length) {
			const fl = st.coll.filter; const fField = fl && fl.kind !== 'tag' && fields.find((f) => f.id === fl.fieldId); const fTag = fl && fl.kind === 'tag' ? tags.find((t) => t.id === fl.tagId) : null;
			const label = fField ? wbEsc(fField.label) + ': ' + wbEsc(fl.label || '') : fTag ? 'Tag: ' + wbEsc(fTag.name) : 'Filter';
			const after = () => { this.buildCollectionBar(); if (this.isCollectionBoard()) this.syncCollection(true); else this.renderAll(); this.scheduleSave(); };
			const propMenu = (b) => wbMenu(b, fields.map((f) => ({ v: f.id, label: f.label, icon: f.icon || 'ti-list' })), fField ? fl.fieldId : null, async (v) => { const f = fields.find((x) => x.id === v); const vals = await this.groupValues(f); setTimeout(() => wbMenu(b, vals.map((x) => ({ v: x.key, label: x.label, icon: x.icon || 'ti-tag' })), fField && fl.fieldId === v ? fl.key : null, (k) => { const val = vals.find((x) => x.key === k); st.coll.filter = { fieldId: v, key: k, label: val ? val.label : '' }; after(); }, { width: 240, dots: false }), 30); }, { width: 220, dots: false, search: fields.length > 8, searchPlaceholder: 'Find a property' });
			const tagMenu = (b) => wbMenu(b, tags.map((t) => ({ v: t.id, label: t.name, color: t.color })), fTag ? fTag.id : null, (v) => { const t = tags.find((x) => x.id === v); st.coll.filter = { kind: 'tag', tagId: v, label: t ? t.name : '' }; after(); }, { width: 220, search: tags.length > 8, searchPlaceholder: 'Find a tag' });
			const flt = mk(WB_SVG('<path d="M4 4h16l-6 8v6l-4 2v-8z"></path>') + '<span>' + label + '</span>' + chev, 'Show only what matches a property value or a tag', (b) => this.chipMenu(b, () => {
				const top = []; if (fl) top.push({ v: '__none', label: 'No filter', icon: 'ti-filter' }, { sep: true }); if (fields.length) top.push({ v: 'props', label: 'Properties', icon: 'ti-list' }); if (tags.length) top.push({ v: 'tags', label: 'Tags', icon: 'ti-tag' });
				if (top.length === 1 && !fl) { (top[0].v === 'tags' ? tagMenu : propMenu)(b); return; }
				wbMenu(b, top, null, (v) => { if (v === '__none') { st.coll.filter = null; after(); return; } setTimeout(() => (v === 'tags' ? tagMenu : propMenu)(b), 30); }, { width: 200, dots: false });
			}));
			if (!fField && !fTag) flt.classList.add('is-muted');
			els.push(flt);
		}
		let cicon = 'ti-folder'; try { cicon = collIconFromConf(this.collection.getConfiguration()) || cicon; } catch (e) {}
		const info = mk('<span class="ti ' + wbEsc(cicon) + '"></span><span>' + wbEsc(this.collection ? this.collection.getName() : 'Collection') + '</span>' + chev, this.collection ? 'The collection this board mirrors. Click to change it or stop mirroring' : 'Mirror a collection on this board', (b) => this.chipMenu(b, async () => {
			const cols = ((await this.plugin.refreshCols()) || []).filter((c) => { try { return c.getName() !== WB_BOARDS && !this.plugin.isExcludedCollection(c) && !(c.isJournalPlugin && c.isJournalPlugin()); } catch (e) { return false; } }).sort((a, c2) => (a.getName() || '').localeCompare(c2.getName() || ''));
			let items = cols.map((c) => { let ic = 'ti-folder'; try { ic = collIconFromConf(c.getConfiguration()) || ic; } catch (e) {} return { v: c.getGuid(), label: c.getName(), icon: ic }; });
			const cur = items.find((it) => it.v === this.collectionGuid); if (cur) items = [cur, { sep: true }].concat(items.filter((it) => it !== cur)); // the mirrored one first: pick it again to stop mirroring
			wbMenu(b, items, this.collectionGuid, (v) => this.changeCollection(v === this.collectionGuid ? '__none' : v), { width: 280, dots: false, search: true, startTop: true, searchPlaceholder: 'Search collections', isChecked: (v) => !!this.collectionGuid && v === this.collectionGuid });
		}));
		if (!this.collection) info.classList.add('is-muted');
		els.push(info);
		for (const el of els) icons.appendChild(el);
		if (this.pageBtn) icons.appendChild(this.pageBtn); // [Collection] [Page] side by side
		this.collChromeEls = els; this.topbarSep();
	},
	async changeCollection(guid) {
		if (guid === '__none') {
			try { this.rec.prop(this.plugin.collFieldLabel()).set(''); } catch (e) {}
			const was = this.collection ? this.collection.getName() : 'the collection'; this.collectionGuid = null; this.collection = null; this.comp = null; this.collFields = []; this.scene.sections = null; this._propHidden = new Set();
			const st0 = this.scene.settings.coll || (this.scene.settings.coll = {}); st0.groupBy = null; st0.filter = null;
			this.buildCollectionBar(); this.renderAll(); this.scheduleSave(); return;
		}
		if (!guid || guid === this.collectionGuid) return;
		const cols = (await this.plugin.refreshCols()) || []; const col = cols.find((c) => c.getGuid && c.getGuid() === guid); if (!col) return;
		try { this.rec.prop(this.plugin.collFieldLabel()).set(guid); } catch (e) { this.plugin.toast('Could not change the collection.'); return; }
		if (!this.scene.settings.coll) this.scene.settings.coll = { groupBy: null, filter: null };
		const wasPlain = !this.collectionGuid;
		this.collectionGuid = guid; this.collection = col; this.comp = wbComponentFor(guid); this.collFields = await this.collectionFields();
		if (wasPlain) { this.scene.settings.coll = this.scene.settings.coll || { groupBy: null, filter: null }; }
		const st = this.scene.settings.coll || (this.scene.settings.coll = {}); st.groupBy = null; st.filter = null; this.scene.sections = null;
		this.buildCollectionBar(); await this.syncCollection(true); this.scheduleSave();
		this.plugin.toast('This board now mirrors ' + col.getName() + '.');
	},
	async groupValues(field) {
		if (!field) return [];
		if (field.type === 'choice') return (field.choices || []).filter((c) => c.active !== false).map((c) => ({ key: c.id, label: c.label, color: c.color }));
		const cols = await this.plugin.refreshCols(); const target = field.filter_colguid ? cols.find((c) => c.getGuid && c.getGuid() === field.filter_colguid) : null;
		let recs = []; try { recs = target ? await target.getAllRecords() : []; } catch (e) {}
		return recs.map((r) => ({ key: r.guid, label: r.getName() || 'Untitled', icon: (r.getIcon && r.getIcon(true)) || 'ti-file-text' }));
	},
	valueKey(rec, field) {
		try { if (field.type === 'choice') { const ids = rec.prop(field.label).selectedChoices ? rec.prop(field.label).selectedChoices() : []; return ids[0] || ''; } const r = rec.linkedRecord(field.label); return r ? r.guid : ''; } catch (e) { return ''; }
	},
	async syncCollection(relayout) {
		if (this.destroyed || !this.collection) return;
		let recs = []; try { if (this.plugin.isDynamicCollection(this.collection)) { const vs = (this.collection.getConfiguration().views || []); const v = vs.find((x) => x.type !== 'custom') || vs[0]; recs = v ? await this.collection.getAllRecords(v.id || v.label) : []; } else recs = await this.collection.getAllRecords(); } catch (e) {}
		recs = (recs || []).filter((r) => !(r.isTrashed && r.isTrashed()));
		const st = this.scene.settings.coll || {}; const fields = this.collFields || (this.comp ? wbFieldsOf(this.comp) : []);
		const fField = st.filter && st.filter.kind !== 'tag' && fields.find((f) => f.id === st.filter.fieldId); if (fField) recs = recs.filter((r) => this.valueKey(r, fField) === st.filter.key);
		// the pages that ARE on the board, whatever collection they come from
		const cardNodes = this.scene.nodes.filter((n) => n.type === 'card' && n.recordGuid); const cardRecs = [];
		for (const n of cardNodes) { let r = null; try { r = await this.plugin.record(n.recordGuid); } catch (e) {} if (r) cardRecs.push(r); }
		const nf = await this.collectionFields(); const sig = nf.map((f) => f.id).join(); if (sig !== (this.collFields || []).map((f) => f.id).join()) { this.collFields = nf; this.buildCollectionBar(); }
		const before = new Set(this._propHidden || []); this._propHidden = new Set();
		if (fField) { const byGuid = new Map(cardRecs.map((r) => [r.guid, r])); for (const n of cardNodes) { const r = byGuid.get(n.recordGuid); if (!r || this.valueKey(r, fField) !== st.filter.key) this._propHidden.add(n.id); } }
		let filterChanged = before.size !== this._propHidden.size || [...before].some((id) => !this._propHidden.has(id));
		// His ruling 2026-09-05: a board never takes pages in on its own. Records are only used to keep the cards that ARE here in sync.
		if (!st.noAuto) { st.noAuto = true; const before = this.scene.nodes.length; this.scene.nodes = this.scene.nodes.filter((n) => !(n.type === 'card' && n.auto && !n.userPlaced)); const gone = new Set(); for (const n of []) gone.add(n); this.scene.edges = this.scene.edges.filter((e) => this.nodeById(e.from) && this.nodeById(e.to)); if (before !== this.scene.nodes.length) { this.scheduleSave(); } }
		for (const r of recs) { this.plugin._recs = this.plugin._recs || new Map(); this.plugin._recs.set(r.guid, r); }
		const want = new Set(recs.map((r) => r.guid)); const have = new Map(this.scene.nodes.filter((n) => n.type === 'card').map((n) => [n.recordGuid, n]));
		let changed = false;
		for (const [g, n] of have) if (n.auto && !want.has(g)) { this.scene.nodes = this.scene.nodes.filter((x) => x !== n); this.scene.edges = this.scene.edges.filter((e) => e.from !== n.id && e.to !== n.id); changed = true; }
		const fresh = [];
		const gField = st.groupBy && fields.find((f) => f.id === st.groupBy);
		if (gField) await this.layoutSections(gField, cardRecs, relayout);
		if (changed || relayout || filterChanged) { this.renderAll(); this.scheduleSave(); } else this.renderSections();
	},
	placeInbox(fresh) {
		const others = this.scene.nodes.filter((n) => !fresh.includes(n)); const bb = wbBBox(others); let x = bb ? bb.x : 0, y = bb ? bb.y - 140 - 24 : 0; const cols = 4; fresh.forEach((n, i) => { n.x = x + (i % cols) * 244; n.y = y - Math.floor(i / cols) * 120; });
	},
	async layoutSections(field, recs, relayout) {
		const values = await this.groupValues(field); values.push({ key: '', label: 'No ' + field.label, color: 'gray' });
		const byRec = new Map(recs.map((r) => [r.guid, this.valueKey(r, field)]));
		const cards = this.scene.nodes.filter((n) => n.type === 'card' && byRec.has(n.recordGuid));
		const colW = 3 * 244 + 16, gap = 40; const secs = []; let x = 0;
		for (const v of values) {
			const mine = cards.filter((n) => byRec.get(n.recordGuid) === v.key); if (!mine.length && v.key === '') continue;
			const prev = (this.scene.sections || []).find((s) => s.key === v.key);
			const sec = { key: v.key, label: v.label, color: v.color || null, x: prev && !relayout ? prev.x : x, y: prev && !relayout ? prev.y : 0, w: colW, h: 0 };
			// cards keep their place if they already sit inside the section; the rest fill the next free slots
			const inside = (n) => n.x >= sec.x && n.x + n.w <= sec.x + sec.w && n.y >= sec.y;
			const placed = mine.filter((n) => !relayout && inside(n)); const loose = mine.filter((n) => !placed.includes(n));
			let slot = placed.length; for (const n of loose) { n.x = sec.x + 16 + (slot % 3) * 244; n.y = sec.y + 40 + Math.floor(slot / 3) * 150; slot++; }
			const bottom = Math.max(sec.y + 120, ...mine.map((n) => n.y + n.h + 24)); sec.h = bottom - sec.y;
			secs.push(sec); x = Math.max(x, sec.x + colW + gap);
		}
		this.scene.sections = secs;
	},
	renderSections() {
		for (const el of this.nodes.querySelectorAll('.wb-section')) el.remove();
		if (!this.isCollectionBoard() || !(this.scene.sections || []).length) return;
		for (const s of this.scene.sections) { const el = wbEl('div', 'wb-section'); el.style.left = s.x + 'px'; el.style.top = s.y + 'px'; el.style.width = s.w + 'px'; el.style.height = s.h + 'px'; el.appendChild(wbEl('div', 'wb-secname', wbEsc(s.label) + ' · ' + this.scene.nodes.filter((n) => n.type === 'card' && n._sec === s.key).length)); const add = wbEl('div', 'wb-secadd', WB_I.plus + '<span>New page</span>'); add.title = 'New page in ' + s.label; add.addEventListener('pointerdown', (ev) => ev.stopPropagation()); add.addEventListener('click', (ev) => { ev.stopPropagation(); this.createInSection(s.x + 16, s.y + 40); }); el.appendChild(add); this.nodes.insertBefore(el, this.nodes.firstChild); }
	},
	sectionAt(wx, wy) { return (this.scene.sections || []).find((s) => wx >= s.x && wx <= s.x + s.w && wy >= s.y && wy <= s.y + s.h) || null; },
	async dropIntoSection(n) {
		if (!this.isCollectionBoard() || n.type !== 'card') return; const st = this.scene.settings.coll || {}; const field = st.groupBy && this.comp && wbFieldsOf(this.comp).find((f) => f.id === st.groupBy); if (!field) return;
		const sec = this.sectionAt(n.x + n.w / 2, n.y + 20); if (!sec) return;
		const rec = await this.plugin.record(n.recordGuid); if (!rec) return; if (this.valueKey(rec, field) === sec.key) return;
		try { const prop = rec.prop(field.label); if (field.type === 'choice') { if (sec.key) prop.setChoice ? prop.setChoice(sec.key) : prop.set(sec.key); else prop.set(null); } else prop.set(sec.key ? [sec.key] : []); this.plugin.toast(field.label + ': ' + sec.label); } catch (e) { console.warn('[Whiteboard] dropIntoSection', e); }
		await wbSleep(200); await this.plugin.refetch(n.recordGuid); n._rev = (n._rev || 0) + 1; this.syncCollection();
	},
	// A dynamic collection owns no records: its pages live in its source collections. One source = no question; several = a picker.
	async pickSourceCollection() {
		const all = await this.plugin.refreshCols(); let guids = [];
		try { const vs = this.collection.getConfiguration().views || []; for (const v of vs) for (const g of (v.source_collections || [])) if (!guids.includes(g)) guids.push(g); } catch (e) {}
		let cols = guids.includes('*') || !guids.length ? all : all.filter((c) => guids.includes(c.getGuid()));
		cols = cols.filter((c) => !this.plugin.isDynamicCollection(c) && !this.plugin.isExcludedCollection(c) && c.getName() !== WB_BOARDS && c.createRecord);
		if (!cols.length) { this.plugin.toast('No collection can take a new page here.'); return null; }
		const last = (this.scene.settings.coll || {}).lastNewColl; if (cols.length === 1) return cols[0];
		const pref = last && cols.find((c) => c.getGuid() === last); if (pref) cols = [pref].concat(cols.filter((c) => c !== pref));
		const anchor = this.host.querySelector('.wb-secadd') || this.host;
		return new Promise((res) => { let done = false; wbMenu(anchor, cols.map((c) => { let icon = 'ti-folder'; try { icon = c.getConfiguration().icon || icon; } catch (e) {} return { v: c.getGuid(), label: c.getName(), icon }; }), pref ? pref.getGuid() : null, (v) => { done = true; const c = cols.find((x) => x.getGuid() === v) || null; if (c) { this.scene.settings.coll = this.scene.settings.coll || {}; this.scene.settings.coll.lastNewColl = c.getGuid(); this.scheduleSave(); } res(c); }, { width: 260, search: cols.length > 8, searchPlaceholder: 'Create the page in' }); setTimeout(() => { const chk = setInterval(() => { if (done) { clearInterval(chk); return; } if (!wbM.el) { clearInterval(chk); res(null); } }, 200); }, 300); });
	},
	async createInSection(wx, wy) {
		if (!this.isCollectionBoard() || !this.collection) return false;
		const sec = this.sectionAt(wx, wy); const st = this.scene.settings.coll || {}; const field = st.groupBy && this.comp && wbFieldsOf(this.comp).find((f) => f.id === st.groupBy);
		let target = this.collection;
		if (this.plugin.isDynamicCollection(this.collection)) { target = await this.pickSourceCollection(); if (!target) return false; }
		let guid = null; try { guid = target.createRecord('Untitled'); } catch (e) {}
		if (typeof guid !== 'string') { this.plugin.toast('Could not create a page in ' + (target.getName ? target.getName() : 'that collection') + '.'); return false; }
		const rec = await wbRecordPoll(this.plugin, guid, 30);
		if (rec && sec && field && sec.key) { try { const prop = rec.prop(field.label); if (field.type === 'choice') prop.setChoice ? prop.setChoice(sec.key) : prop.set(sec.key); else prop.set([sec.key]); } catch (e) {} }
		this.pushHistory(); const n = wbNode('card', Math.round(wx), Math.round(wy), 220, 80, { recordGuid: guid, auto: true, userPlaced: true }); this.scene.nodes.push(n); this.selected = new Set([n.id]); await this.syncCollection(); this.selected = new Set([n.id]); this.renderAll(); this.scheduleSave();
		this.plugin.toast('New page created. Open it to give it a title.');
		return true;
	},
});
{
	const baseRenderAll = WbBoard.prototype.renderAll;
	WbBoard.prototype.renderAll = function () { baseRenderAll.call(this); if (this.isCollectionBoard && this.isCollectionBoard()) { for (const n of this.scene.nodes) if (n.type === 'card') { const s = this.sectionAt(n.x + n.w / 2, n.y + 20); n._sec = s ? s.key : null; } this.renderSections(); } };
	const baseOnUp = WbBoard.prototype.onUp;
	WbBoard.prototype.onUp = function (e, cancelled) { const d = this.drag; const moved = d && d.kind === 'move' && d.moved; const items = moved ? d.items.slice() : null; baseOnUp.call(this, e, cancelled); if (items && this.isCollectionBoard && this.isCollectionBoard()) for (const n of items) this.dropIntoSection(n); };
	const baseOnDbl = WbBoard.prototype.onDbl;
	WbBoard.prototype.onDbl = function (e) { return baseOnDbl.call(this, e); };
}

// ===========================================================================
// Phase 3a: Mind map mode. Any node can become a root; children hang on edges marked mm.
// Tab = child, Enter = sibling, arrows navigate, drag re-parents, collapse with a count.
// ===========================================================================
const WB_MM_SHAPES = [{ v: 'pill', label: 'Pill' }, { v: 'rounded', label: 'Rounded box' }, { v: 'square', label: 'Square box' }];
const WB_MM_SHAPE_I = { pill: WB_SVG('<rect x="3" y="8" width="18" height="8" rx="4"></rect>'), rounded: WB_SVG('<rect x="4" y="6" width="16" height="12" rx="3"></rect>'), square: WB_SVG('<rect x="4" y="6" width="16" height="12"></rect>') };
const WB_MM_COLORS = ['#65c8bb', '#F5B36B', '#C9A8F0', '#F08A80', '#9DB9F2', '#A6E3A1', '#F0A0C8', '#8FDCE6', '#D4EB8E'];
const WB_MM_CSS = [
'.wb-mind{display:flex;align-items:center;justify-content:center;text-align:center;padding:0 14px;border-radius:17px;background:var(--wb-card);border:1px solid color-mix(in srgb,var(--wb-text) 18%,transparent);color:var(--wb-text);font-size:14px;white-space:nowrap;}',
'.wb-mind .wb-txt{height:auto;white-space:nowrap;overflow:visible;line-height:1.3;}',
'.wb-mind.wb-mm-wrap{white-space:pre-wrap;}',
'.wb-mind.wb-mm-wrap .wb-txt{white-space:pre-wrap;overflow-wrap:anywhere;width:100%;}',
'.wb-mind.wb-mm-cut{opacity:.45;outline:1px dashed var(--wb-accent);outline-offset:2px;}',
'.wb-mind.wb-mm-root{font-size:16px;font-weight:600;color:#0a0a0b;background:var(--wb-accent);border-color:var(--wb-accent);border-radius:22px;padding:0 20px;}',
'.wb-mind.wb-mm-root .wb-txt{color:#0a0a0b;}',
'.wb-mmbadge{position:absolute;height:18px;min-width:18px;padding:0 5px;border-radius:9px;background:var(--wb-surface);border:1px solid var(--wb-line);color:var(--wb-muted);font-size:11px;display:flex;align-items:center;justify-content:center;pointer-events:auto;cursor:pointer;}',
'.wb-mmplus{position:absolute;width:18px;height:18px;border-radius:9px;background:var(--wb-surface);border:1px solid var(--wb-accent);color:var(--wb-accent);display:flex;align-items:center;justify-content:center;pointer-events:auto;cursor:pointer;}',
'.wb-mmplus-sib{border-color:var(--wb-muted);color:var(--wb-muted);opacity:.75;}.wb-mmplus-sib:hover{border-color:var(--wb-accent);color:var(--wb-accent);opacity:1;}',
'.wb-mmplus svg{width:10px;height:10px;}',
'.wb-edges g.wb-mm path.wb-line{stroke-width:1.5px;}',
].join('\n');
Object.assign(WbBoard.prototype, {
	mmChildren(id) { return this.scene.edges.filter((e) => e.mm && e.from === id).map((e) => this.nodeById(e.to)).filter(Boolean); },
	// A bubble's shape cascades the way its colour does: an own shape wins, otherwise the nearest ancestor that set one governs,
	// and the map's own shape is the default underneath. So giving the map (or any bubble) a shape gives it to everything below.
	mmShapeOf(id) { const n = this.nodeById(id); if (!n) return 'pill'; if (n.mmShape) return n.mmShape; for (let a = this.mmParent(id), g = 0; a && g < 200; a = this.mmParent(a.id), g++) if (a.mmShape) return a.mmShape; const r = this.mmRootOf(id); return (r && r.mm && r.mm.shape) || 'pill'; },
	mmParentEdge(id) { return this.scene.edges.find((e) => e.mm && e.to === id) || null; },
	mmParent(id) { const e = this.mmParentEdge(id); return e ? this.nodeById(e.from) : null; },
	mmRootOf(id) { let n = this.nodeById(id), guard = 0; while (n && guard++ < 500) { let p = null; try { p = this.mmParent(n.id); } catch (e) {} if (!p || p === n) return n; n = p; } return n; },
	mmIsTree(id) { const n = this.nodeById(id); return !!(n && (n.mm || this.mmParentEdge(id))); },
	mmDescendants(id, out) { out = out || []; for (const c of this.mmChildren(id)) { out.push(c.id); this.mmDescendants(c.id, out); } return out; },
	mmHidden() { const hidden = new Set(); for (const n of this.scene.nodes) if (n.collapsed) for (const d of this.mmDescendants(n.id)) hidden.add(d); return hidden; },
	// --- layout ------------------------------------------------------------------------
	mmScale(id) { const r = this.mmRootOf(id); return (r && r.mm && r.mm.scale) || 1; },
	mmSideOf(id) { const e = this.mmParentEdge(id); if (!e) return 1; return e.side || 1; },
	mmIsFree(n) { const r = n && this.mmRootOf(n.id); return !!(r && r.mm && r.mm.dir === 'free'); },
	// free layout: a new child lands beside its parent and is nudged down until it sits clear of everything
	// Which way this branch travels, as a unit step. Read from the parent's own children first (they show where the branch
	// has been growing), else from the step that reached the parent. Free maps have no layout, so without this every child
	// landed to the RIGHT even on a branch running left (his report 2026-09-19).
	mmGrowDir(parent, skipId) {
		const mid = (n) => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 });
		const p = mid(parent); let dx = 0, dy = 0;
		for (const k of this.mmChildren(parent.id)) { if (skipId && k.id === skipId) continue; const m = mid(k); dx += m.x - p.x; dy += m.y - p.y; }
		if (!dx && !dy) { const up = this.mmParent(parent.id); if (up) { const m = mid(up); dx = p.x - m.x; dy = p.y - m.y; } }
		if (!dx && !dy) return { x: 1, y: 0 };
		return Math.abs(dx) >= Math.abs(dy) ? { x: dx < 0 ? -1 : 1, y: 0 } : { x: 0, y: dy < 0 ? -1 : 1 };
	},
	mmFreeSpot(parent, child) {
		const GAP = 18; const g = this.mmGrowDir(parent, child.id);
		child.x = Math.round(g.x < 0 ? parent.x - 70 - child.w : g.x > 0 ? parent.x + parent.w + 70 : parent.x + parent.w / 2 - child.w / 2);
		child.y = Math.round(g.y < 0 ? parent.y - 70 - child.h : g.y > 0 ? parent.y + parent.h + 70 : parent.y + parent.h / 2 - child.h / 2);
		const step = g.x ? { x: 0, y: child.h + GAP } : { x: child.w + GAP, y: 0 }; // nudge ACROSS the branch, never along it
		const hits = () => this.scene.nodes.some((n) => n !== child && n.type !== 'frame' && !(child.x + child.w + GAP <= n.x || n.x + n.w + GAP <= child.x || child.y + child.h + GAP <= n.y || n.y + n.h + GAP <= child.y));
		let guard = 0; while (hits() && guard++ < 60) { child.x = Math.round(child.x + step.x); child.y = Math.round(child.y + step.y); }
	},
	// free layout: dragging a node takes its branch along (leaves have no children, so they move alone)
	// Dragging a bubble takes its branch along, in EVERY layout (it used to be free maps only, so anywhere else you had to
	// marquee the whole branch first — his report 2026-09-19). In a laid-out map the carry is what you see during the drag;
	// the drop then decides the order (mmDropReorder) or the new parent, and the layout places everything again.
	mmExpandBranch(moving) {
		if (!moving.some((n) => this.mmIsTree(n.id))) return moving;
		const out = moving.slice(), seen = new Set(out.map((n) => n.id));
		for (const n of moving) { if (!this.mmIsTree(n.id)) continue; for (const id of this.mmDescendants(n.id)) { const d = this.nodeById(id); if (d && !seen.has(id) && !d.locked) { seen.add(id); out.push(d); } } }
		return out;
	},
	mmLayout(rootId) {
		const root = this.nodeById(rootId); if (!root) return; root.mm = root.mm || { dir: 'horizontal', sides: 'both' };
		const dir = root.mm.dir || 'horizontal'; const hidden = this.mmHidden(); const sc = root.mm.scale || 1;
		const GAP = 18 * sc, LEVEL = 70 * sc;
		const size = (n) => { if (n.collapsed || hidden.has(n.id)) return dir === 'horizontal' ? n.h : n.w; const kids = this.mmChildren(n.id); if (!kids.length) return dir === 'horizontal' ? n.h : n.w; let t = 0; for (const k of kids) t += size(k) + GAP; return Math.max(dir === 'horizontal' ? n.h : n.w, t - GAP); };
		const placeGroup = (n, kids, side) => {
			if (!kids.length) return;
			if (dir === 'horizontal') { const total = kids.reduce((t, k) => t + size(k) + GAP, 0) - GAP; let y = n.y + n.h / 2 - total / 2; for (const k of kids) { const sz = size(k); k.x = Math.round(side < 0 ? n.x - LEVEL - k.w : n.x + n.w + LEVEL); k.y = Math.round(y + sz / 2 - k.h / 2); y += sz + GAP; const e = this.mmParentEdge(k.id); if (e) e.side = side; placeGroup(k, k.collapsed ? [] : this.mmChildren(k.id), side); } }
			else { const total = kids.reduce((t, k) => t + size(k) + GAP, 0) - GAP; let x = n.x + n.w / 2 - total / 2; for (const k of kids) { const sz = size(k); k.y = Math.round(n.y + n.h + LEVEL); k.x = Math.round(x + sz / 2 - k.w / 2); x += sz + GAP; placeGroup(k, k.collapsed ? [] : this.mmChildren(k.id), 1); } }
		};
		// 'topdown' (SimpleMind's shape): the first level is a row under the root, every deeper level is a vertical list indented under its parent.
		// colW is the width a whole column needs: the node itself, or the indent plus the widest column below it.
		const INDENT = 30 * sc, VGAP = 14 * sc, COLGAP = 40 * sc;
		const colW = (n) => { const ks = n.collapsed || hidden.has(n.id) ? [] : this.mmChildren(n.id); let w = n.w; for (const k of ks) w = Math.max(w, INDENT + colW(k)); return w; };
		const listPlace = (n, x, y) => { n.x = Math.round(x); n.y = Math.round(y); let cy = y + n.h + VGAP; if (n.collapsed) return cy; for (const k of this.mmChildren(n.id)) cy = listPlace(k, x + INDENT, cy); return cy; };
		const placeTopDown = (ks) => {
			if (!ks.length) return; const widths = ks.map(colW); const total = widths.reduce((a, b) => a + b, 0) + COLGAP * (ks.length - 1);
			let x = root.x + root.w / 2 - total / 2; const y = root.y + root.h + LEVEL;
			ks.forEach((k, i) => { k.x = Math.round(x); k.y = Math.round(y); let cy = y + k.h + VGAP; if (!k.collapsed) for (const c of this.mmChildren(k.id)) cy = listPlace(c, x + INDENT, cy); x += widths[i] + COLGAP; });
		};
		// 'free': no automatic placement at all, every node keeps where the user dropped it (the branch colouring below still runs)
		const kids = root.collapsed || dir === 'free' ? [] : this.mmChildren(root.id);
		if (dir === 'topdown') placeTopDown(kids);
		else if (dir === 'horizontal' && root.mm.sides === 'both') {
			// each child keeps the side it was created on; unassigned ones go to the emptier side
			let l = 0, r = 0; for (const k of kids) { const e = this.mmParentEdge(k.id); if (!e.side) e.side = (r <= l) ? 1 : -1; if (e.side < 0) l++; else r++; }
			placeGroup(root, kids.filter((k) => this.mmParentEdge(k.id).side < 0), -1); placeGroup(root, kids.filter((k) => this.mmParentEdge(k.id).side > 0), 1);
		} else placeGroup(root, kids, 1);
		this.mmApplyOffsets(root.id);
		this.mmRecolor(root.id);
	},
	// The axis the layout spreads siblings along: sideways maps stack them vertically, org charts and a top-down map's
	// first row spread them horizontally. A branch can only be nudged along THIS axis, never along the one the map grows in.
	mmCrossAxis(root, parent) {
		const dir = (root.mm && root.mm.dir) || 'horizontal';
		if (dir === 'vertical') return 'x';
		if (dir === 'topdown') return parent && parent.id === root.id ? 'x' : 'y';
		return 'y';
	},
	// His ruling 2026-09-19: dragging a branch across the layout should make ROOM, not snap back. Each bubble may carry an
	// offset from its computed slot (`mmOff = {a: axis, v: unscaled px}`), applied to the whole branch after the layout has
	// placed everything. Tagged with its axis so an offset made in one layout never misapplies in another.
	mmApplyOffsets(rootId) {
		const root = this.nodeById(rootId); if (!root || ((root.mm && root.mm.dir) || 'horizontal') === 'free') return;
		const sc = (root.mm && root.mm.scale) || 1;
		const walk = (n) => {
			for (const k of this.mmChildren(n.id)) {
				const off = k.mmOff;
				if (off && off.v && off.a === this.mmCrossAxis(root, n)) {
					const d = off.v * sc;
					for (const id of [k.id].concat(this.mmDescendants(k.id))) { const q = this.nodeById(id); if (q) q[off.a] = Math.round(q[off.a] + d); }
				}
				walk(k);
			}
		};
		walk(root);
	},
	// Line colours only. Kept apart from mmLayout so recolouring a branch never moves anything.
	mmRecolor(rootId) {
		const root = this.nodeById(rootId); if (!root || !root.mm) return;
		this.mmChildren(root.id).forEach((k, i) => { const col = WB_MM_COLORS[i % WB_MM_COLORS.length]; for (const id of [k.id].concat(this.mmDescendants(k.id))) { const e = this.mmParentEdge(id); if (e) { e.color = this.mmEdgeColor(id) || col; delete e.colorSet; if (root.mm.line) e.route = root.mm.line; } } });
	},
	mmRecolorAll() { for (const n of this.scene.nodes) if (n.mm && !this.mmParentEdge(n.id)) this.mmRecolor(n.id); },
	mmRelayoutAll() { for (const n of this.scene.nodes) if (n.mm && !this.mmParentEdge(n.id)) this.mmLayout(n.id); },
	// --- node sizing: a mind node hugs its text ---------------------------------------------
	accentHex() {
		try {
			const v = getComputedStyle(this.canvas).getPropertyValue('--wb-accent').trim();
			if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
			const m = /^rgba?\(([^)]+)\)$/i.exec(v); if (m) { const q = m[1].split(',').map((x) => parseFloat(x)); if (q.length >= 3 && q.slice(0, 3).every((x) => !isNaN(x))) return '#' + q.slice(0, 3).map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join(''); }
		} catch (e) {}
		const c = this.canvas.classList; return c.contains('wb-force-light') ? '#3f8484' : c.contains('wb-force-dark') ? '#65c8bb' : wbIsDarkApp() ? '#65c8bb' : '#3f8484'; // the token can be an unresolved light-dark(), so fall back to the two theme values
	},
	// Without mmW a bubble is as wide as its text, which is what makes a long sentence a very long bubble. mmW is a width the
	// user dragged (stored unscaled, so it follows the map's scale): the text then wraps inside it and the bubble grows downwards.
	mmFit(n, el) {
		const txt = el.querySelector('.wb-txt'); if (!txt) return; const sc = this.mmScale(n.id);
		const baseH = Math.round((n.mm ? 44 : 34) * sc); let w, h;
		if (n.mmW) {
			w = Math.max(Math.round(60 * sc), Math.round(n.mmW * sc));
			if (el.style.width !== w + 'px') el.style.width = w + 'px';
			el.style.height = 'auto'; // the text decides the height, so it must be free while we read it
			h = Math.max(baseH, Math.round(txt.scrollHeight) + baseH - Math.round((n.mm ? 16 : 14) * 1.3 * sc));
		} else { w = Math.max(Math.round(60 * sc), this.mmNatW(n, el)); h = baseH; }
		if (w !== n.w || h !== n.h) { n.w = w; n.h = h; }
		el.style.width = w + 'px'; el.style.height = h + 'px';
	},
	// The width the text wants with no wrapping, in world pixels, padding included. The box MUST be freed before measuring:
	// while the element carries a fixed width, scrollWidth reports that width, so a bubble whose long sentence was replaced
	// with a short word kept the long bubble for ever (it could only ever grow). Also what dragging back out compares against.
	mmNatW(n, el) {
		const txt = el && el.querySelector('.wb-txt'); if (!txt) return 0;
		const hadWrap = el.classList.contains('wb-mm-wrap'); if (hadWrap) el.classList.remove('wb-mm-wrap');
		const prev = el.style.width; el.style.width = 'auto';
		const w = Math.round(txt.scrollWidth + (n.mm ? 40 : 28) * this.mmScale(n.id));
		el.style.width = prev; if (hadWrap) el.classList.add('wb-mm-wrap');
		return w;
	},
	// --- editing ops ------------------------------------------------------------------------
	// a fresh mind map where the user clicked: a sticky in the current colour, made a root, its text open for typing (the phone's Add sheet uses the same recipe)
	createMindAt(w) { this.commitEdit(); this.pushHistory(); const snap = !!(this.scene.settings && this.scene.settings.snap); const n = wbNode('mind', wbSnap(w.x - 60, snap), wbSnap(w.y - 20, snap), 120, 40, { text: '' }); this.scene.nodes.push(n); this.setTool('select'); this.mmMakeRoot(n); this.beginEdit(n.id); }, // his ruling 2026-09-22: a real bubble, so its shape (pill, rounded, square) can be changed like any other
	mmMakeRoot(n) { this.pushHistory(); if (!n.mm) n.mm = { dir: 'horizontal', sides: 'both', scale: this.mmScaleFrom([n]) }; if (n.type !== 'mind') { n.mmOrig = n.type; } this.selected = new Set([n.id]); this.renderAll(); this.scheduleSave(); this.plugin.toast('Mind map: Tab adds a child, Enter a sibling.'); },
	mmAdd(parentId, afterId, side, before) {
		const parent = this.nodeById(parentId); if (!parent) return null; this.commitEdit(); this.pushHistory();
		const g0 = this.mmGrowDir(parent); // free maps place the child themselves (mmFreeSpot); this start point just keeps it off the parent
		const child = wbNode('mind', parent.x + (g0.x < 0 ? -160 : parent.w + 70), parent.y, 90, 34, { text: '' });
		this.scene.nodes.push(child);
		const inherit = this.mmParentEdge(parentId); const root0 = this.mmRootOf(parentId); const sib = this.scene.edges.find((e) => e.mm && e.from === parentId);
		const route = (root0 && root0.mm && root0.mm.line) || (sib && sib.route) || (inherit && inherit.route) || 'curved';
		const edge = { id: wbUid(), from: parentId, to: child.id, route, mm: true, endArrow: false, side: side || (inherit && inherit.side) || null };
		if (afterId) { const idx = this.scene.edges.findIndex((e) => e.mm && e.to === afterId); if (idx >= 0) { this.scene.edges.splice(before ? idx : idx + 1, 0, edge); } else this.scene.edges.push(edge); } else this.scene.edges.push(edge);
		if (parent.collapsed) parent.collapsed = false;
		const root = this.mmRootOf(parentId); if (this.mmIsFree(root)) this.mmFreeSpot(parent, child); this.mmLayout(root.id); this.selected = new Set([child.id]); this.selectedEdge = null; this.renderAll(); this.beginEdit(child.id); this.scheduleSave();
		return child;
	},
	mmAddChild(id, side) { return this.mmAdd(id, null, side); },
	mmAddSibling(id, before) { const p = this.mmParent(id); if (!p) return this.mmAdd(id, null); return this.mmAdd(p.id, id, this.mmSideOf(id), before); },
	// Every branch off the root has its own colour, the same one its thread wears (his ruling 2026-09-06, correcting the
	// earlier one: the children of a root do NOT all take the root's colour, each branch has its own).
	mmBranchColor(id) {
		const root = this.mmRootOf(id); if (!root || root.id === id) return null;
		let top = id; for (let g = 0; g < 500; g++) { const par = this.mmParent(top); if (!par || par.id === root.id) break; top = par.id; }
		const i = this.mmChildren(root.id).findIndex((k) => k.id === top);
		return i < 0 ? null : WB_MM_COLORS[i % WB_MM_COLORS.length];
	},
	mmEdgeColor(id) {
		// stop BEFORE the root: the root's own colour is the map's chrome, not a branch colour, so an uncoloured branch
		// under a white root still gets the map's palette instead of near-white lines
		const root = this.mmRootOf(id); let n = this.nodeById(id);
		for (let g = 0; n && n !== root && g < 200; g++, n = this.mmParent(n.id)) { const c = wbNodeColorOf(n); if (c) return wbStickyColor(c).hex; }
		return this.mmBranchColor(id);
	},
	// Lift ONE node out of the tree. Its children keep the map and hang on its parent instead, so nothing is orphaned
	// and nothing else has to move. Returns the root that needs a fresh layout.
	mmExtractOne(n) {
		if (!n || !this.mmIsTree(n.id)) return null;
		const parent = this.mmParent(n.id); if (!parent) return null; // a root is never extracted, the map would lose its head
		const root = this.mmRootOf(n.id);
		for (const e of this.scene.edges) if (e.mm && e.from === n.id) e.from = parent.id;
		this.scene.edges = this.scene.edges.filter((e) => !(e.mm && e.to === n.id));
		delete n.mmShape; delete n.collapsed;
		return root;
	},
	// "Turn into a post-it": the bubble leaves the map and is a note again, in the shape it had before it joined
	// A new post-it looks like the post-its this board already has (median size), or follows the map's scale when there
	// are none. A fixed 200x200 was four times the size of his own notes.
	stickySize(exclude, sc) {
		const med = (arr) => { const a = arr.slice().sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };
		const others = this.scene.nodes.filter((x) => x.type === 'sticky' && x !== exclude);
		if (others.length) return { w: Math.round(med(others.map((o) => o.w))), h: Math.round(med(others.map((o) => o.h))) };
		return { w: Math.round(200 * (sc || 1)), h: Math.round(200 * (sc || 1)) };
	},
	mmToPostit(nodes) {
		const list = (Array.isArray(nodes) ? nodes : [nodes]).filter((n) => n && this.mmIsTree(n.id) && this.mmParent(n.id));
		if (!list.length) return;
		this.pushHistory();
		const roots = new Set();
		for (const n of list) {
			const sc = this.mmScale(n.id); // read it before the node leaves the tree
			const root = this.mmExtractOne(n); if (root) roots.add(root.id);
			const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
			const back = n.mmOrig && n.mmOrig !== 'note' && n.mmOrig !== 'board' ? n.mmOrig : 'sticky';
			delete n.mmOrig; n.type = back;
			if (back === 'sticky') { const s2 = this.stickySize(n, sc); n.w = s2.w; n.h = s2.h; n.color = n.color || this.stickyColor || 'yellow'; n.fontSize = 'auto'; }
			else if (back === 'text') { n.h = Math.max(28, n.h); }
			n.x = Math.round(cx - n.w / 2); n.y = Math.round(cy - n.h / 2);
			const el = this.nodeEls.get(n.id); if (el) { el.remove(); this.nodeEls.delete(n.id); } // it was a .wb-mind element, rebuild it as its own type
		}
		for (const id of roots) { if (this.nodeById(id)) this.mmLayout(id); }
		this.selected = new Set(list.map((n) => n.id)); this.renderAll(); this.scheduleSave();
	},
	mmSetBranchColor(edge, color) {
		const root = this.mmRootOf(edge.to); if (!root) return;
		let top = edge.to; for (let g = 0; g < 500; g++) { const par = this.mmParent(top); if (!par || par.id === root.id) break; top = par.id; } // up to the root's own child: that is the branch
		const node = this.nodeById(top); if (!node) return;
		this.pushHistory();
		// the colour belongs to the branch's own bubble; its children inherit it and every line in the branch follows
		if (node.type === 'text') node.bg = color || null; else if (node.type === 'shape') { node.fill = color || 'none'; node.textColor = color ? wbContrastText(color) : null; } else node.color = color || null;
		for (const d of this.mmDescendants(top)) { const n2 = this.nodeById(d); if (n2 && color) { if (n2.type === 'text') n2.bg = null; else if (n2.type === 'shape') n2.fill = 'none'; else n2.color = null; } } // they inherit instead of holding their own
		this.mmRecolor(root.id); this.renderAll(); this.buildCtx(); this.scheduleSave();
	},
	mmSetLine(root, route) { this.pushHistory(); root.mm = root.mm || {}; root.mm.line = route; const ids = new Set([root.id].concat(this.mmDescendants(root.id))); for (const e of this.scene.edges) if (e.mm && ids.has(e.to)) e.route = route; this.renderEdges(); this.buildCtx(); this.scheduleSave(); },
	mmDelete(id) { const ids = new Set([id].concat(this.mmDescendants(id))); this.pushHistory(); const parent = this.mmParent(id); this.scene.nodes = this.scene.nodes.filter((n) => !ids.has(n.id)); this.scene.edges = this.scene.edges.filter((e) => !ids.has(e.from) && !ids.has(e.to)); this.selected = new Set(parent ? [parent.id] : []); if (parent) { const root = this.mmRootOf(parent.id); this.mmLayout(root.id); } this.renderAll(); this.scheduleSave(); },
	// A laid-out map recomputes every position on drop, so a drag that did not change parent used to snap straight back.
	// Now the drop position decides the ORDER among the siblings, read on the axis the layout actually spreads them along:
	// sideways maps stack their children vertically (drag up/down), org charts and a top-down map's first row spread them
	// horizontally (drag left/right). Returns true when the order really changed.
	mmDropReorder(item, moved) {
		const parent = this.mmParent(item.id); if (!parent) return false;
		const root = this.mmRootOf(item.id); if (this.mmIsFree(root)) return false;
		const dir = (root.mm && root.mm.dir) || 'horizontal';
		const axis = this.mmCrossAxis(root, parent); const crossX = axis === 'x';
		const cross = (n) => crossX ? n.x + n.w / 2 : n.y + n.h / 2;
		const both = dir === 'horizontal' && (root.mm && root.mm.sides) === 'both';
		const mySide = this.mmSideOf(item.id) || 1;
		// In a both-sides map the root's children are split in two columns; a drop only reorders within its own side.
		const others = this.mmChildren(parent.id).filter((k) => k.id !== item.id && (!(both && parent.id === root.id) || (this.mmSideOf(k.id) || 1) === mySide));
		const rest = others.slice().sort((a, b) => cross(a) - cross(b));
		const want = rest.filter((k) => cross(k) < cross(item)).length;
		const myEdge = this.mmParentEdge(item.id); if (!myEdge) return false;
		const order = this.mmChildren(parent.id).filter((k) => !(both && parent.id === root.id) || (this.mmSideOf(k.id) || 1) === mySide);
		const sc = (root.mm && root.mm.scale) || 1;
		const shift = moved ? Math.round((crossX ? moved.dx : moved.dy) / sc) : 0;
		if (!others.length || order.findIndex((k) => k.id === item.id) === want) {
			// Nothing was passed on the way: the drag simply opened (or closed) a gap, and the branch keeps it.
			if (!shift) return false;
			this.pushHistory();
			const had = item.mmOff && item.mmOff.a === axis ? item.mmOff.v : 0;
			const v = had + shift;
			if (v) item.mmOff = { a: axis, v }; else delete item.mmOff;
			this.mmLayout(root.id); this.renderAll(); this.scheduleSave();
			return true;
		}
		this.pushHistory();
		delete item.mmOff; // it changed places with a sibling, so it takes that slot as the layout draws it
		this.scene.edges = this.scene.edges.filter((e) => e !== myEdge);
		const after = rest[want];
		const at = after ? this.scene.edges.findIndex((e) => e.mm && e.to === after.id) : -1;
		if (at >= 0) this.scene.edges.splice(at, 0, myEdge);
		else { const last = rest[rest.length - 1]; const i = last ? this.scene.edges.findIndex((e) => e.mm && e.to === last.id) : -1; this.scene.edges.splice(i >= 0 ? i + 1 : this.scene.edges.length, 0, myEdge); }
		this.mmLayout(root.id); this.renderAll(); this.scheduleSave();
		return true;
	},
	mmReparent(id, newParentId, side) {
		if (id === newParentId || this.mmDescendants(id).includes(newParentId)) return false; const e = this.mmParentEdge(id); if (!e) return false;
		const oldRoot = this.mmRootOf(id);
		this.pushHistory(); e.from = newParentId; const root = this.mmRootOf(newParentId);
		if (oldRoot && oldRoot.id !== root.id) this.mmLayout(oldRoot.id); // it left another map: tidy that one too
		e.side = side || (newParentId === root.id ? e.side : this.mmSideOf(newParentId)); // under a branch: that branch's side; under the root: the given side, else keep
		this.mmSetSideDeep(id, e.side); this.mmLayout(root.id); this.renderAll(); this.scheduleSave(); return true;
	},
	// the order of the mm edges from a parent is the order of its branches; move one step up or down among siblings on the same side
	mmMoveOrder(id, dir) {
		const e = this.mmParentEdge(id); if (!e) return false; const root = this.mmRootOf(id); const sameSide = (x) => root && e.from === root.id ? (x.side || 1) === (e.side || 1) : true;
		const sibs = this.scene.edges.filter((x) => x.mm && x.from === e.from && sameSide(x)); const i = sibs.indexOf(e); const j = i + dir; if (i < 0 || j < 0 || j >= sibs.length) return false;
		const other = sibs[j]; const ai = this.scene.edges.indexOf(e), bi = this.scene.edges.indexOf(other); this.pushHistory(); this.scene.edges[ai] = other; this.scene.edges[bi] = e;
		this.mmLayout(root.id); this.renderAll(); this.scheduleSave(); return true;
	},
	// notes dropped on a mind-map node become its children (bubbles); their text comes along, their type is remembered
	mmAdopt(items, e) {
		const pt = this.localPt(e); const w = this.toWorld(pt.x, pt.y); const ids = new Set(items.map((n) => n.id));
		const target = this.scene.nodes.find((n) => !ids.has(n.id) && this.mmIsTree(n.id) && w.x >= n.x && w.x <= n.x + n.w && w.y >= n.y && w.y <= n.y + n.h); if (!target) return false;
		const root = this.mmRootOf(target.id); const both = (root.mm && root.mm.sides) === 'both'; const side = target.id === root.id ? (both && w.x < root.x + root.w / 2 ? -1 : 1) : this.mmSideOf(target.id);
		this.pushHistory(); this.mmAttach(items, target, root, side);
		this.mmLayout(root.id); this.selected = new Set(items.map((n) => n.id)); this.renderAll(); this.scheduleSave(); return true;
	},
	mmAttach(items, target, root, side) {
		for (const n of items) { const el = this.nodeEls.get(n.id); if (el) { el.remove(); this.nodeEls.delete(n.id); } if (n.type !== 'mind') { n.mmOrig = n.type; n.type = 'mind'; n.w = 90; n.h = 34; delete n.fontSize; } this.scene.edges = this.scene.edges.filter((x) => x.from !== n.id && x.to !== n.id); this.scene.edges.push({ id: wbUid(), from: target.id, to: n.id, route: (root.mm && root.mm.line) || 'curved', mm: true, endArrow: false, side }); }
		if (target.collapsed) target.collapsed = false;
	},
	// several loose notes become one map: the largest is the root, the rest hang on it in reading order, spread over both sides
	// The text size the notes actually had on screen, as a factor of the bubble's base 14px. Without it a map built from
	// post-its comes out much bigger than the post-its (his report 2026-09-07).
	mmScaleFrom(nodes) {
		const sizes = [];
		for (const n of nodes) { const el = this.nodeEls.get(n.id); const t = el && el.querySelector('.wb-txt'); if (!t) continue; const f = parseFloat(getComputedStyle(t).fontSize); if (f > 0) sizes.push(f); }
		if (!sizes.length) return 1;
		return Math.round(wbClamp((sizes.reduce((a, b) => a + b, 0) / sizes.length) / 14, 0.5, 2.5) * 100) / 100;
	},
	mmFromSelection() {
		const items = [...this.selected].map((id) => this.nodeById(id)).filter((n) => n && (n.type === 'sticky' || n.type === 'text' || n.type === 'shape' || n.type === 'mind') && !this.mmIsTree(n.id)); if (items.length < 2) return;
		items.sort((a, b) => (b.w * b.h) - (a.w * a.h)); const root = items[0]; const rest = items.slice(1).sort((a, b) => (a.y - b.y) || (a.x - b.x));
		this.pushHistory(); root.mm = { dir: 'horizontal', sides: 'both', scale: this.mmScaleFrom(rest) }; if (root.type !== 'mind') root.mmOrig = root.type;
		const left = rest.filter((n) => n.x + n.w / 2 < root.x + root.w / 2), right = rest.filter((n) => !left.includes(n));
		this.mmAttach(left, root, root, -1); this.mmAttach(right, root, root, 1);
		this.mmLayout(root.id); this.selected = new Set([root.id]); this.renderAll(); this.scheduleSave(); this.plugin.toast('Mind map: Tab adds a child, Enter a sibling.');
	},
	mmSetSideDeep(id, side) { for (const d of this.mmDescendants(id)) { const e = this.mmParentEdge(d); if (e) e.side = side; } },
	// a first-level branch moves to the other side of a both-sided root
	mmFlipSide(id) { const root = this.mmRootOf(id); const e = this.mmParentEdge(id); if (!e || !root || e.from !== root.id || (root.mm && root.mm.sides) !== 'both') return false; this.pushHistory(); e.side = (e.side || 1) < 0 ? 1 : -1; this.mmSetSideDeep(id, e.side); this.mmLayout(root.id); this.renderAll(); this.scheduleSave(); return true; },
	mmNavigate(id, key) {
		const n = this.nodeById(id); if (!n) return null; const root = this.mmRootOf(id); const dir = (root.mm && root.mm.dir) || 'horizontal'; const parent = this.mmParent(id); const kids = n.collapsed ? [] : this.mmChildren(id);
		const sibs = parent ? this.mmChildren(parent.id) : []; const i = sibs.findIndex((s) => s.id === id);
		const deeper = dir === 'horizontal' ? 'ArrowRight' : 'ArrowDown', shallower = dir === 'horizontal' ? 'ArrowLeft' : 'ArrowUp', next = dir === 'horizontal' ? 'ArrowDown' : 'ArrowRight', prev = dir === 'horizontal' ? 'ArrowUp' : 'ArrowLeft';
		const onLeft = dir === 'horizontal' && n.x < root.x; // nodes on the left side of a two-sided map
		if (key === (onLeft ? shallower : deeper)) return kids[0] || null; if (key === (onLeft ? deeper : shallower)) return parent; if (key === next) return sibs[i + 1] || null; if (key === prev) return sibs[i - 1] || null; return null;
	},
	// 4. A mind map as a quick way to draft many pages: each child becomes a page card, still hanging in the tree.
	async mmChildrenToPages(parent, col) {
		const kids = this.mmChildren(parent.id).filter((k) => k.type === 'mind');
		if (!kids.length) { this.plugin.toast('No children to turn into pages.'); return; }
		this.pushHistory(); let made = 0;
		for (const k of kids) { const guid = await this.plugin.createPage((k.text || '').trim().split('\n')[0].slice(0, 120) || 'Untitled', col); if (!guid) continue; const card = Object.assign({}, k, { type: 'card', recordGuid: guid, w: 220, h: 60, text: undefined, baseW: 220 }); delete card.text; delete card.color; delete card.fontSize; const oldEl = this.nodeEls.get(k.id); if (oldEl) { oldEl.remove(); this.nodeEls.delete(k.id); } this.scene.nodes = this.scene.nodes.map((x) => (x.id === k.id ? card : x)); made++; }
		const root = this.mmRootOf(parent.id); this.mmLayout(root.id); this.renderAll(); this.scheduleSave();
		this.plugin.toast(made + ' page' + (made === 1 ? '' : 's') + ' created in ' + (col ? col.getName() : 'the collection') + '.');
	},
	mmToggleCollapse(id) { const n = this.nodeById(id); if (!n || !this.mmChildren(id).length) return; this.pushHistory(); n.collapsed = !n.collapsed; if (n.collapsed) { for (const d of this.mmDescendants(id)) this.selected.delete(d); if (!this.selected.size) this.selected = new Set([id]); } const root = this.mmRootOf(id); this.mmLayout(root.id); this.renderAll(); this.scheduleSave(); },
});
{
	// render: mind nodes, hidden subtrees, branch edges, hover affordances
	const baseRenderNode = WbBoard.prototype.renderNode;
	WbBoard.prototype.renderNode = function (n) {
		if ((this._mmHidden && this._mmHidden.has(n.id)) || (this._filterHidden && this._filterHidden.has(n.id))) { const h = this.nodeEls.get(n.id); if (h) { h.remove(); this.nodeEls.delete(n.id); } return; }
		if (n.type !== 'mind') return baseRenderNode.call(this, n);
		let el = this.nodeEls.get(n.id);
		if (el && el.dataset.wbType && el.dataset.wbType !== n.type) { el.remove(); this.nodeEls.delete(n.id); el = null; }
		if (!el) { el = wbEl('div', 'wb-node wb-mind'); el.dataset.id = n.id; el.dataset.wbType = n.type; el.appendChild(wbEl('div', 'wb-txt')); this.nodes.appendChild(el); this.nodeEls.set(n.id, el); }
		el.classList.toggle('wb-mm-root', !!n.mm); el.classList.toggle('wb-mm-cut', !!this.mmClip && (this.mmClip === n.id || this.mmDescendants(this.mmClip).includes(n.id)));
		const rootN = this.mmRootOf(n.id); const shape = this.mmShapeOf(n.id); const sc = this.mmScale(n.id);
		el.classList.toggle('wb-mm-square', shape === 'square'); el.classList.toggle('wb-mm-rounded', shape === 'rounded');
		el.classList.toggle('wb-mm-wrap', !!n.mmW);
		el.style.fontSize = ((n.mm ? 16 : 14) * sc) + 'px'; el.style.padding = '0 ' + ((n.mm ? 20 : 14) * sc) + 'px'; el.style.borderRadius = shape === 'square' ? '0' : shape === 'rounded' ? (8 * sc) + 'px' : (n.mm ? 22 : 17) * sc + 'px'; // square means square (his ruling): no radius at all
		const txt = el.querySelector('.wb-txt'); if (this.editing !== n.id && txt.innerText !== (n.text || '')) txt.innerText = n.text || '';
		// A bubble with no colour of its own wears the nearest coloured ancestor's, and the walk stops BEFORE the root: the root's
		// own colour is the map's chrome, not a branch colour. With nothing set anywhere in the branch it falls back to that
		// branch's own thread colour, so every branch off the root is a different colour, as its thread already was.
		const lookOf = wbNodeColorOf;
		let bgSrc = null;
		for (let a = this.mmParent(n.id), g = 0; a && a !== rootN && g < 200 && !bgSrc; a = this.mmParent(a.id), g++) if (lookOf(a)) bgSrc = a;
		let col = lookOf(n) || (bgSrc ? lookOf(bgSrc) : null) || null;
		if (!col && rootN && rootN !== n) col = this.mmBranchColor(n.id);
		// the text colour comes from the SAME node the background came from, never from a different ancestor (that pairs a dark node's white text with a light node's fill)
		if (col) { const c = wbStickyColor(col); el.style.background = c.hex; el.style.borderColor = c.hex; el.style.color = (!n.color && bgSrc && bgSrc.textColor) || c.fg || wbContrastText(c.hex) || '#1c1c1e'; } else { el.style.background = ''; el.style.borderColor = ''; el.style.color = ''; }
		this.mmFit(n, el);
		el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; el.style.width = n.w + 'px'; el.style.height = n.h + 'px';
	};
	// A tree edge is anchored by the LAYOUT, never by geometry: top-down always leaves the parent's bottom and
	// enters the child's top, sideways always leaves the side the branch grows on. (Free mode keeps the geometric
	// anchors, since there the two nodes can sit anywhere relative to each other.)
	const baseEdgeGeom = WbBoard.prototype.edgeGeom;
	WbBoard.prototype.edgeGeom = function (e) {
		if (e.mm && !e.fromSide && !e.toSide) {
			const root = this.mmRootOf(e.to); const dir = (root && root.mm && root.mm.dir) || 'horizontal';
			if (dir === 'topdown') {
				const a = this.nodeById(e.from), b = this.nodeById(e.to); if (!a || !b) return null;
				if (a.id === root.id) return baseEdgeGeom.call(this, Object.assign({}, e, { fromSide: 'bottom', toSide: 'top' })); // the root's own bus: down, across, down
				// deeper levels: the line drops from a stem near the parent's LEFT edge and turns into the child's left side, so a wide
				// parent never sends its line backwards. wbSidePoint only knows the four mid-side points, so the start point is built here.
				const sc2 = (root.mm && root.mm.scale) || 1, size2 = 6 + (e.width || 1.5) * 1.2;
				const q0 = { x: Math.round(a.x + Math.min(12 * sc2, a.w / 2)), y: a.y + a.h };
				return Object.assign(wbEdgePath(q0, 'bottom', wbSidePoint(b, 'left'), 'left', e.route || 'curved', e.startArrow ? size2 - 0.5 : 0, e.endArrow === false ? 0 : size2 - 0.5), { s0: 'bottom', s1: 'left' });
			}
			if (dir === 'vertical' || dir === 'horizontal') {
				const sides = dir === 'vertical' ? ['bottom', 'top'] : (e.side || 1) < 0 ? ['left', 'right'] : ['right', 'left'];
				// His ruling 2026-09-19: every branch leaves from the SAME point on its side and fans out from there. An earlier
				// try spread the start points along the parent's edge and read as loose threads hanging off the root.
				return baseEdgeGeom.call(this, Object.assign({}, e, { fromSide: sides[0], toSide: sides[1] }));
			}
		}
		return baseEdgeGeom.call(this, e);
	};
	const baseRenderAll = WbBoard.prototype.renderAll;
	WbBoard.prototype.renderAll = function () {
		const hidden = this.mmHidden();
		for (const id of hidden) { const el = this.nodeEls.get(id); if (el) { el.remove(); this.nodeEls.delete(id); } }
		this._mmHidden = hidden;
		baseRenderAll.call(this);
	};
	const baseRenderEdges = WbBoard.prototype.renderEdges;
	WbBoard.prototype.renderEdges = function () {
		baseRenderEdges.call(this);
		const hidden = this._mmHidden || new Set();
		for (const e of this.scene.edges) { const ent = this.edgeEls.get(e.id); if (!ent) continue; ent.grp.classList.toggle('wb-mm', !!e.mm); const hide = hidden.has(e.to) || hidden.has(e.from); ent.grp.style.display = hide ? 'none' : ''; ent.label.style.display = hide ? 'none' : ''; }
	};
	// hidden nodes are skipped by the node reconciler: filter the scene view
	const baseRenderOverlay = WbBoard.prototype.renderOverlay;
	WbBoard.prototype.renderOverlay = function () {
		baseRenderOverlay.call(this);
		// collapse badges and add-child plus for tree nodes
		if (!this.scene.edges.some((e) => e.mm) && !this.scene.nodes.some((n) => n.mm)) return;
		for (const n of this.scene.nodes) {
			if (!this.mmIsTree(n.id) || (this._mmHidden && this._mmHidden.has(n.id))) continue;
			const kids = this.mmChildren(n.id);
			const root = this.mmRootOf(n.id); const dir = (root.mm && root.mm.dir) || 'horizontal'; const isRoot = root.id === n.id; const side = isRoot ? 1 : this.mmSideOf(n.id);
			const spots = []; // where a plus (or the collapse badge) sits; the first spot is always the child spot
			const B = { x: n.x + n.w / 2, y: n.y + n.h, dx: -9, dy: 6 }, T = { x: n.x + n.w / 2, y: n.y, dx: -9, dy: -24 }, R = { x: n.x + n.w, y: n.y + n.h / 2, dx: 6, dy: -9 }, L = { x: n.x, y: n.y + n.h / 2, dx: -24, dy: -9 };
			if (dir === 'vertical' || dir === 'topdown') { spots.push(Object.assign({ act: 'child', side: 1 }, B)); if (!isRoot) { spots.push(Object.assign({ act: 'before' }, L)); spots.push(Object.assign({ act: 'after' }, R)); } }
			else if (isRoot) { spots.push(Object.assign({ act: 'child', side: 1 }, R)); if (root.mm.sides === 'both') spots.push(Object.assign({ act: 'child', side: -1 }, L)); }
			else { spots.push(Object.assign({ act: 'child', side }, side < 0 ? L : R)); spots.push(Object.assign({ act: 'before' }, T)); spots.push(Object.assign({ act: 'after' }, B)); }
			if (n.collapsed && kids.length) { const sp = spots[0]; const q = this.toScreen(sp.x, sp.y); const b = wbEl('div', 'wb-mmbadge', String(this.mmDescendants(n.id).length)); b.style.left = (q.x + sp.dx) + 'px'; b.style.top = (q.y + sp.dy) + 'px'; b.title = 'Expand'; b.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); this.mmToggleCollapse(n.id); }); this.overlay.appendChild(b); }
			else if (this.selected.has(n.id) && this.selected.size === 1) for (const sp of spots) { const q = this.toScreen(sp.x, sp.y); const plus = wbEl('div', 'wb-mmplus' + (sp.act === 'child' ? '' : ' wb-mmplus-sib'), WB_I.plus); plus.style.left = (q.x + sp.dx) + 'px'; plus.style.top = (q.y + sp.dy) + 'px'; plus.title = sp.act === 'child' ? 'Add child (Tab)' : 'Add sibling (Enter)'; plus.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); if (sp.act === 'child') this.mmAddChild(n.id, sp.side); else this.mmAddSibling(n.id, sp.act === 'before'); }); this.overlay.appendChild(plus); }
		}
	};
	// editing: mind nodes size to their text while typing; Tab/Enter add nodes
	const baseBeginEdit = WbBoard.prototype.beginEdit;
	WbBoard.prototype.beginEdit = function (id) { baseBeginEdit.call(this, id); const n = this.nodeById(id); const el = this.nodeEls.get(id); if (n && el && n.type === 'mind') { const txt = el.querySelector('.wb-txt'); const fit = () => { n.text = txt.innerText.replace(/\n$/, ''); this.mmFit(n, el); const root = this.mmRootOf(n.id); if (root) this.mmLayout(root.id); this.renderNodesFast(this.scene.nodes); this.renderEdges(); this.renderOverlay(); }; txt.addEventListener('input', fit); this._mmFitHandler = { txt, fit }; } };
	const baseCommitEdit = WbBoard.prototype.commitEdit;
	WbBoard.prototype.commitEdit = function () { if (this._mmFitHandler) { try { this._mmFitHandler.txt.removeEventListener('input', this._mmFitHandler.fit); } catch (e) {} this._mmFitHandler = null; } const id = this.editing; baseCommitEdit.call(this); const n = id && this.nodeById(id); if (n && n.type === 'mind') { const root = this.mmRootOf(n.id); if (root) { this.mmLayout(root.id); this.renderAll(); } } };
	const baseOnKey = WbBoard.prototype.onKey;
	WbBoard.prototype.onKey = function (e) {
		const one = this.selected.size === 1 ? this.nodeById([...this.selected][0]) : null; const meta = e.metaKey || e.ctrlKey;
		const tt = e.target; const inInput = !!(tt && tt.tagName && (tt.tagName === 'INPUT' || tt.tagName === 'TEXTAREA'));
		if (one && this.mmIsTree(one.id) && !this.nativeEdit && !inInput) {
			if (meta && !e.shiftKey && (e.key === 'x' || e.key === 'X') && this.mmParent(one.id) && !this.editing) { e.preventDefault(); e.stopPropagation(); this.mmClip = one.id; this.renderAll(); this.plugin.toast('Branch cut. Select another branch and press Cmd+V to graft it there.'); return; }
			if (meta && !e.shiftKey && (e.key === 'v' || e.key === 'V') && this.mmClip && this.nodeById(this.mmClip) && !this.editing) { e.preventDefault(); e.stopPropagation(); const id = this.mmClip; this.mmClip = null; if (id !== one.id && !this.mmDescendants(id).includes(one.id)) { const root = this.mmRootOf(one.id); const both = (root.mm && root.mm.sides) === 'both'; const n0 = this.nodeById(id); const x0 = n0.x, y0 = n0.y; if (this.mmReparent(id, one.id, one.id === root.id && both ? this.mmSideOf(id) : null) && this.mmIsFree(root)) { this.mmFreeSpot(one, n0); const ddx = n0.x - x0, ddy = n0.y - y0; for (const q of this.mmDescendants(id)) { const c2 = this.nodeById(q); if (c2) { c2.x += ddx; c2.y += ddy; } } this.renderAll(); this.scheduleSave(); } } else this.renderAll(); return; }
			if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && meta && e.shiftKey) { e.preventDefault(); e.stopPropagation(); this.mmMoveOrder(one.id, e.key === 'ArrowUp' ? -1 : 1); return; }
			if (e.key === 'Tab' && !meta) { e.preventDefault(); e.stopPropagation(); this.mmAddChild(one.id); return; }
			if (e.key === 'Enter' && !meta && !e.shiftKey) { if (this.editing === one.id && one.type !== 'mind') return baseOnKey.call(this, e); e.preventDefault(); e.stopPropagation(); if (this.editing) this.commitEdit(); if (one.mm && !this.mmParent(one.id)) this.mmAddChild(one.id); else this.mmAddSibling(one.id); return; }
			if (!this.editing) {
				if (e.key.startsWith('Arrow') && !e.shiftKey && !meta) { const t = this.mmNavigate(one.id, e.key); if (t) { e.preventDefault(); e.stopPropagation(); this.selected = new Set([t.id]); this.renderAll(); return; } }
				if ((e.key === 'Backspace' || e.key === 'Delete') && this.mmParent(one.id)) { e.preventDefault(); e.stopPropagation(); this.mmDelete(one.id); return; }
				if (meta && e.key === '.') { e.preventDefault(); e.stopPropagation(); this.mmToggleCollapse(one.id); return; }
			} else if (e.key === 'Backspace' && one.type === 'mind' && !(one.text || '').length && this.mmParent(one.id)) { const el = this.nodeEls.get(one.id); const txt = el && el.querySelector('.wb-txt'); if (txt && !txt.innerText.trim()) { e.preventDefault(); e.stopPropagation(); this.commitEdit(); this.mmDelete(one.id); return; } }
		}
		return baseOnKey.call(this, e);
	};
	// drag: a subtree root moves the map, a child dropped on a node re-parents, otherwise it snaps back
	const baseOnUp = WbBoard.prototype.onUp;
	WbBoard.prototype.onUp = function (e, cancelled) {
		const d = this.drag; const dropped = d && d.kind === 'move' && d.moved ? d.items.slice() : [];
		const item = d && d.kind === 'move' && d.moved ? (d.items.length === 1 ? d.items[0] : d.primary ? this.nodeById(d.primary) : null) : null;
		baseOnUp.call(this, e, cancelled);
		if (dropped.length && !cancelled && dropped.every((n) => !this.mmIsTree(n.id) && (n.type === 'sticky' || n.type === 'text' || n.type === 'shape'))) { if (this.mmAdopt(dropped, e)) return; } // loose notes dropped on a branch join the map as bubbles
		if (!item || !this.mmIsTree(item.id)) return;
		const parent = this.mmParent(item.id);
		if (!parent) { if (!this.mmIsFree(item)) this.mmLayout(item.id); this.renderAll(); return; }
		const root = this.mmRootOf(item.id); const pt = this.localPt(e); const w = this.toWorld(pt.x, pt.y); const horiz = ((root.mm && root.mm.dir) || 'horizontal') === 'horizontal'; const both = horiz && (root.mm && root.mm.sides) === 'both';
		const skip = new Set([item.id].concat(this.mmDescendants(item.id))); const target = this.scene.nodes.find((n) => !skip.has(n.id) && this.mmIsTree(n.id) && w.x >= n.x && w.x <= n.x + n.w && w.y >= n.y && w.y <= n.y + n.h);
		if (target) { const tr = this.mmRootOf(target.id); const tBoth = ((tr.mm && tr.mm.dir) || 'horizontal') === 'horizontal' && (tr.mm && tr.mm.sides) === 'both'; const side = target.id === tr.id && tBoth ? (w.x < tr.x + tr.w / 2 ? -1 : 1) : null; if (this.mmReparent(item.id, target.id, side)) return; }
		if (both && parent.id === root.id) { const cx = item.x + item.w / 2; const want = cx < root.x + root.w / 2 ? -1 : 1; if (want !== (this.mmSideOf(item.id) || 1)) { if (this.mmFlipSide(item.id)) return; } } // carried across the root: it changes side
		if (!e.metaKey && !this.mmIsFree(root)) {
			const i = d && d.items ? d.items.indexOf(item) : -1; const o = i >= 0 && d.orig ? d.orig[i] : null;
			if (this.mmDropReorder(item, o ? { dx: item.x - o.x, dy: item.y - o.y } : null)) return;
			this.mmLayout(root.id); this.renderAll();
		} // free: the node stays exactly where it was dropped
	};
	// Cmd+V on a bubble grafts whatever is on the clipboard onto it, exactly like dragging a post-it onto a bubble (his ask 2026-09-06).
	// The in-tree branch cut (mmClip) is handled in onKey and never reaches this; here the payload comes from copySelection/cut.
	const basePasteClip = WbBoard.prototype.pasteClip;
	WbBoard.prototype.pasteClip = function (text) {
		const target = this.selected.size === 1 ? this.nodeById([...this.selected][0]) : null; // read the target BEFORE the paste replaces the selection
		const ok = basePasteClip.call(this, text);
		if (!ok || !target || this.editing || !this.mmIsTree(target.id) || !this.nodeById(target.id)) return ok;
		const pasted = [...this.selected].map((id) => this.nodeById(id)).filter(Boolean);
		const tops = pasted.filter((n) => n.type !== 'note' && !this.scene.edges.some((x) => x.mm && x.to === n.id)); // a pasted branch hangs by its own top only
		if (!tops.length) return ok;
		const root = this.mmRootOf(target.id); const both = (root.mm && root.mm.sides) === 'both';
		const side = target.id === root.id && both ? null : this.mmSideOf(target.id); // null on a two-sided root: mmLayout puts it on the emptier side
		this.pushHistory();
		for (const n of tops) {
			const el = this.nodeEls.get(n.id); if (el) { el.remove(); this.nodeEls.delete(n.id); }
			if (n.type !== 'mind') { n.mmOrig = n.type; n.type = 'mind'; n.w = 90; n.h = 34; delete n.fontSize; }
			this.scene.edges = this.scene.edges.filter((x) => !(x.mm && x.to === n.id)); // its own children come along, only an old parent link goes
			this.scene.edges.push({ id: wbUid(), from: target.id, to: n.id, route: (root.mm && root.mm.line) || 'curved', mm: true, endArrow: false, side });
			if (this.mmIsFree(root)) this.mmFreeSpot(target, n); // free maps do not lay out, so put it beside its new parent instead of under the pointer
		}
		if (target.collapsed) target.collapsed = false;
		this.mmLayout(root.id); this.renderAll(); this.scheduleSave();
		return ok;
	};
	const baseDeleteSel = WbBoard.prototype.deleteSelection;
	WbBoard.prototype.deleteSelection = function () { const ids = [...this.selected]; if (ids.length === 1 && this.mmIsTree(ids[0]) && this.mmParent(ids[0])) { this.mmDelete(ids[0]); return; } return baseDeleteSel.call(this); };
	// toolbar: Mind map controls
	const baseBuildCtx = WbBoard.prototype.buildCtx;
	WbBoard.prototype.buildCtx = function () {
		baseBuildCtx.call(this); if (!this.ctx) return;
		const sel = [...this.selected].map((id) => this.nodeById(id)).filter(Boolean);
		const del = [...this.ctx.querySelectorAll('.wb-tb')].find((x) => x.title === 'Delete');
		const ins = (el) => this.ctx.insertBefore(el, del || null);
		// bubble shape: an own shape on the node beats the map's, and the control edits every bubble in the selection
		const shapeCtl = (items) => {
			const mapShape = (this.mmRootOf(items[0].id).mm || {}).shape || 'pill'; const cur = items.every((n) => (n.mmShape || '') === (items[0].mmShape || '')) ? items[0].mmShape || '' : null;
			const worn = this.mmShapeOf(items[0].id); // what it shows today, whether that came from itself, an ancestor or the map
			const rows = [{ v: '', label: 'Inherit', svg: WB_MM_SHAPE_I[mapShape] }, { sep: true }].concat(WB_MM_SHAPES.map((r) => ({ v: r.v, label: r.label, svg: WB_MM_SHAPE_I[r.v] })));
			return this.tb(WB_MM_SHAPE_I[cur || worn] + WB_I.chev, items.length > 1 ? 'Shape of every bubble selected' : 'Bubble shape', (b) => this.menu(b, rows, null, (v) => { this.pushHistory(); for (const n of items) n.mmShape = v || null; this.renderAll(); this.buildCtx(); this.scheduleSave(); }, { width: 200, checks: false, isChecked: (v) => v === cur }));
		};
		if (sel.length > 1) { if (sel.every((n) => n.type === 'mind')) { ins(this.sep()); ins(shapeCtl(sel)); } return; }
		const one = sel.length === 1 ? sel[0] : null; if (!one) return;
		if (!this.mmIsTree(one.id)) return; // turning something INTO a mind map now lives in the Selection menu
		const root = this.mmRootOf(one.id); const isRoot = !this.mmParent(one.id);
		ins(this.sep());
		if (!isRoot && this.mmParent(one.id) && this.mmParent(one.id).id === root.id && (root.mm && root.mm.sides) === 'both' && ((root.mm && root.mm.dir) || 'horizontal') === 'horizontal') ins(this.tb(WB_SVG('<path d="M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4"></path>') + '<span>Other side</span>', 'Move this branch to the other side of the root (or drag it across)', () => this.mmFlipSide(one.id)));
		if (this.mmChildren(one.id).length) ins(this.tb(WB_SVG('<path d="M6 9l6 6 6-6"></path>') + '<span>' + (one.collapsed ? 'Expand' : 'Collapse') + '</span>', 'Collapse or expand this branch (Cmd+.)', () => this.mmToggleCollapse(one.id)));
		if (isRoot) {
			const dir = (root.mm && root.mm.dir) || 'horizontal'; const lay = dir === 'vertical' || dir === 'free' || dir === 'topdown' ? dir : (root.mm.sides === 'both' ? 'both' : 'right'); const ln = (root.mm && root.mm.line) || 'curved'; const shp = (root.mm && root.mm.shape) || 'pill';
			const I = {
				both: WB_SVG('<path d="M3 12h18"></path><path d="M7 8l-4 4 4 4"></path><path d="M17 8l4 4-4 4"></path>'), right: WB_SVG('<path d="M4 12h16"></path><path d="M14 6l6 6-6 6"></path>'), vertical: WB_SVG('<path d="M12 4v4"></path><path d="M5 8h14"></path><path d="M5 8v4"></path><path d="M12 8v4"></path><path d="M19 8v4"></path>'), topdown: WB_SVG('<path d="M12 3v3"></path><path d="M6 6h12"></path><path d="M6 6v3"></path><path d="M18 6v3"></path><path d="M9 12v7"></path><path d="M9 15h5"></path><path d="M9 19h5"></path>'), free: WB_SVG('<circle cx="6" cy="8" r="2"></circle><circle cx="18" cy="6" r="2"></circle><circle cx="10" cy="18" r="2"></circle><path d="M8 8h8"></path><path d="M7 10l3 6"></path>'),
				pill: WB_MM_SHAPE_I.pill, rounded: WB_MM_SHAPE_I.rounded, square: WB_MM_SHAPE_I.square,
			};
			const items = [
				{ v: 'lay:both', label: 'Both sides', svg: I.both }, { v: 'lay:right', label: 'Rightwards', svg: I.right }, { v: 'lay:topdown', label: 'Top-down', svg: I.topdown }, { v: 'lay:vertical', label: 'Org chart', svg: I.vertical }, { v: 'lay:free', label: 'Free', svg: I.free }, { sep: true },
				{ v: 'line:curved', label: 'Curved lines', svg: WB_I.curved }, { v: 'line:straight', label: 'Straight lines', svg: WB_I.straight }, { v: 'line:elbow', label: 'Elbow lines', svg: WB_I.elbow }, { sep: true },
				{ v: 'shape:pill', label: 'Pills', svg: I.pill }, { v: 'shape:rounded', label: 'Rounded boxes', svg: I.rounded }, { v: 'shape:square', label: 'Square boxes', svg: I.square },
			];
			ins(this.tb(WB_SVG('<circle cx="12" cy="12" r="3"></circle><path d="M12 9V4"></path><path d="M12 15v5"></path><path d="M9 12H4"></path><path d="M15 12h5"></path>') + '<span>Mind map</span>' + WB_I.chev, 'Layout, lines and node shape', (b) => this.menu(b, items, null, (v) => {
				const [k, val] = v.split(':');
				if (k === 'line') { this.mmSetLine(root, val); return; }
				this.pushHistory();
				if (k === 'lay') { root.mm.dir = val === 'vertical' || val === 'free' || val === 'topdown' ? val : 'horizontal'; if (val === 'both' || val === 'right') root.mm.sides = val === 'both' ? 'both' : 'right'; this.mmLayout(root.id); }
				else { root.mm.shape = val; }
				this.renderAll(); this.scheduleSave();
			}, { width: 230, checks: false, isChecked: (v) => v === 'lay:' + lay || v === 'line:' + ln || v === 'shape:' + shp })));
		}
		if (one.type === 'mind') ins(shapeCtl([one]));
		const col = one.color ? wbStickyColor(one.color).hex : 'transparent';
		ins(this.tb('<span class="wb-cdot" style="background:' + col + ';border:1px dashed var(--wb-muted)"></span>', 'Node color', (b) => this.colorPop(b, one.color || null, (id) => { this.pushHistory(); one.color = id || null; const r = this.mmRootOf(one.id); if (r) this.mmRecolor(r.id); this.renderAll(); this.scheduleSave(); }, { auto: 'Default' })));
	};
	// the tool rail: N adds a sticky; on a selected tree node the Sticky/Text tools still work normally
	// creating a mind map from the palette
	const basePluginOnLoad = Plugin.prototype.onLoad;
	Plugin.prototype.onLoad = function () { basePluginOnLoad.call(this); this.ui.injectCSS(WB_MM_CSS); };
}

// ===========================================================================
// Phase 3b: Comments. Pins on a node (they follow it) or on a point; threads with resolve.
// Phase 3c: Tags on stickies, shared per board.
// ===========================================================================
const WB_CT_CSS = [
'.wb-pin{position:absolute;width:24px;height:24px;margin:-12px 0 0 -12px;border-radius:12px 12px 12px 2px;background:var(--wb-accent);color:#0a0a0b;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;box-shadow:0 2px 4px rgba(0,0,0,.4);pointer-events:auto;cursor:pointer;}',
'.wb-pin.is-resolved{background:var(--wb-surface);color:var(--wb-muted);border:1px solid var(--wb-line);}',
'.wb-pin .wb-pincount{position:absolute;right:-6px;top:-6px;min-width:14px;height:14px;padding:0 3px;border-radius:7px;background:var(--wb-bg);border:1px solid var(--wb-line);color:var(--wb-text);font-size:9px;display:flex;align-items:center;justify-content:center;}',
'.wb-thread{position:fixed;z-index:100003;width:300px;background:var(--wb-surface,var(--cmdpal-bg-color,#212126));border:1px solid var(--wb-line,rgba(196,196,196,.14));border-radius:var(--radius-normal,3px);box-shadow:var(--color-shadow-cards,0 4px 6px rgba(0,0,0,.2));padding:10px;font-size:12.5px;color:var(--text-color);}',
'.wb-thread .wb-thead{display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:11px;color:var(--wb-muted);}',
'.wb-thread .wb-thead .wb-tb{margin-left:auto;}',
'.wb-thread .wb-msg{margin-bottom:8px;}',
'.wb-thread .wb-msg .wb-mby{font-size:11px;color:var(--wb-muted);display:flex;gap:8px;}',
'.wb-thread .wb-msg .wb-mtext{white-space:pre-wrap;line-height:1.4;}',
'.wb-thread textarea{width:100%;box-sizing:border-box;min-height:44px;padding:6px 8px;border:1px solid var(--wb-line,rgba(196,196,196,.14));border-radius:var(--radius-normal,3px);background:transparent;color:var(--text-color);font:inherit;font-size:12.5px;outline:none;resize:vertical;}',
'.wb-thread textarea:focus{border-color:var(--wb-accent);}',
'.wb-thread .wb-tfoot{display:flex;justify-content:space-between;align-items:center;margin-top:6px;font-size:11px;color:var(--wb-faint);}',
'.wb-canvas.wb-tool-comment{cursor:crosshair;}',
'.wb-tagrow{position:absolute;left:.8em;right:.8em;bottom:.7em;display:flex;flex-wrap:wrap;gap:.4em;pointer-events:none;}',
'.wb-tag{max-width:100%;padding:.2em .6em;border-radius:calc(var(--radius-normal,3px) / var(--wb-z,1));font-size:1em;line-height:1.25;font-weight:600;color:#1c1c1e;display:inline-block;text-align:left;white-space:normal;overflow-wrap:anywhere;box-sizing:border-box;}',
'.wb-sticky.wb-has-tags{padding-bottom:28px;}',
].join('\n');
Object.assign(WbBoard.prototype, {
	// --- comments -------------------------------------------------------------------------
	meName() { try { const u = window.g_universe && window.g_universe.activeUser; return (u && (u.name || u.handle || u.email)) || 'Me'; } catch (e) { return 'Me'; } },
	comments() { this.scene.comments = this.scene.comments || []; return this.scene.comments; },
	commentPos(c) { if (c.anchor) { const n = this.nodeById(c.anchor); if (!n) return null; return { x: n.x + n.w - 6 + (c.dx || 0), y: n.y - 6 + (c.dy || 0) }; } return { x: c.x, y: c.y }; },
	addComment(wx, wy, hit) {
		const c = { id: wbUid(), anchor: hit ? hit.id : null, x: Math.round(wx), y: Math.round(wy), dx: 0, dy: 0, thread: [], resolved: false, created: Date.now() };
		if (hit) { c.dx = 0; c.dy = 0; }
		this.pushHistory(); this.comments().push(c); this.setTool('select'); this.renderOverlay(); this.openThread(c, true);
	},
	openThread(c, fresh) {
		this.plugin.closeMenus();
		const pop = wbEl('div', 'wb-thread'); pop.addEventListener('pointerdown', (e) => e.stopPropagation());
		const head = wbEl('div', 'wb-thead', '<span>' + (c.anchor ? 'On ' + wbEsc((this.nodeById(c.anchor) || {}).text || 'a card') : 'On the board') + '</span>');
		const res = this.tb('<span>' + (c.resolved ? 'Reopen' : 'Resolve') + '</span>', c.resolved ? 'Reopen this comment' : 'Mark as resolved', () => { this.pushHistory(); c.resolved = !c.resolved; this.plugin.closeMenus(); this.renderOverlay(); this.scheduleSave(); });
		const del = this.tb(WB_I.trash, 'Delete comment', () => { this.pushHistory(); this.scene.comments = this.comments().filter((x) => x !== c); this.plugin.closeMenus(); this.renderOverlay(); this.scheduleSave(); });
		head.appendChild(res); head.appendChild(del); pop.appendChild(head);
		for (const m of c.thread) { const d = wbEl('div', 'wb-msg'); d.appendChild(wbEl('div', 'wb-mby', '<span>' + wbEsc(m.by) + '</span><span>' + wbEsc(new Date(m.at).toLocaleString()) + '</span>')); d.appendChild(wbEl('div', 'wb-mtext', wbEsc(m.text))); pop.appendChild(d); }
		const ta = document.createElement('textarea'); ta.placeholder = c.thread.length ? 'Reply' : 'Write a comment'; pop.appendChild(ta);
		pop.appendChild(wbEl('div', 'wb-tfoot', '<span>Enter posts, Shift+Enter for a new line</span>'));
		const post = () => { const t = ta.value.trim(); if (!t) return; this.pushHistory(); c.thread.push({ text: t, at: Date.now(), by: this.meName() }); this.scheduleSave(); this.openThread(c); };
		ta.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); post(); } });
		this.host.appendChild(pop); this.plugin._pop = pop;
		const p = this.commentPos(c) || { x: 0, y: 0 }; const s = this.toScreen(p.x, p.y); const cr = this.canvas.getBoundingClientRect(); const hr = this.host.getBoundingClientRect();
		pop.style.left = Math.max(hr.left + 8, Math.min(cr.left + s.x + 16, hr.right - 308)) + 'px'; pop.style.top = Math.max(hr.top + 8, Math.min(cr.top + s.y - 10, hr.bottom - pop.offsetHeight - 8)) + 'px';
		const out = (e) => { if (!pop.contains(e.target)) { this.plugin.closeMenus(); if (fresh && !c.thread.length) { this.scene.comments = this.comments().filter((x) => x !== c); this.renderOverlay(); } } }; document.addEventListener('pointerdown', out, true); pop._out = out;
		setTimeout(() => ta.focus(), 0);
	},
	renderPins() {
		const showRes = !!(this.scene.settings && this.scene.settings.showResolved);
		for (const c of this.comments()) {
			if (c.resolved && !showRes) continue; const p = this.commentPos(c); if (!p) continue; const s = this.toScreen(p.x, p.y);
			const pin = wbEl('div', 'wb-pin' + (c.resolved ? ' is-resolved' : ''), wbEsc((c.thread[0] && c.thread[0].by || this.meName()).charAt(0).toUpperCase()) + (c.thread.length > 1 ? '<span class="wb-pincount">' + c.thread.length + '</span>' : ''));
			pin.style.left = s.x + 'px'; pin.style.top = s.y + 'px'; pin.title = c.thread[0] ? c.thread[0].text.slice(0, 80) : 'Comment';
			pin.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); this.openThread(c); });
			this.overlay.appendChild(pin);
		}
	},
	// --- tags ------------------------------------------------------------------------------
	tags() { this.scene.tags = this.scene.tags || []; return this.scene.tags; },
	// Tags, Miro's way: a colour dot + "Enter tag" field on top, then the board's tags as pills (filled = on the selection,
	// click toggles), each with a pencil that opens edit mode (name, colour, Done / Delete tag / Cancel). Stays open.
	tagMenu(anchor, items) {
		this.plugin.closeMenus();
		const pop = wbEl('div', 'wb-tagpop'); pop.addEventListener('pointerdown', (e) => e.stopPropagation()); pop.addEventListener('mousedown', (e) => e.stopPropagation());
		const state = { color: 'yellow', editing: null, palette: false };
		const isOn = (id) => items.length > 0 && items.every((n) => (n.tags || []).includes(id));
		const dotEl = (color, onPick) => { const d = wbEl('span', 'wb-tagdot'); d.style.background = wbStickyColor(color).hex; d.title = 'Colour'; d.addEventListener('click', (e) => { e.stopPropagation(); state.palette = !state.palette; render(); }); return d; };
		const paletteEl = (current, onPick) => { const g = wbEl('div', 'wb-tagpalette'); for (const c of WB_STICKY_COLORS) { const sw = wbEl('div', 'wb-sw' + (c.id === current ? ' is-on' : '')); sw.style.background = c.hex; sw.title = c.id; sw.addEventListener('click', (e) => { e.stopPropagation(); onPick(c.id); state.palette = false; render(); }); g.appendChild(sw); } return g; };
		const render = () => {
			pop.innerHTML = ''; const tags = this.tags();
			if (state.editing) {
				const t = state.editing; const row = wbEl('div', 'wb-tagpop-row'); row.appendChild(dotEl(t.color));
				const inp = document.createElement('input'); inp.className = 'wb-taginput'; inp.value = t.name; inp.placeholder = 'Tag name'; row.appendChild(inp);
				const done = wbEl('span', 'wb-taglink wb-taglink-primary', 'Done'); row.appendChild(done); pop.appendChild(row);
				if (state.palette) pop.appendChild(paletteEl(t.color, (id) => { t.color = id; }));
				const row2 = wbEl('div', 'wb-tagpop-row wb-tagpop-actions'); const del = wbEl('span', 'wb-taglink wb-taglink-danger', 'Delete tag'); const cancel = wbEl('span', 'wb-taglink', 'Cancel'); row2.appendChild(del); row2.appendChild(cancel); pop.appendChild(row2);
				const commit = () => { const name = inp.value.trim(); this.pushHistory(); const real = tags.find((x) => x.id === t.id); if (real) { if (name) real.name = name; real.color = t.color; } state.editing = null; state.palette = false; this.renderAll(); this.scheduleSave(); render(); };
				done.addEventListener('click', (e) => { e.stopPropagation(); commit(); });
				inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') { e.preventDefault(); state.editing = null; render(); } });
				del.addEventListener('click', (e) => { e.stopPropagation(); this.pushHistory(); this.scene.tags = tags.filter((x) => x.id !== t.id); for (const n of this.scene.nodes) if (n.tags) n.tags = n.tags.filter((x) => x !== t.id); state.editing = null; this.renderAll(); this.scheduleSave(); render(); });
				cancel.addEventListener('click', (e) => { e.stopPropagation(); state.editing = null; state.palette = false; render(); });
				setTimeout(() => { inp.focus(); inp.select(); }, 0); return;
			}
			const row = wbEl('div', 'wb-tagpop-row'); row.appendChild(dotEl(state.color));
			const inp = document.createElement('input'); inp.className = 'wb-taginput'; inp.placeholder = 'Enter tag'; row.appendChild(inp); pop.appendChild(row);
			if (state.palette) pop.appendChild(paletteEl(state.color, (id) => { state.color = id; }));
			inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); const name = inp.value.trim(); if (!name) return; this.pushHistory(); const existing = tags.find((x) => x.name.toLowerCase() === name.toLowerCase()); const t = existing || { id: wbUid(), name, color: state.color }; if (!existing) tags.push(t); for (const n of items) { n.tags = n.tags || []; if (!n.tags.includes(t.id)) n.tags.push(t.id); } for (const n of items) this.renderNode(n); this.renderOverlay(); this.scheduleSave(); render(); } if (e.key === 'Escape') { e.preventDefault(); this.plugin.closeMenus(); } });
			if (tags.length) {
				const list = wbEl('div', 'wb-tagpills');
				for (const t of tags) {
					const on = isOn(t.id); const pill = wbEl('span', 'wb-tagpill' + (on ? ' is-on' : '')); if (on) pill.style.background = wbStickyColor(t.color).hex;
					pill.appendChild(wbEl('span', 'wb-tagpill-name', wbEsc(t.name)));
					const pen = wbEl('span', 'wb-tagpen', WB_SVG('<path d="M4 20h4l10-10-4-4L4 16z"></path>')); pen.title = 'Edit tag'; pen.addEventListener('click', (e) => { e.stopPropagation(); state.editing = { id: t.id, name: t.name, color: t.color }; state.palette = false; render(); }); pill.appendChild(pen);
					pill.addEventListener('click', (e) => { e.stopPropagation(); this.pushHistory(); const want = !isOn(t.id); for (const n of items) { n.tags = (n.tags || []).filter((x) => x !== t.id); if (want) n.tags.push(t.id); } for (const n of items) this.renderNode(n); this.renderOverlay(); this.scheduleSave(); render(); });
					list.appendChild(pill);
				}
				pop.appendChild(list);
			}
			setTimeout(() => inp.focus(), 0);
		};
		render();
		this.host.appendChild(pop); this.plugin._pop = pop;
		const r = anchor.getBoundingClientRect(); const hr = this.host.getBoundingClientRect();
		pop.style.left = Math.max(hr.left + 8, Math.min(r.left, hr.right - 300 - 8)) + 'px'; pop.style.top = Math.min(r.bottom + 6, hr.bottom - 200) + 'px';
		const out = (e) => { if (!pop.contains(e.target)) this.plugin.closeMenus(); }; document.addEventListener('pointerdown', out, true); pop._out = out;
	},
	renderTags(n, el) {
		let row = el.querySelector('.wb-tagrow'); const ids = (n.tags || []).filter((id) => this.tags().some((t) => t.id === id));
		if (!ids.length) { if (row) row.remove(); el.classList.remove('wb-has-tags'); el.style.paddingBottom = wbStickyPad(n) + 'px'; return; } // clearing it would fall back to the stylesheet's 14 px and squeeze small notes
		if (!row) { row = wbEl('div', 'wb-tagrow'); el.appendChild(row); }
		row.style.fontSize = Math.max(5, Math.min(14, n.w / 18)).toFixed(1) + 'px'; // tags follow the note's size
		row.innerHTML = ids.map((id) => { const t = this.tags().find((x) => x.id === id); return '<span class="wb-tag" style="background:' + wbStickyColor(t.color).hex + '">' + wbEsc(t.name) + '</span>'; }).join(''); el.classList.add('wb-has-tags');
		el.style.paddingBottom = (row.offsetHeight + Math.max(wbStickyPad(n), Math.round(n.w * 0.09))) + 'px';
	},
});
{
	const baseOnDown = WbBoard.prototype.onDown;
	WbBoard.prototype.onDown = function (e) {
		if (this.tool === 'comment' && e.button === 0) { const t = e.target; if (t.closest && (t.closest('.wb-ctx') || t.closest('.wb-rail') || t.closest('.wb-zoom') || t.closest('.wb-pin'))) return baseOnDown.call(this, e); this.commitEdit(); const pt = this.localPt(e); const w = this.toWorld(pt.x, pt.y); const hit = this.hitNode(e); e.preventDefault(); this.addComment(w.x, w.y, hit); return; }
		return baseOnDown.call(this, e);
	};
	const baseRenderOverlay = WbBoard.prototype.renderOverlay;
	WbBoard.prototype.renderOverlay = function () { baseRenderOverlay.call(this); this.renderPins(); };
	const baseRenderNode = WbBoard.prototype.renderNode;
	WbBoard.prototype.renderNode = function (n) { baseRenderNode.call(this, n); if (n.type === 'sticky') { const el = this.nodeEls.get(n.id); if (el) { this.renderTags(n, el); this.fitSticky(n, el); } } };
	// comments follow deleted nodes out; tags menu in the sticky toolbar; resolved toggle in settings
	const baseDelete = WbBoard.prototype.deleteSelection;
	WbBoard.prototype.deleteSelection = function () { const ids = new Set(this.selected); baseDelete.call(this); if (ids.size) { this.scene.comments = this.comments().filter((c) => !c.anchor || !ids.has(c.anchor)); this.renderOverlay(); } };
	const baseBuildCtx = WbBoard.prototype.buildCtx;
	WbBoard.prototype.buildCtx = function () {
		baseBuildCtx.call(this); if (!this.ctx) return;
		const sel = [...this.selected].map((id) => this.nodeById(id)).filter(Boolean); if (!sel.length || !sel.every((n) => n.type === 'sticky')) return;
		const del = [...this.ctx.querySelectorAll('.wb-tb')].find((x) => x.title === 'Delete');
		const btn = this.tb(WB_SVG('<path d="M4 4h7l9 9-7 7-9-9z"></path><circle cx="8.5" cy="8.5" r="1"></circle>') + '<span>Tag</span>' + WB_I.chev, 'Tags', (b) => this.tagMenu(b, sel), !!(sel[0].tags && sel[0].tags.length));
		this.ctx.insertBefore(btn, del || null); this.ctx.insertBefore(this.sep(), del || null);
	};
	const baseBoardMenu = WbBoard.prototype.boardMenu;
	WbBoard.prototype.boardMenu = function (anchor) {
		// add the resolved-comments toggle by wrapping the menu items list
		const s = this.scene.settings = this.scene.settings || {}; const orig = wbMenu;
		baseBoardMenu.call(this, anchor);
		const menu = wbM.el; if (!menu) return;
		const list = menu.querySelector('.vcontent'); if (!list) return;
		const row = document.createElement('div'); row.className = 'autocomplete--option' + (s.showResolved ? ' qb-checked' : ''); row.innerHTML = '<span class="autocomplete--option-icon"><span class="ti ti-message-check"></span></span><span class="autocomplete--option-label">Show resolved comments</span>';
		row.addEventListener('click', (e) => { e.stopPropagation(); wbCloseMenu(); s.showResolved = !s.showResolved; this.renderOverlay(); this.scheduleSave(); });
		list.appendChild(row);
	};
	const basePluginOnLoad = Plugin.prototype.onLoad;
	Plugin.prototype.onLoad = function () { basePluginOnLoad.call(this); this.ui.injectCSS(WB_CT_CSS); };
}

// ===========================================================================
// Note cards (phase 1, 2026-09-05). A card IS a block: a line (with children) in a Thymer page. A card made on the board
// lives in the board's own page; "Attach to page" MOVES the block to the end of that page (Move To logic, refs intact).
// Existing lines/blocks brought in are the same thing. Idle cards show a light rendering; editing floats the REAL editor.
// ===========================================================================
function wbParseRgb(str) { const m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?/.exec(String(str || '')); if (!m) return null; const a = m[4] == null ? 1 : parseFloat(m[4]); if (a === 0) return null; return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]; }
function wbMixRgb(a, b, t) { return 'rgb(' + a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',') + ')'; }
// A coloured card is a light surface whatever the app theme. Thymer themes are just custom properties on
// html[data-theme=...], so copy the user's light theme (localStorage.theme.light, else thymer-light) onto the card and
// its floating editor: grabber, fold chevron, + button, selection, bullets all follow. Built once per load.
function wbInjectLightCardTheme() {
	try {
		if (document.getElementById('wb-light-card-theme')) return;
		let light = 'thymer-light'; try { const t = JSON.parse(localStorage.getItem('theme') || '{}'); if (t && typeof t.light === 'string' && t.light) light = t.light; } catch (e) {}
		const want = new Set(['html[data-theme="' + light + '"]', 'html.is-light']); let css = '';
		for (const ss of [...document.styleSheets, ...(document.adoptedStyleSheets || [])]) {
			let rules = null; try { rules = ss.cssRules; } catch (e) { continue; }
			for (const r of rules) { if (!r.selectorText || !r.style) continue; const sels = r.selectorText.split(',').map((x) => x.trim()); if (!sels.some((x) => want.has(x))) continue; for (let i = 0; i < r.style.length; i++) { const pn = r.style[i]; if (pn.startsWith('--')) css += pn + ':' + r.style.getPropertyValue(pn) + ';'; } }
		}
		if (!css) return;
		const st = document.createElement('style'); st.id = 'wb-light-card-theme'; st.textContent = '.wb-note.wb-colored,.panel.wb-float-editor.wb-colored{' + css + '}'; document.head.appendChild(st);
	} catch (e) { console.warn('[Whiteboard] light card theme', e); }
}
const WB_NOTE_CSS = [
'.wb-note{height:auto !important;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:var(--radius-normal,3px);box-shadow:var(--cards-shadow);padding:34px 0 48px 0;color:var(--text-color);font-size:13.5px;line-height:1.5;cursor:default;box-sizing:border-box;overflow:hidden;position:absolute;isolation:isolate;}',
'.wb-note.wb-colored{color:#1c1c1e;border-color:transparent;}',
'.wb-note .wb-nl{white-space:pre-wrap;word-break:break-word;line-height:var(--wb-lh,24.32px);padding:calc((var(--wb-item-h,30px) - var(--wb-lh,24.32px)) / 2) 0;box-sizing:border-box;}',
'.wb-note .wb-nl.wb-nl-head{font-weight:var(--wb-head-w,300);font-size:var(--wb-head-fs,14.44px);line-height:var(--wb-head-lh,28.88px);padding:0 0 calc(var(--wb-head-h,35px) - var(--wb-head-lh,28.88px)) 0;}',
'.wb-note .wb-nl.wb-nl-task::before{content:"\\2610  ";opacity:.7;}.wb-note .wb-nl.wb-nl-done::before{content:"\\2611  ";opacity:.7;}',
'.wb-note .wb-nl.wb-nl-empty{min-height:1.4em;opacity:.45;}',
'.wb-note .wb-nkids{margin-left:24px;}',
'.wb-note .wb-nref{color:var(--link-color,var(--color-primary-500,#65c8bb));}',
'.wb-note .wb-nfoot{font-size:11px;opacity:.6;margin-top:8px;display:flex;align-items:center;gap:5px;}',
'.wb-note.wb-editing-live{opacity:.35;}',
'.panel.wb-float-editor{position:fixed !important;z-index:100000;border-radius:var(--radius-normal,3px);box-shadow:0 8px 28px rgba(0,0,0,.35);overflow:hidden;border:1px solid var(--wb-accent,#65c8bb);}',
'.panel.wb-float-editor .banner-outer,.panel.wb-float-editor .panel-bar,.panel.wb-float-editor .id--menubar-slot,.panel.wb-float-editor .id--versions-area,.panel.wb-float-editor .id--panel-title-slot,.panel.wb-float-editor .backrefs-footer,.panel.wb-float-editor .panel-heading{display:none !important;}',
'.panel.wb-float-editor .id--crumb-path{font-size:15px;}',
'.panel.wb-float-editor.wb-caret-hold .listview-caret{visibility:hidden !important;}',
'.panel.wb-float-editor .id--propscn,.panel.wb-float-editor .page-props-editor-container{display:none !important;}',
'.panel.wb-float-editor .panel-body{padding-top:34px !important;padding-bottom:48px !important;}',
'.wb-chead{position:absolute;top:0;left:0;right:0;height:34px;display:flex;align-items:center;gap:8px;padding:0 6px 0 12px;user-select:none;z-index:7;background:inherit;border-bottom:1px solid rgba(127,127,127,.14);font-size:12px;}',
'.wb-chead .wb-ctitle{opacity:.6;font-weight:600;display:inline-flex;align-items:center;gap:8px;min-width:0;overflow:hidden;white-space:nowrap;}.wb-chead .wb-ctitle .ti{font-size:17px;}',
'.wb-chead .wb-cgrow{flex:1 1 auto;}',
'.wb-chead .wb-carrow{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:var(--radius-normal,3px);opacity:.55;cursor:pointer;font-size:14px;}.wb-chead .wb-carrow:hover{opacity:1;background:rgba(127,127,127,.18);}',
'.wb-chead .wb-cx{width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;border-radius:var(--radius-normal,3px);cursor:pointer;opacity:.55;}.wb-chead .wb-cx:hover{background:rgba(127,127,127,.18);opacity:1;}',
'.wb-cfoot{position:absolute;left:0;right:0;bottom:0;height:48px;display:flex;align-items:center;gap:8px;padding:0 10px;background:linear-gradient(rgba(127,127,127,.07),rgba(127,127,127,.07)),var(--wb-cbg,transparent);border-top:1px solid rgba(127,127,127,.18);z-index:6;font-size:13px;}',
'.wb-cbtn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;line-height:1;border-radius:var(--radius-normal,3px);cursor:pointer;border:1px solid rgba(127,127,127,.28);background:var(--ed-button-bg,transparent);color:inherit;font-size:13px;white-space:nowrap;box-sizing:border-box;}',
'.wb-cbtn:hover{filter:brightness(1.18);}',
'.wb-cdest{max-width:60%;overflow:hidden;white-space:nowrap;}.wb-cdest .ti{opacity:.8;}',
'.wb-cind{padding:0 9px;}.wb-cind.wb-on{color:var(--color-primary-500,#4caea1);border-color:var(--color-primary-500,#4caea1);}',
'.wb-cspacer{flex:1 1 auto;}.wb-chint{opacity:.5;font-size:11.5px;margin-right:4px;}',
'.wb-csend{background:var(--ed-button-primary-bg,#3aa37f) !important;border-color:transparent !important;color:#fff !important;font-weight:600;}.wb-csend:hover{filter:brightness(1.1);}',
'.wb-note .wb-nbody{padding:17px 24px 16px 24px;font-weight:var(--font-weight-normal,400);font-family:var(--wb-note-font,inherit);}',
'.wb-note .wb-chead,.wb-note .wb-cfoot{font-family:var(--wb-font);font-weight:400;}',
'.wb-note .wb-nbody .line-div:not([class*="heading-h"]),.wb-note .wb-nbody .line-div:not([class*="heading-h"]) .lineitem-text,.wb-note .wb-nbody .wb-nl{font-weight:inherit;}', // headings keep Thymer's own weight (.heading-hN > span, 700/600); this rule outranked it and rendered every heading light at rest (his recording 2026-09-22),
'.panel.wb-float-editor .listitem.wb-hide,.panel.wb-float-editor .listview-items.wb-hide{display:none !important;}.panel.wb-float-editor .backrefs-footer{display:none !important;}',
'.wb-note .wb-cedit{font-weight:600;}',
'.wb-note.wb-colored{--text-color:var(--wb-note-fg,#1c1c1e);--text-default:var(--wb-note-fg,#1c1c1e);--ed-text-color:var(--wb-note-fg,#1c1c1e);--ed-gray-text:rgba(0,0,0,.5);}',
'.wb-note.wb-colored .wb-snap .line-div,.wb-note.wb-colored .wb-snap .line-div[class*="heading-h"],.wb-note.wb-colored .wb-nl,.panel.wb-float-editor.wb-colored .line-div,.panel.wb-float-editor.wb-colored .line-div[class*="heading-h"]{color:var(--wb-note-fg,#1c1c1e) !important;}',
'.wb-node .wb-txt[contenteditable="true"]{caret-color:currentColor !important;}.wb-node .wb-txt::selection,.wb-node .wb-txt *::selection{background:color-mix(in srgb,var(--wb-accent,#65c8bb) 40%,transparent) !important;color:inherit !important;}',
'.wb-note.wb-resizing{height:var(--wb-rh) !important;}',
'.wb-note.wb-colored,.panel.wb-float-editor.wb-colored{--ed-list-counter-color:var(--wb-note-fg,#1c1c1e);--ed-gray-text:rgba(0,0,0,.5);}',
'.wb-note.wb-colored .listitem-indentline,.panel.wb-float-editor.wb-colored .listitem-indentline{border-left-color:rgba(0,0,0,.28) !important;}',
'.wb-note.wb-colored .line-fold-chevron,.panel.wb-float-editor.wb-colored .line-fold-chevron{color:var(--wb-note-fg,#1c1c1e) !important;}',
'.wb-note.wb-colored .line-chrome-ulist-dot,.panel.wb-float-editor.wb-colored .line-chrome-ulist-dot{background-color:var(--wb-note-fg,#1c1c1e) !important;}',
'.wb-note.wb-colored .line-chrome-olist,.wb-note.wb-colored .line-chrome-olist::before,.panel.wb-float-editor.wb-colored .line-chrome-olist,.panel.wb-float-editor.wb-colored .line-chrome-olist::before{color:var(--wb-note-fg,#1c1c1e) !important;}',
'.wb-note .wb-nbody.wb-snap{padding:0 24px 16px 24px;}.wb-note .wb-snap .editor-panel{padding-top:18px;}.wb-note .wb-snap *{pointer-events:none;}.wb-note .wb-snap .listview-carets,.wb-note .wb-snap .listview-selections,.wb-note .wb-snap .listitem-indentline-ghost{display:none;}',
'.wb-note .wb-chead,.wb-note .wb-cfoot{--wb-cbg:inherit;}',
'.wb-colored .wb-chead,.wb-colored .wb-cfoot{color:var(--wb-note-fg,#1c1c1e);}',
'.wb-colored .wb-cbtn{background:rgba(0,0,0,.06);border-color:rgba(0,0,0,.28);color:var(--wb-note-fg,#1c1c1e);}.wb-colored .wb-cbtn:hover{background:rgba(0,0,0,.12);filter:none;}',
'.wb-colored .wb-cind.wb-on{color:var(--color-primary-700,#2f8873);border-color:var(--color-primary-700,#2f8873);}',
'.wb-colored .wb-chint{opacity:.6;}.wb-colored .wb-chead .wb-ctitle{opacity:.75;}',
'.wb-linepreview{position:fixed;z-index:100004;max-width:440px;box-sizing:border-box;padding:10px 12px;border-radius:var(--radius-normal,3px);pointer-events:none;background:var(--cmdpal-bg-color,var(--wb-surface,#26262b));color:var(--cmdpal-fg-color,var(--text-color,#ddd));border:1px solid var(--wb-line,rgba(127,127,127,.4));box-shadow:0 12px 40px rgba(0,0,0,.5);font-family:var(--font-mono,inherit);font-size:var(--text-size-small,.875rem);line-height:1.5;max-height:60vh;overflow-y:auto;}',
'.wb-lp-text{white-space:pre-wrap;overflow-wrap:anywhere;}.wb-lp-text b{font-weight:var(--font-weight-bold,700);color:var(--color-primary-500,#4caea1);}',
'.wb-lp-ctx{margin-top:8px;padding-top:6px;border-top:1px solid rgba(127,127,127,.2);opacity:.6;font-size:11.5px;}',
'.panel.wb-float-editor.wb-colored{--text-color:var(--wb-note-fg,#1c1c1e);--text-default:var(--wb-note-fg,#1c1c1e);--ed-text-color:var(--wb-note-fg,#1c1c1e);color:var(--wb-note-fg,#1c1c1e);}',
'.panel.wb-float-editor .layout-margin{margin-left:24px !important;margin-right:24px !important;}.wb-float-editor .item-drag-handle,.wb-float-editor .listview-selection-drag-handles{display:none !important;}.panel.wb-float-editor .content-container{max-width:none !important;}',
'body.wb-editor-open .tooltip-element,body.wb-editor-open .pm-tooltip{z-index:100002 !important;}.wb-note.wb-editing-live{height:var(--wb-rh) !important;}',
'body.wb-editor-open .cmdpal--inline{z-index:100002 !important;}body.wb-editor-open .datepicker,body.wb-editor-open .popup{z-index:100002 !important;}',
// The float editor sits at 100000, far above Thymer's own overlays (measured: the command palette is 999, a modal 9998/9999),
// so anything native opened while a card is being edited was drawn BEHIND it and could not be read (his report 2026-09-20).
// The backdrop stays one step under the thing it dims.
'body.wb-editor-open .cmdpal--dialog,body.wb-editor-open .modal-popout-container,body.wb-editor-open .modal-fullscreen-container{z-index:100002 !important;}',
'body.wb-editor-open .modal-background{z-index:100001 !important;}',
'.panel.wb-float-editor.wb-colored .editor-panel,.panel.wb-float-editor.wb-colored .listitem,.panel.wb-float-editor.wb-colored .id--crumb-path{color:var(--wb-note-fg,#1c1c1e) !important;}',
].join('\n');
Object.assign(WbBoard.prototype, {
	isNoteNode(n) { return !!(n && (n.type === 'note' || n.type === 'line')); },
	// --- creation: a new empty block at the end of the board's own page ------------------------------------
	// "Turn into a note card": the node's text becomes a real block on the board's page (a container line with one child
	// per line of text, which is what the card editor expects), and the node itself is replaced by the card.
	// A page card becomes a note card showing that page's whole body, in place (same id, so its lines stay). Nothing is moved or
	// copied: the card is an attached card whose run is always every top-level line of the page (noteRange, n.whole). An empty page
	// gets one empty line to write in.
	refreshNoteCards(guids) {
		for (const n of this.scene.nodes) {
			if (n.type !== 'note' || !n.lines || !guids.has(n.recordGuid) || (this._noteEditor && this._noteEditor.n === n)) continue;
			delete n._snap; delete n.snap; delete n.snapSig; delete n.snapAt; n._rev = (n._rev || 0) + 1; this.renderNode(n);
		}
	},
	// The node for a card showing a page's whole body (see noteRange, n.whole), or null. `at` gives id and geometry.
	async bodyCardNode(guid, at) {
		const rec = await this.plugin.record(guid); if (!rec) { this.plugin.toast('That page is gone.'); return null; }
		if (await this.plugin.isBoardRecord(rec)) { this.plugin.toast('A board page cannot be shown as a note card.'); return null; }
		let items = []; try { items = (await rec.getLineItems()) || []; } catch (e) {}
		let tops = items.filter((x) => this.noteIsTop(x, rec));
		if (!tops.length) { let li = null; try { li = await rec.createLineItem(null, null, 'text', [{ type: 'text', text: '' }], null); } catch (e) {} if (!li) { this.plugin.toast('Could not open the page body.'); return null; } tops = [li]; }
		const guids = tops.map(liGuid).filter(Boolean); if (!guids.length) return null;
		return { id: at.id, type: 'note', x: at.x, y: at.y, w: Math.max(360, at.w || 0), h: Math.max(200, at.h || 0), recordGuid: guid, lines: guids, lineGuid: guids[0], attached: true, whole: true, color: null, minH: 200 };
	},
	async turnIntoBodyCard(n) {
		const card = await this.bodyCardNode(n.recordGuid, n); if (!card || this.destroyed) return;
		this.pushHistory();
		this.scene.nodes = this.scene.nodes.map((x) => (x.id === n.id ? card : x));
		this.selected = new Set([card.id]); this.renderAll(); this.buildCtx(); this.scheduleSave();
	},
	async addBodyCard(guid, wx, wy) {
		const snap = !!(this.scene.settings && this.scene.settings.snap);
		const card = await this.bodyCardNode(guid, { id: wbUid(), x: wbSnap(wx - 180, snap), y: wbSnap(wy - 100, snap), w: 360, h: 200 }); if (!card || this.destroyed) return;
		this.pushHistory(); this.scene.nodes.push(card); this.selected = new Set([card.id]); this.selectedEdge = null; this.setTool('select'); this.renderAll(); this.scheduleSave();
	},
	// A click with the Card tool: a new card, or a card showing the body of a page picked like the Page tool picks one.
	notePick(w, pt) {
		this.plugin.closeMenus();
		const pop = wbEl('div', 'wb-pop wb-spawnpop'); pop.style.width = 'auto'; pop.style.minWidth = '220px'; pop.addEventListener('pointerdown', (e) => e.stopPropagation());
		const row = (icon, label, fn) => { const r = wbEl('div', 'wb-sprow', icon + '<span>' + wbEsc(label) + '</span>'); r.addEventListener('click', (e) => { e.stopPropagation(); this.plugin.closeMenus(); fn(); }); pop.appendChild(r); };
		row(WB_I.note, 'New Note Card', () => { if (this.createNoteAt) this.createNoteAt(w); });
		row(WB_I.card, 'Note Card From Existing Page', () => setTimeout(() => this.openCardPicker(w.x, w.y, pt, (guid) => this.addBodyCard(guid, w.x, w.y)), 0));
		this.host.appendChild(pop); const hr = this.host.getBoundingClientRect();
		pop.style.left = Math.max(hr.left + 8, Math.min(pt.x + 14, hr.right - pop.offsetWidth - 8)) + 'px'; pop.style.top = Math.max(hr.top + 8, Math.min(pt.y - 12, hr.bottom - pop.offsetHeight - 8)) + 'px';
		this.plugin._pop = pop;
		const out = (e) => { if (!pop.contains(e.target)) this.plugin.closeMenus(); }; document.addEventListener('pointerdown', out, true); pop._out = out;
	},
	// ...and back: the card shows the page's properties again. The page is not touched.
	async turnIntoPageCard(n) {
		if (this._noteEditor && this._noteEditor.n === n) await this.noteEditClose();
		this.pushHistory();
		const card = wbNode('card', n.x, n.y, Math.max(200, n.w), 80, { recordGuid: n.recordGuid }); card.id = n.id;
		this.scene.nodes = this.scene.nodes.map((x) => (x.id === n.id ? card : x));
		this.selected = new Set([card.id]); this.renderAll(); this.buildCtx(); this.scheduleSave();
	},
	async turnIntoNote(n) {
		if (!n || this._creatingNote) return; this._creatingNote = true;
		try {
			const rec = this.rec; let items = []; try { items = (await rec.getLineItems()) || []; } catch (e) {}
			const tops = items.filter((li) => !li.parent_guid || li.parent_guid === rec.guid); const last = tops.length ? tops[tops.length - 1] : null;
			let box = null; try { box = await rec.createLineItem(null, last, 'text', [{ type: 'text', text: '' }], null); } catch (e) { console.warn('[Whiteboard] turnIntoNote', e); }
			if (!box) { this.plugin.toast('Could not create the card.'); return; }
			const text = String(n.text || '').replace(/\s+$/, '');
			let prev = null;
			for (const t of (text ? text.split('\n') : [''])) { try { const li = await rec.createLineItem(box, prev, 'text', [{ type: 'text', text: t }], null); if (li) prev = li; } catch (e) {} }
			this.pushHistory();
			const root = this.mmIsTree(n.id) ? this.mmExtractOne(n) : null;
			const w = Math.max(280, Math.round(n.w)), h = Math.max(180, Math.round(n.h));
			const note = wbNode('note', Math.round(n.x), Math.round(n.y), w, h, { recordGuid: rec.guid, lineGuid: box.guid, color: n.color || null, minH: h });
			for (const e of this.scene.edges) { if (e.from === n.id) e.from = note.id; if (e.to === n.id) e.to = note.id; }
			this.scene.nodes = this.scene.nodes.filter((x) => x !== n);
			const el = this.nodeEls.get(n.id); if (el) { el.remove(); this.nodeEls.delete(n.id); }
			this.scene.nodes.push(note);
			if (root) this.mmLayout(root.id);
			this.selected = new Set([note.id]); this.selectedEdge = null; this.renderAll(); this.scheduleSave();
		} finally { this._creatingNote = false; }
	},
	async createNoteAt(w) {
		if (this._creatingNote) return; this._creatingNote = true;
		try {
			const rec = this.rec; let items = []; try { items = (await rec.getLineItems()) || []; } catch (e) {}
			const tops = items.filter((li) => !li.parent_guid || li.parent_guid === rec.guid); const last = tops.length ? tops[tops.length - 1] : null;
			let li = null; try { li = await rec.createLineItem(null, last, 'text', [{ type: 'text', text: '' }], null); } catch (e) { console.warn('[Whiteboard] createLineItem failed', e); }
			if (!li) { this.plugin.toast('Could not create the card.'); return; }
			this.pushHistory();
			const snap = !!(this.scene.settings && this.scene.settings.snap);
			const n = wbNode('note', wbSnap(w.x - 180, snap), wbSnap(w.y - 100, snap), 360, 200, { recordGuid: rec.guid, lineGuid: li.guid, color: null, minH: 200 });
			this.scene.nodes.push(n); this.selected = new Set([n.id]); this.selectedEdge = null; this.setTool('select'); this.renderAll(); this.scheduleSave();
			await wbSleep(150); this.noteEdit(n);
		} finally { this._creatingNote = false; }
	},
	// --- the block behind a card ---------------------------------------------------------------------------
	async noteLine(n) {
		const rec = await this.plugin.record(n.recordGuid); if (!rec) return null;
		let items = []; try { items = (await rec.getLineItems()) || []; } catch (e) {}
		const want = new Set(n.lines && n.lines.length ? n.lines : [n.lineGuid]);
		const find = (list) => { for (const li of list || []) { if (want.has(li.guid)) return li; const k = find(li.children || []); if (k) return k; } return null; };
		return find(items) || items.find((li) => want.has(li.guid)) || null;
	},
	noteSegHtml(li) {
		const segs = li.segments || []; let out = '';
		for (const sg of segs) {
			const obj = sg.text && typeof sg.text === 'object' ? sg.text : null;
			let t = typeof sg.text === 'string' ? sg.text : (obj && (obj.title || obj.text || obj.alias)) || '';
			if ((sg.type === 'ref' || sg.type === 'linkobj') && obj && obj.guid) { const cached = this.plugin._refNames && this.plugin._refNames.get(obj.guid); out += '<span class="wb-nref" data-ref="' + wbEsc(obj.guid) + '">' + wbEsc(t || cached || '…') + '</span>'; continue; }
			if (sg.type === 'ref' || sg.type === 'linkobj' || sg.type === 'mention' || sg.type === 'hashtag') out += '<span class="wb-nref">' + wbEsc(t) + '</span>';
			else if (sg.type === 'bold') out += '<b>' + wbEsc(t) + '</b>'; else if (sg.type === 'italic') out += '<i>' + wbEsc(t) + '</i>'; else if (sg.type === 'code') out += '<code>' + wbEsc(t) + '</code>';
			else out += wbEsc(t);
		}
		return out;
	},
	// Thymer's own row markup (listitem / line-div / list chrome), so Thymer's CSS styles a card that has no saved copy yet
	// `li.children` caches go stale (a grandchild showed up as a child); the tree is built from the record's flat item
	// list by parent guid. `tops` = the rows to show, `items` = every line of the record.
	noteBlockHtml(tops, items) {
		const kidsOf = (g) => items.filter((x) => liRaw(x).pguid === g);
		const rows = (tops || []).map((k, i) => this.noteRowHtml(k, 1, i, tops, kidsOf)).join('');
		return rows || '<div class="listitem listitem-text"><div class="line-div"><span class="lineitem-text wb-nl-empty">Empty card</span></div></div>';
	},
	// The geometry is read out of Thymer's own renderer (2026-09-20), not guessed: the indent is level x 30 px and sits on the
	// row's CHROME (dot, number, checkbox) when it has one, with no margin on the line itself, and on the line only when the
	// row has no chrome. The dot's class counts the bulleted ANCESTORS (cycling through 4), a number is drawn by Thymer's own
	// CSS counter from counter-set, and a checkbox is a sibling in front of the line. The old version put 30 px on both the
	// chrome and the line of every list row, so a card read differently before and after its first edit.
	noteRowHtml(li, depth, idx, siblings, kidsOf, lists) {
		const type = liType(li); const txt = this.noteSegHtml(li); const ml = (depth - 1) * 30; const kids = kidsOf(liGuid(li)); const L = lists || { u: 0, o: 0 };
		const line = (cls, inner, own) => '<div class="line-div' + (cls ? ' ' + cls : '') + '"' + (own ? ' style="margin-left:' + ml + 'px"' : '') + '>' + inner + '</div>';
		const span = '<span class="lineitem-text">' + (txt.trim() ? txt : '&nbsp;') + '</span>';
		let row = '';
		if (type === 'heading') { const h = (li.props && li.props.hsize) || 3; row = '<div class="listitem listitem-heading">' + line('heading-h' + h, span, true) + '</div>'; }
		else if (type === 'ulist') { row = '<div class="listitem listitem-ulist"><div class="line-chrome-ulist ulist-depth-' + (L.u % 4 + 1) + '" style="margin-left:' + ml + 'px"><span class="line-chrome-ulist-dot"></span></div>' + line('', span, false) + '</div>'; }
		else if (type === 'olist') { let num = 1; for (let k = idx - 1; k >= 0 && liType(siblings[k]) === 'olist'; k--) num++; const od = L.o % 4 + 1; row = '<div class="listitem listitem-olist"><div class="line-chrome-olist list-depth-' + od + '" style="margin-left:' + ml + 'px;counter-set:list-depth-' + od + ' ' + num + '"></div>' + line('', span, false) + '</div>'; }
		else if (type === 'task') { const done = !!(li.props && (li.props.done || li.props.status === 'done')); row = '<div class="listitem listitem-task' + (done ? ' state-done' : '') + '"><div class="line-check-div" style="margin-left:' + ml + 'px"></div>' + line('', span, false) + '</div>'; }
		else { row = '<div class="listitem listitem-text">' + line('', span, true) + '</div>'; }
		const next = { u: L.u + (type === 'ulist' ? 1 : 0), o: L.o + (type === 'olist' ? 1 : 0) };
		if (kids.length && depth < 8) row += kids.map((k, i) => this.noteRowHtml(k, depth + 1, i, kids, kidsOf, next)).join('');
		return row;
	},
	// What a card's saved picture was taken OF: every row it shows, in order. A picture is good for as long as this still
	// matches. The record's "updated" stamp cannot say that: a card on the board's own page lives in a record that every
	// save of the board stamps again, so its picture was thrown away on each reopening (measured: 190 s "stale" at rest).
	noteSig(tops, items) {
		const kidsOf = (g) => items.filter((x) => liRaw(x).pguid === g); const parts = [];
		const walk = (li, d) => { const p = li.props || {}; parts.push(d + '|' + liGuid(li) + '|' + liType(li) + '|' + (p.hsize || '') + '|' + (p.done || p.status || '') + '|' + JSON.stringify(li.segments || [])); if (d < 8) for (const k of kidsOf(liGuid(li))) walk(k, d + 1); };
		for (const t of (tops || [])) walk(t, 1);
		let h = 5381; const s = parts.join('\n'); for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
		return parts.length + ':' + (h >>> 0).toString(36);
	},
	noteTops(n, li, got) { if (n.lines) { const range = this.noteRange(n, got.rec, got.items); return range ? range.tops : []; } return got.items.filter((x) => liRaw(x).pguid === liGuid(li)); },

	// a card always reads against the canvas: canvas colour pulled 9 % toward the text colour (grey on black, grey on white)
	noteBg() {
		if (this._noteBg && Date.now() - this._noteBg.t < 3000) return this._noteBg.v;
		let v = 'var(--wb-surface)';
		if (wbIsDarkApp()) { this._noteBg = { v: '#0F0F11', t: Date.now() }; return '#0F0F11'; } // his colour for cards in dark mode
		try { const cs = getComputedStyle(this.canvas); const bg = wbParseRgb(cs.backgroundColor) || wbParseRgb(getComputedStyle(this.host).backgroundColor) || [12, 12, 14]; const fg = wbParseRgb(cs.color) || [200, 200, 200]; v = wbMixRgb(bg, fg, 0.09); } catch (e) {}
		this._noteBg = { v, t: Date.now() }; return v;
	},
	// the resting card uses the editor's own type: measured from any live line, so it follows the theme and its font settings
	noteFont(scope, colored) {
		const key = colored ? 'c' : 'p'; this._noteFonts = this._noteFonts || {};
		const cached = this._noteFonts[key];
		if (!scope && cached && Date.now() - cached.t < 5000) return cached.v;
		if (!scope && !cached) { try { const all = JSON.parse(localStorage.getItem('wb_note_font') || 'null'); const saved = all && (all[key] || (all.size ? all : null)); if (saved && saved.size) { this._noteFonts[key] = { v: saved, t: Date.now() + 3600000 }; return saved; } } catch (e) {} } // what the editor measured last time, so the first render already matches
		const v = { size: '15.2px', lh: '24.32px', itemH: 30, headSize: '14.44px', headLh: '28.88px', headH: 35, headWeight: '300', family: '' };
		try {
			const root = scope || document;
			const text = root.querySelector('.editor-panel .listitem.listitem-text') || root.querySelector('.editor-panel .listitem:not(.listitem-heading)');
			if (text) { const ld = text.querySelector('.line-div') || text; const cs = getComputedStyle(ld); v.size = cs.fontSize; v.lh = cs.lineHeight; v.family = cs.fontFamily; v.itemH = Math.round(text.getBoundingClientRect().height / (scope ? (this.cam.z || 1) : 1) * 10) / 10 || v.itemH; }
			const head = root.querySelector('.editor-panel .listitem.listitem-heading');
			if (head) { const ld = head.querySelector('.line-div') || head; const cs = getComputedStyle(ld); v.headSize = cs.fontSize; v.headLh = cs.lineHeight; v.headWeight = cs.fontWeight; v.headH = Math.round(head.getBoundingClientRect().height / (scope ? (this.cam.z || 1) : 1) * 10) / 10 || v.headH; }
		} catch (e) {}
		if (scope) { try { const all = JSON.parse(localStorage.getItem('wb_note_font') || '{}') || {}; if (all.size) { delete all.size; } all[key] = v; localStorage.setItem('wb_note_font', JSON.stringify(all)); } catch (e) {} }
		this._noteFonts[key] = { v, t: scope ? Date.now() + 3600000 : Date.now() }; return v;
	},
	// Snapshot of the editor's rendered lines for a card: exact Thymer styling in the resting state. Taken from the live
	// editor when it closes, or lazily from a hidden editor (one at a time) for cards that were never opened.
	async noteKidsSet(n) { try { const got = await this.noteItems(n); if (!got) return null; const set = new Set(); for (const x of got.items) { const p = liRaw(x).pguid; if (p) set.add(p); } return set; } catch (e) { return null; } },
	noteSnapshotFromSlot(n, slot, kids) {
		try {
			// a page can render several lists (the Journal puts its task list first): take the one holding the card's visible rows
			const lists = [...slot.querySelectorAll('.listview-items')]; const want = new Set(n.lines && n.lines.length ? n.lines : [n.lineGuid]);
			const items = lists.find((l) => [...l.querySelectorAll('.listitem[data-guid]')].some((r) => want.has(r.dataset.guid))) || lists.find((l) => l.querySelector('.listitem:not(.wb-hide)')) || lists[0]; if (!items) return false;
			if (!items.querySelector('.listitem:not(.wb-hide)')) return false; // never accept an empty snapshot
			const clone = items.cloneNode(true);
			for (const ch of clone.querySelectorAll('.line-fold-chevron')) { const row = ch.closest('.listitem'); const show = row && row.classList.contains('listitem-folded') && kids && kids.has(row.dataset.guid); ch.style.opacity = show ? '0.7' : '0'; }
			for (const junk of clone.querySelectorAll('.wb-hide, .listview-carets, .listview-selections, .caret-usertag, .drag-handle, .listitem-drag-handle, [contenteditable]')) { if (junk.hasAttribute && junk.hasAttribute('contenteditable')) junk.removeAttribute('contenteditable'); else junk.remove(); }
			for (const e of clone.querySelectorAll('*')) { e.classList.remove('listitem-with-caret', 'focused-component', 'is-selected', 'focus'); e.removeAttribute('tabindex'); }
			n._snap = clone.outerHTML; n._snapAt = Date.now(); n.snap = n._snap; n.snapAt = n._snapAt; this.scheduleSave(); return true;
		} catch (e) { return false; }
	},
	async noteEnsureSnapshot(n) {
		return; // 0.4.2: never opens hidden panels (they flashed a panel on every board open); noteBlockHtml mirrors Thymer's markup instead
		if (n._snap || n._snapping || this._noteEditor || this.destroyed) return;
		this._snapQueue = this._snapQueue || []; if (this._snapQueue.includes(n)) return; this._snapQueue.push(n);
		if (this._snapBusy) return; this._snapBusy = true;
		try {
			while (this._snapQueue.length && !this.destroyed) {
				const cur = this._snapQueue.shift(); if (cur._snap || !this.scene.nodes.includes(cur)) continue; if (this._noteEditor) { this._snapQueue.unshift(cur); break; }
				cur._snapping = true;
				try {
					const nv0 = await this.noteNav(cur); if (!nv0) continue;
					const grid = document.querySelector('.panels-grid'); const gridCols = grid ? grid.style.gridTemplateColumns : null;
					const panel = await this.plugin.ui.createPanel(); if (!panel) break;
					let slot = null; for (let i = 0; i < 30 && !slot; i++) { try { const e = panel.getElement(); slot = e && e.closest ? e.closest('.panel') : null; } catch (x) {} if (!slot) await wbSleep(30); }
					if (slot) { slot.classList.add('wb-float-editor'); slot.style.clipPath = 'inset(100%)'; slot.style.position = 'fixed'; slot.style.left = '0px'; slot.style.top = '0px'; slot.style.width = Math.round(cur.w) + 'px'; slot.style.height = '400px'; slot.style.pointerEvents = 'none'; }
					if (grid && gridCols != null) grid.style.gridTemplateColumns = gridCols;
					try { panel.navigateTo(nv0.nav); } catch (x) {}
					for (let i = 0; i < 30; i++) { let nv = null; try { nv = panel.getNavigation(); } catch (x) {} if (slot && slot.querySelector('.listitem') && nv && nv.rootId === nv0.rootId) break; await wbSleep(50); }
					await wbSleep(80);
					if (slot && nv0.range) { for (let i = 0; i < 40; i++) { if ([...slot.querySelectorAll('.listitem[data-guid]')].some((r) => nv0.range.all.has(r.dataset.guid))) break; await wbSleep(75); } this.noteApplyRange(slot, nv0.range, { known: null }); }
					if (slot && slot.querySelector('.listitem') && !this._noteEditor) { this.noteFont(slot, !!cur.color); const kids = await this.noteKidsSet(cur); this.noteSnapshotFromSlot(cur, slot, kids); }
					try { this.plugin.ui.closePanel(panel); } catch (x) {}
					if (grid && gridCols != null) setTimeout(() => { try { grid.style.gridTemplateColumns = gridCols; } catch (x) {} }, 50);
					if (cur._snap) { cur._rev = (cur._rev || 0) + 1; this.renderNode(cur); }
				} catch (e) { console.warn('[Whiteboard] snapshot failed', e); }
				cur._snapping = false;
				await wbSleep(120);
			}
		} finally { this._snapBusy = false; }
	},
	renderNoteNode(n, el) {
		if (!el.classList.contains('wb-note')) { el.classList.add('wb-note'); }
		const c = n.color ? wbStickyColor(n.color) : null; el.style.background = c ? c.hex : this.noteBg(); el.classList.toggle('wb-colored', !!c); el.style.color = c ? (c.fg || '#1c1c1e') : ''; if (c) el.style.setProperty('--wb-note-fg', c.fg || '#1c1c1e'); else el.style.removeProperty('--wb-note-fg');
		const f = this.noteFont(null, !!n.color); el.style.fontSize = f.size; el.style.lineHeight = f.lh; el.style.fontFamily = '';
		if (f.family) el.style.setProperty('--wb-note-font', f.family); else el.style.removeProperty('--wb-note-font');
		el.style.setProperty('--wb-lh', f.lh); el.style.setProperty('--wb-item-h', f.itemH + 'px'); el.style.setProperty('--wb-head-fs', f.headSize); el.style.setProperty('--wb-head-lh', f.headLh); el.style.setProperty('--wb-head-h', f.headH + 'px'); el.style.setProperty('--wb-head-w', f.headWeight);
		this.notePlaceCard(n, el);
		if (this._noteEditor && (!this._noteEditor.el || !this._noteEditor.el.isConnected)) { const dead = this._noteEditor; this._noteEditor = null; for (const f of dead.off) { try { f(); } catch (e) {} } }
		el.classList.toggle('wb-editing-live', !!(this._noteEditor && this._noteEditor.n === n));
		const key = String(n._rev || 0); if (el.dataset.rev === key && el.childElementCount) return; el.dataset.rev = key;
		if (!el.childElementCount) el.innerHTML = '<div class="wb-nl wb-nl-empty">Loading</div>';
		const my = (n._fetchSeq = (n._fetchSeq || 0) + 1);
		(async () => { await this.noteEnsureLines(n); return this.noteLine(n); })().then(async (li) => {
			if (this.destroyed || !el.isConnected || my !== n._fetchSeq) return;
			if (!li) { el.innerHTML = '<div class="wb-nl wb-card-missing">Block not found</div>'; this.measureNote(n, el); return; }
			// the saved copy is good until the record changed after it was taken
			let got = null, tops = []; if (!n._snap) { try { got = await this.noteItems(n); if (got) tops = this.noteTops(n, li, got); } catch (e) { got = null; } }
			// the saved copy is good for as long as the rows it was taken of are unchanged (a copy from before 0.29 has no
			// signature and keeps the old rule: good until the record changed after it was taken)
			if (!n._snap && n.snap && n.snapSig) { if (got && this.noteSig(tops, got.items) === n.snapSig) n._snap = n.snap; else if (got) { delete n.snap; delete n.snapAt; delete n.snapSig; } }
			else if (!n._snap && n.snap) { let upd = 0; try { const rec = this.plugin.recordSync(n.recordGuid) || await this.plugin.record(n.recordGuid); const d = rec && rec.getUpdatedAt && rec.getUpdatedAt(); upd = d ? d.getTime() : 0; } catch (e) {} if (!upd || !n.snapAt || upd <= n.snapAt + 1500) n._snap = n.snap; else { delete n.snap; delete n.snapAt; } }
			let fallback = '';
			if (!n._snap && got) fallback = this.noteBlockHtml(tops, got.items);
			let html = '<div class="wb-nbody wb-snap"><div class="editor-panel"><div class="listview-focus">' + (n._snap || '<div class="listview-items">' + fallback + '</div>') + '</div></div></div>';
			el.innerHTML = html; this.noteCardChrome(n, el); this.measureNote(n, el);
			if (!n._snap) this.noteEnsureSnapshot(n);
			// resolve reference titles (a ref segment only carries the guid)
			const refs = [...el.querySelectorAll('.wb-nref[data-ref]')]; if (refs.length) { this.plugin._refNames = this.plugin._refNames || new Map(); for (const sp of refs) { const g = sp.dataset.ref; const known = this.plugin._refNames.get(g); if (known) { sp.textContent = known; continue; } this.plugin.record(g).then((r) => { const name = (r && r.getName()) || 'Untitled'; this.plugin._refNames.set(g, name); if (sp.isConnected) { sp.textContent = name; this.measureNote(n, el); } }).catch(() => {}); } }
		}).catch(() => {});
	},
	// where the block lives, as text: "This board" or the page's icon + name (cached per record)
	// the header shows the page's name with the icon of the COLLECTION it lives in (his ruling), record icon as fallback
	async noteHome(n) {
		if (n.recordGuid === this.rec.guid) return { name: 'This board', icon: 'ti-layout-board' };
		try {
			const r = await this.plugin.record(n.recordGuid); let icon = '';
			try { const cols = await this.plugin.refreshCols(); const row = wbRow(r); const c = cols.find((x) => x.getGuid && x.getGuid() === (row && row.pguid)); if (c) icon = collIconFromConf(c.getConfiguration()) || ''; } catch (e) {}
			if (!icon) { try { icon = (r && r.getIcon && r.getIcon(true)) || ''; } catch (e) {} }
			return { name: (r && r.getName()) || 'Untitled', icon: icon || 'ti-file' };
		} catch (e) { return { name: 'Untitled', icon: 'ti-file' }; }
	},
	noteCardChrome(n, el) {
		const head = wbEl('div', 'wb-chead', '<span class="wb-ctitle"><span class="ti ti-file"></span><span class="wb-ctitle-lbl">Loading</span></span><span class="wb-carrow" title="Open the page (Cmd+Shift+click: beside)" style="display:none"><span class="ti ti-arrow-up-right"></span></span><span class="wb-cgrow"></span>');
		const foot = wbEl('div', 'wb-cfoot', '<span class="wb-cspacer"></span><span class="wb-cbtn wb-cedit">Edit</span>');
		el.appendChild(head); el.appendChild(foot);
		const arrow = head.querySelector('.wb-carrow'); if (n.recordGuid !== this.rec.guid) { arrow.style.display = ''; arrow.addEventListener('pointerdown', (e) => e.stopPropagation()); arrow.addEventListener('click', (e) => { e.stopPropagation(); this.plugin.openLine(n.recordGuid, n.lineGuid, this.panel, !!(e.metaKey && e.shiftKey)); }); }
		const ed = foot.querySelector('.wb-cedit'); ed.addEventListener('pointerdown', (e) => e.stopPropagation()); ed.addEventListener('click', (e) => { e.stopPropagation(); this.noteEdit(n); });
		this.noteHome(n).then((h) => { if (!el.isConnected) return; const box = el.querySelector('.wb-ctitle'); if (box) { box.querySelector('.ti').className = 'ti ' + h.icon; box.querySelector('.wb-ctitle-lbl').textContent = h.name; } });
	},
	// card geometry: the node carries zoom = 1/z so its content is 1:1 with the screen (and with the unzoomed editor);
	// left/top/width are therefore expressed in world px × z
	notePlaceCard(n, el) {
		el.style.zoom = ''; el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; el.style.width = n.w + 'px';
		const resizing = !!(this.drag && this.drag.kind === 'resize' && this.drag.n === n);
		el.classList.toggle('wb-resizing', resizing); el.style.setProperty('--wb-rh', Math.max(60, n.h) + 'px'); el.style.minHeight = (resizing ? Math.max(60, n.h) : Math.max(n.minH || 200, 0)) + 'px';
	},
	// While the editor floats over it the card's height is FORCED to --wb-rh, so measuring it then would be circular.
	// And when the height does change, --wb-rh has to move with it: it was left at the old value, so opening the editor
	// snapped the card back to that stale height for a moment and the selection frame jumped with it.
	measureNote(n, el) {
		if (el.classList.contains('wb-editing-live')) return;
		if (this.drag && this.drag.kind === 'resize' && this.drag.n === n) return;
		const h = Math.max(n.minH || 200, Math.round(el.offsetHeight));
		if (Math.abs(h - n.h) <= 1) return;
		n.h = h; el.style.setProperty('--wb-rh', Math.max(60, h) + 'px');
		this.invalidateChrome ? this.invalidateChrome() : (this.renderEdges(), this.renderOverlay());
	},
	// --- editing: the REAL editor, floated over the card (Quick Capture's recipe) ------------------------------
	async noteEdit(n) {
		if (!n || !this.isNoteNode(n)) return; if (this._noteEditor) { if (this._noteEditor.n === n) return; await this.noteEditClose(); }
		const ws = this.plugin.getWorkspaceGuid ? this.plugin.getWorkspaceGuid() : (this.panel.getNavigation() || {}).workspaceGuid;
		const grid = document.querySelector('.panels-grid'); const gridCols = grid ? grid.style.gridTemplateColumns : null;
		let panel = null; try { panel = await this.plugin.ui.createPanel(); } catch (e) {}
		if (!panel) { this.plugin.toast('Could not open the editor.'); return; }
		const ed = { n, panel, el: null, gridCols, off: [] }; this._noteEditor = ed;
		let slot = null; for (let i = 0; i < 30 && !slot; i++) { try { const e = panel.getElement(); slot = e && e.closest ? e.closest('.panel') : null; } catch (x) {} if (!slot) await wbSleep(30); }
		if (!slot) { try { this.plugin.ui.closePanel(panel); } catch (x) {} this._noteEditor = null; return; }
		ed.el = slot; slot.classList.add('wb-float-editor'); slot.style.clipPath = 'inset(100%)';
		const slotBg = n.color ? wbStickyColor(n.color).hex : this.noteBg();
		slot.style.backgroundColor = slotBg; slot.style.setProperty('--wb-cbg', slotBg);
		if (n.color) { slot.classList.add('wb-colored'); slot.style.setProperty('--wb-note-fg', wbStickyColor(n.color).fg || '#1c1c1e'); }
		document.body.classList.add('wb-editor-open'); ed.off.push(() => document.body.classList.remove('wb-editor-open'));
		this.notePlaceEditor(); if (grid && gridCols != null) grid.style.gridTemplateColumns = gridCols;
		const nv0 = await this.noteNav(n); if (!nv0 || this._noteEditor !== ed) { if (this._noteEditor === ed) { this.plugin.toast('The block behind this card is gone.'); this.noteEditClose(); } return; }
		const nav = nv0.nav; ed.range = nv0.range; this.noteWatchRange(slot, nv0.range, ed);
		try { panel.navigateTo(nav); } catch (e) { console.warn('[Whiteboard] editor navigate failed', e); }
		let ok = false; for (let i = 0; i < 30; i++) { let nv = null; try { nv = panel.getNavigation(); } catch (e) {} if (slot.querySelector('.listitem') && nv && nv.rootId === nv0.rootId) { ok = true; break; } await wbSleep(50); }
		if (!ok) { try { panel.navigateTo(nav); } catch (e) {} for (let i = 0; i < 20; i++) { if (slot.querySelector('.listitem')) break; await wbSleep(50); } }
		if (this._noteEditor !== ed) return;
		this.noteApplyRange(slot, nv0.range, ed.rangeState);
		if (grid && gridCols != null) grid.style.gridTemplateColumns = gridCols;
		try { if (slot.querySelector('.listitem')) { const ck = n.color ? 'c' : 'p'; const was = JSON.stringify(((this._noteFonts || {})[ck] || {}).v || null); this.noteFont(slot, !!n.color); const now = JSON.stringify(((this._noteFonts || {})[ck] || {}).v || null); if (was !== now) for (const x of this.scene.nodes) if (this.isNoteNode(x) && x !== n && (!!x.color === !!n.color)) { x._rev = (x._rev || 0) + 1; this.renderNode(x); } } } catch (e) {}
		await this.noteSettle(slot); if (this._noteEditor !== ed) return;
		slot.classList.add('wb-caret-hold'); ed.revealed = true; this.notePlaceEditor(); this.renderNode(n);
		this.noteEditorChrome(ed); setTimeout(() => this.noteFixCaret(ed), 300);
		setTimeout(() => { if (ed.el) ed.el.classList.remove('wb-caret-hold'); }, 1400); // safety net if focus never lands
		try { this.plugin.ui.setActivePanel(panel); } catch (e) {}
		this.noteFocusEditor(ed);
		// grow the card (and the editor) as lines are added
		const grow = setInterval(() => { if (this._noteEditor !== ed || !ed.el || !ed.el.isConnected) { clearInterval(grow); return; } try { const items = ed.el.querySelectorAll('.listitem'); if (!items.length) return; const last = items[items.length - 1].getBoundingClientRect(); const top = ed.el.getBoundingClientRect().top; const want = Math.ceil((last.bottom - top) / (this.cam.z || 1) + 40);
			// Never act on a layout that is still moving: this ran from the first tick, read the editor before its rows had
			// settled (blank lines compact 120 ms in), wrote a height ~23 px too tall and the selection frame jumped with it.
			if (!ed.revealed) return;
			if (ed._wantPrev !== want) { ed._wantPrev = want; return; }
			if (want > Math.max(n.h, n.minH || 0) + 4) { n.h = want; n.minH = Math.max(n.minH || 0, 200); this.notePlaceEditor(); this.invalidateChrome(); } } catch (e) {} }, 300); ed.off.push(() => clearInterval(grow));
		if (grid && gridCols != null) { const tick = setInterval(() => { if (this._noteEditor !== ed) { clearInterval(tick); return; } try { if (grid.style.gridTemplateColumns !== gridCols) grid.style.gridTemplateColumns = gridCols; } catch (e) {} }, 250); ed.off.push(() => clearInterval(tick)); }
		const out = (e) => { if (!ed.el || ed.el.contains(e.target)) return; const t = e.target; if (t.closest && (t.closest('.cmdpal--inline') || t.closest('.autocomplete') || t.closest('.datepicker') || t.closest('.popup') || t.closest('.wb-dpop'))) return; this.noteEditClose(); };
		document.addEventListener('pointerdown', out, true); ed.off.push(() => document.removeEventListener('pointerdown', out, true));
		const esc = (e) => { if (e.key === 'Escape' && ed.el && ed.el.contains(e.target)) { e.stopPropagation(); this.noteEditClose(); } }; document.addEventListener('keydown', esc, true); ed.off.push(() => document.removeEventListener('keydown', esc, true));
	},
	// Thymer places its caret on a real pointer sequence (synthetic keyboard focus is ignored): click the end of the last line,
	// retry until the panel reports focus. Runs after the editor is revealed and again if the user re-enters via the pencil.
	noteFocusEditor(ed) {
		let tries = 0;
		const attempt = () => {
			if (this._noteEditor !== ed || !ed.el || !ed.el.isConnected) return;
			const items = [...ed.el.querySelectorAll('.listitem')].filter((it) => !it.classList.contains('wb-hide')); let last = null; for (const it of items) if ((it.textContent || '').trim()) last = it; if (!last) last = items[0] || null;
			if (last) {
				const r = last.getBoundingClientRect(); const x = Math.min(r.right - 6, r.left + Math.max(20, r.width - 12)), y = r.top + Math.min(r.height - 4, 14);
				for (const [type, ctor] of [['pointerdown', PointerEvent], ['mousedown', MouseEvent], ['pointerup', PointerEvent], ['mouseup', MouseEvent], ['click', MouseEvent]]) { try { last.dispatchEvent(new ctor(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type.endsWith('down') ? 1 : 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, view: window })); } catch (e) {} }
			}
			const focused = ed.el.classList.contains('focused-panel') || ed.el.classList.contains('has-focus') || !!ed.el.querySelector('.focused-component');
			if (!focused && ++tries < 8) { setTimeout(attempt, 150); return; }
			// caret is now at the end of the text: let it show (a beat later so the placement has painted)
			setTimeout(() => { if (ed.el) { this.noteFixCaret(ed); ed.el.classList.remove('wb-caret-hold'); } }, 80);
		};
		setTimeout(attempt, 60);
	},
	// Footer like Quick Capture's: where the block lives (click = the destination picker) + the nest-under toggle.
	noteEditorChrome(ed) {
		const n = ed.n; const slot = ed.el; if (!slot) return; for (const old of slot.querySelectorAll('.wb-chead, .wb-cfoot')) old.remove();
		ed.pendingDest = null;
		const head = wbEl('div', 'wb-chead', '<span class="wb-ctitle"><span class="ti ti-file"></span><span class="wb-ctitle-lbl">Loading</span></span><span class="wb-cgrow"></span><span class="wb-cx" title="Close (Esc)"><span class="ti ti-x"></span></span>');
		const x = head.querySelector('.wb-cx'); for (const ev of ['pointerdown', 'mousedown']) x.addEventListener(ev, (e) => e.stopPropagation(), true); x.addEventListener('click', (e) => { e.stopPropagation(); this.noteEditClose(); }, true);
		const foot = wbEl('div', 'wb-cfoot', '<span class="wb-cbtn wb-cdest" title="Where this block lives. Click to choose another page, heading, line or the Journal."><span class="ti ti-file"></span><span class="wb-cdest-lbl">Loading</span></span><span class="wb-cbtn wb-cind" title=""><span class="ti ti-indent-increase"></span></span><span class="wb-cspacer"></span><span class="wb-chint">Esc closes</span><span class="wb-cbtn wb-csend">Send</span>');
		const dest = foot.querySelector('.wb-cdest'), ind = foot.querySelector('.wb-cind'), send = foot.querySelector('.wb-csend'), hint = foot.querySelector('.wb-chint');
		for (const el of [dest, ind, send]) for (const ev of ['pointerdown', 'mousedown']) el.addEventListener(ev, (e) => e.stopPropagation(), true);
		if (this.indentUnder === undefined) { try { this.indentUnder = localStorage.getItem('wb_indent_under') !== '0'; } catch (e) { this.indentUnder = true; } }
		const paintInd = () => { ind.classList.toggle('wb-on', !!this.indentUnder); ind.title = this.indentUnder ? 'Nest under the chosen heading or line (click to place after it instead)' : 'Place after the chosen heading or line (click to nest under it instead)'; }; paintInd();
		ind.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); this.indentUnder = !this.indentUnder; try { localStorage.setItem('wb_indent_under', this.indentUnder ? '1' : '0'); } catch (x) {} paintInd(); }, true);
		dest.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); this.noteAttachPicker(dest, n, { above: true }); }, true);
		const paintAction = () => { send.textContent = ed.pendingDest ? 'Send' : 'Done'; send.title = ed.pendingDest ? 'Send the block to the page you picked' : 'Close the editor'; }; ed.paintAction = paintAction; paintAction();
		send.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); if (ed.pendingDest) { this.applyDest(ed.pendingDest); return; } this.noteEditClose(); }, true);
		const paintLoc = async () => { const h = await this.noteHome(n); if (!head.isConnected) return; head.querySelector('.ti').className = 'ti ' + h.icon; head.querySelector('.wb-ctitle-lbl').textContent = h.name; if (!ed.pendingDest) { dest.querySelector('.ti').className = 'ti ' + h.icon; dest.querySelector('.wb-cdest-lbl').textContent = h.name; } };
		ed.paintLoc = paintLoc;
		// Quick Capture's mechanism: a pick only SETS the destination; Send moves the block
		ed.setDest = (d) => { ed.pendingDest = d; if (!d) { paintAction(); paintLoc(); return; } let label = '', icon = 'ti-file'; if (d.kind === 'journal') { label = d.dateLabel ? 'Journal · ' + d.dateLabel : "Today's Journal"; icon = 'ti-calendar-event'; } else if (d.kind === 'newnote') { label = d.name + ' (new page)'; icon = 'ti-file-plus'; } else if (d.kind === 'line') { label = d.name; icon = d.icon || 'ti-align-left'; } else { label = d.afterHeadingGuid ? d.name + ' › ' + (d.headingText || 'heading') : d.atTop ? d.name + ' › Top' : d.name; icon = d.icon || 'ti-file'; } dest.querySelector('.ti').className = 'ti ' + icon; dest.querySelector('.wb-cdest-lbl').textContent = label; paintAction(); };
		slot.appendChild(head); slot.appendChild(foot); paintLoc();
	},

	notePlaceEditor() {
		// CSS zoom = camera scale: the editor's type is then exactly the resting card's, and no size jump. With zoom, every
		// length (left/top/width/height) is expressed in unzoomed units, so screen coordinates are divided by the zoom.
		const ed = this._noteEditor; if (!ed || !ed.el) return; const n = ed.n; const z = this.cam.z || 1; const p = this.toScreen(n.x, n.y); const r = this.canvas.getBoundingClientRect();
		const hWorld = Math.max(n.h, n.minH || 200);
		ed.el.style.transform = ''; ed.el.style.zoom = String(z); ed.z = z;
		// with CSS zoom every length of the element is in unzoomed units: screen coordinates are divided by z
		const left = r.left + p.x, top = r.top + p.y, w = n.w * z, h = hWorld * z;
		ed.el.style.left = (left / z) + 'px'; ed.el.style.top = (top / z) + 'px'; ed.el.style.width = n.w + 'px'; ed.el.style.height = (h / z) + 'px';
		// never paint outside the board's own viewport (it is position:fixed, so the panel does not clip it); clip is in unzoomed units too
		const hr0 = this.host.getBoundingClientRect(); const pnl = this.host.closest('.panel'); const sb = document.querySelector('.statusbar--status-bar');
		const hr = { left: hr0.left, right: hr0.right, top: hr0.top, bottom: Math.min(hr0.bottom, pnl ? pnl.getBoundingClientRect().bottom : Infinity, sb ? sb.getBoundingClientRect().top : Infinity) };
		const ci = Math.max(0, hr.top - top) / z, cr = Math.max(0, (left + w) - hr.right) / z, cb = Math.max(0, (top + h) - hr.bottom) / z, cl = Math.max(0, hr.left - left) / z;
		if (ed.revealed) ed.el.style.clipPath = (ci || cr || cb || cl) ? 'inset(' + ci + 'px ' + cr + 'px ' + cb + 'px ' + cl + 'px)' : 'none';
		const hd = ed.el.querySelector('.wb-chead'), ft = ed.el.querySelector('.wb-cfoot');
		if (hd) hd.style.top = ci + 'px';
		if (ft) ft.style.bottom = cb + 'px';
		this.noteFixCaret(ed);
	},
	// Thymer positions .listview-caret and the selection boxes from getBoundingClientRect deltas (screen px) and writes them
	// as local px; inside our zoomed editor that is z× too large (verified 2026-09-05: caret at 116,169 for text end 83,138
	// at z=1.5). Rewrite those boxes ÷ z whenever Thymer sets them.
	noteFixCaret(ed) {
		if (!ed || !ed.el) return;
		// Measured 2026-09-05 (z 1 vs 1.22): Thymer's raw left/top/width/height AND translate(x, y) all scale by exactly z.
		const WB_FIX_SEL = '.listview-caret, .text-selection, .listitem-indentline, .listview-selection-drag-handles > *, .item-drag-handle, .line-fold-chevron';
		const propsFor = (el) => el.classList.contains('listitem-indentline') ? ['top', 'height'] : ['left', 'top', 'width', 'height']; // the indent line's left is a constant
		const fix = (el) => {
			const z = ed.z || 1; // read live: the user may zoom while editing, and Thymer re-renders these at the new scale
			if (!el || !el.style) return; const raw = el.getAttribute('style') || ''; if (raw === el.dataset.wbFixed) return;
			let changed = false; for (const k of propsFor(el)) { const v = parseFloat(el.style[k]); if (!isNaN(v) && v !== 0) { el.style[k] = (v / z) + 'px'; changed = true; } }
			const tr = el.style.transform; const mt = tr && tr.match(/translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/);
			if (mt) { el.style.transform = tr.replace(mt[0], 'translate(' + (parseFloat(mt[1]) / z) + 'px, ' + (parseFloat(mt[2]) / z) + 'px)'); changed = true; }
			// the fold chevron's top = f(row height in SCREEN px) - local constants (measured: 5.89 at z 1, 9.78 at z 1.22 for a 35 px row)
			const ct = el.style.getPropertyValue('--line-fold-chevron-top-px'); if (ct && el.classList.contains('line-fold-chevron')) { const ld = el.parentElement && el.parentElement.querySelector(':scope > .line-div'); if (ld) { const excess = (ld.getBoundingClientRect().height - ld.offsetHeight) / 2; if (Math.abs(excess) > 0.05) { el.style.setProperty('--line-fold-chevron-top-px', (parseFloat(ct) - excess) + 'px'); changed = true; } } }
			if (changed) el.dataset.wbFixed = el.getAttribute('style') || '';
		};
		const isBox = (el) => { try { return !!(el && el.matches && el.matches(WB_FIX_SEL)); } catch (e) { return false; } };
		for (const c of ed.el.querySelectorAll(WB_FIX_SEL)) fix(c);
		this.noteGrow(ed);
		if (ed.caretMo) return;
		// Thymer swaps the caret/selection layers on focus, so observe the whole editor slot, not the layers themselves
		ed.caretMo = new MutationObserver((muts) => { if ((ed.z || 1) === 1) return; for (const mu of muts) { if (mu.type === 'attributes') { if (isBox(mu.target)) fix(mu.target); } else if (mu.type === 'childList') { for (const nd of mu.addedNodes) { if (nd.nodeType !== 1) continue; if (isBox(nd)) fix(nd); else if (nd.querySelectorAll) for (const c of nd.querySelectorAll(WB_FIX_SEL)) fix(c); } } } });
		ed.caretMo.observe(ed.el, { attributes: true, attributeFilter: ['style'], childList: true, subtree: true });
		ed.growMo = new MutationObserver(() => { if (ed._growing || !ed.revealed) return; clearTimeout(ed._growT); ed._growT = setTimeout(() => { ed._growT = null; if (this._noteEditor !== ed) return; ed._growing = true; try { this.noteGrow(ed); } finally { ed._growing = false; } }, 160); }); // 160 ms of quiet: longer than the 120 ms another plugin takes to compact blank lines
		ed.growMo.observe(ed.el, { childList: true, subtree: true, characterData: true });
		ed.off.push(() => { try { ed.growMo.disconnect(); } catch (e) {} clearTimeout(ed._growT); ed.growMo = null; });
		ed.off.push(() => { try { ed.caretMo.disconnect(); } catch (e) {} ed.caretMo = null; });
	},
	// the card follows its text while typing: rows' bottom + footer, never below the user's minimum height
	noteGrow(ed) {
		if (!ed || !ed.el || this._noteEditor !== ed || !ed.revealed) return; const n = ed.n; const z = ed.z || 1;
		const items = ed.el.querySelector('.listview-items'); if (!items || !items.offsetHeight) return;
		// Thymer scrolls its panel to keep the caret in view; measure the rows' top as if unscrolled, or the card shrinks
		// while the content scrolls away (the feedback loop of 2026-09-05 18:30).
		const sc = items.closest('.panel-scroller-y') || ed.el.querySelector('.panel-scroller-y'); const scrollTop = sc ? sc.scrollTop : 0;
		const top = (items.getBoundingClientRect().top - ed.el.getBoundingClientRect().top) / z + scrollTop;
		const needed = Math.ceil(top + items.offsetHeight + 48 + 18); const maxH = Math.floor((window.innerHeight * 0.8) / z);
		const target = Math.min(maxH, Math.max(n.minH || 200, needed));
		if (Math.abs(target - n.h) >= 6) { n.h = target; this.notePlaceEditor(); const el = this.nodeEls.get(n.id); if (el) this.notePlaceCard(n, el); this.renderOverlay(); this.scheduleSave(); }
		if (sc && sc.scrollTop && target >= needed) sc.scrollTop = 0; // everything fits: show it from the top
	},
	// Waits until the editor's rows have stopped changing height: two equal readings 40 ms apart, capped at ~half a second.
	// It is deliberately generic, it does not know which plugin is still working on the rows.
	async noteSettle(slot, tries) {
		const h = () => { const l = slot.querySelector('.listview-items'); return l ? Math.round(l.getBoundingClientRect().height) : 0; };
		let last = -1, same = 0;
		for (let i = 0; i < (tries || 12); i++) {
			await wbSleep(40); const now = h();
			if (now && now === last) { if (++same >= 2) return true; } else { same = 0; last = now; }
		}
		return false;
	},
	async noteEditClose() {
		const ed = this._noteEditor; if (!ed) return; this._noteEditor = null;
		let took = false; try { if (ed.el && ed.el.isConnected) { const kids = await this.noteKidsSet(ed.n); if (ed.el.isConnected) took = this.noteSnapshotFromSlot(ed.n, ed.el, kids); } } catch (e) {}
		try { if (ed.el) { ed.el.style.clipPath = 'inset(100%)'; ed.el.style.visibility = 'hidden'; ed.el.style.pointerEvents = 'none'; for (const c of ed.el.querySelectorAll('.wb-chead, .wb-cfoot')) c.remove(); } } catch (e) {}
		for (const f of ed.off) { try { f(); } catch (e) {} }
		try { this.plugin.ui.closePanel(ed.panel); } catch (e) {}
		const grid = document.querySelector('.panels-grid'); if (grid && ed.gridCols != null) setTimeout(() => { try { grid.style.gridTemplateColumns = ed.gridCols; } catch (e) {} }, 50);
		try { this.plugin.refetch && await this.plugin.refetch(ed.n.recordGuid); } catch (e) {}
		try { if (ed.range) await this.noteRefreshLines(ed.n, ed.range, ed.rangeState); } catch (e) {}
		try { if (!took) delete ed.n.snapSig; else { const li = await this.noteLine(ed.n); const got = li ? await this.noteItems(ed.n) : null; if (got) { ed.n.snapSig = this.noteSig(this.noteTops(ed.n, li, got), got.items); this.scheduleSave(); } else delete ed.n.snapSig; } } catch (e) {}
		ed.n._rev = (ed.n._rev || 0) + 1; this.renderNode(ed.n); this.host.focus({ preventScroll: true });
	},
	// --- attached cards are a RUN of sibling lines on their page --------------------------------------------------
	// On the board a card is a hidden container line whose children are the text (Thymer's line zoom never shows the
	// root itself). Moved to a page, the CHILDREN go in flat, in order (or under the chosen line in indent mode) and the
	// container is deleted, so nothing lands indented. n.lines = the top-level guids of that run; n.lineGuid = its first.
	noteIsTop(li, rec) { const p = liRaw(li).pguid; return !p || p === rec.guid || p === rowGuid(rec); },
	noteText(li) { return (li.segments || []).map((sg) => typeof sg.text === 'string' ? sg.text : (sg.text && sg.text.title) || '').join('').trim(); },
	async noteItems(n) { const rec = await this.plugin.record(n.recordGuid); if (!rec) return null; let items = []; try { items = (await rec.getLineItems()) || []; } catch (e) {} return { rec, items }; },
	// a card attached before 0.2.50 still sits in its container on the page: hoist the children flat, drop the container
	async noteEnsureLines(n) {
		if ((n.recordGuid === this.rec.guid && !n.lines) || n.lines) return;
		if (n._linesBusy) { await n._linesBusy; return; }
		n._linesBusy = (async () => {
			const got = await this.noteItems(n); if (!got) return; const { rec, items } = got;
			const li = items.find((x) => liGuid(x) === n.lineGuid); if (!li) return;
			const kids = items.filter((x) => liRaw(x).pguid === n.lineGuid);
			if (kids.length && !this.noteText(li)) {
				const parent = this.noteIsTop(li, rec) ? rec : (items.find((x) => liGuid(x) === liRaw(li).pguid) || rec);
				let anchor = li; const guids = [];
				for (const k of kids) { let m = null; try { m = await k.move(parent, anchor); } catch (e) {} if (!m) { console.warn('[Whiteboard] could not hoist a line out of its container'); return; } anchor = m; guids.push(liGuid(m) || liGuid(k)); }
				try { await li.delete(); } catch (e) {}
				n.lines = guids; n.lineGuid = guids[0]; n._snap = null; this.scheduleSave();
			} else { n.lines = [n.lineGuid]; this.scheduleSave(); }
		})();
		try { await n._linesBusy; } finally { n._linesBusy = null; }
	},
	// the run: siblings from the first surviving line of n.lines to the last, plus descendants; `pre` = everything before it
	// under the same parent (to hide), `stop` = the sibling right after it (to hide from), rootId = what the editor zooms into
	noteRange(n, rec, items) {
		const byGuid = new Map(items.map((x) => [liGuid(x), x]));
		// a whole-page card (n.whole) is every top-level line of its page, read fresh each time, so lines written on the page
		// elsewhere (before or after what was there) show on the card too
		const mine = n.whole ? items.filter((x) => this.noteIsTop(x, rec)) : (n.lines && n.lines.length ? n.lines : [n.lineGuid]).map((g) => byGuid.get(g)).filter(Boolean);
		if (!mine.length) return null;
		const pg = liRaw(mine[0]).pguid; const top = this.noteIsTop(mine[0], rec);
		const sibs = items.filter((x) => top ? this.noteIsTop(x, rec) : liRaw(x).pguid === pg);
		let a = Infinity, b = -1; for (const m of mine) { const i = sibs.indexOf(m); if (i < 0) continue; a = Math.min(a, i); b = Math.max(b, i); }
		if (b < 0) return null;
		const closure = (seed) => { const set = new Set(seed.map(liGuid)); let grew = true; while (grew) { grew = false; for (const x of items) { const p = liRaw(x).pguid; if (p && set.has(p) && !set.has(liGuid(x))) { set.add(liGuid(x)); grew = true; } } } return set; };
		const tops = sibs.slice(a, b + 1);
		return { rootId: top ? (rowGuid(rec) || rec.guid) : pg, top, tops, all: closure(tops), pre: closure(sibs.slice(0, a)), stop: sibs[b + 1] ? liGuid(sibs[b + 1]) : null, parent: top ? rec : (byGuid.get(pg) || rec) };
	},
	async noteNav(n) {
		const ws = this.plugin.getWorkspaceGuid ? this.plugin.getWorkspaceGuid() : (this.panel.getNavigation() || {}).workspaceGuid;
		if (n.recordGuid === this.rec.guid && !n.lines) return { rootId: n.lineGuid, range: null, nav: { type: 'edit_panel', rootId: n.lineGuid, subId: null, workspaceGuid: ws, state: { positions: [n.lineGuid, 'empty-' + n.lineGuid, 0, 'L'] } } };
		await this.noteEnsureLines(n); const got = await this.noteItems(n); if (!got) return null; const range = this.noteRange(n, got.rec, got.items); if (!range) return null;
		const first = liGuid(range.tops[0]);
		return { rootId: range.rootId, range, nav: { type: 'edit_panel', rootId: range.rootId, subId: null, workspaceGuid: ws, state: { positions: [first, 'empty-' + range.rootId, 0, 'L'] } } };
	},
	// Rows to show in the editor / snapshot: the run's own rows (`range.all`) plus rows that did not exist when the editor
	// opened and sit inside the run (after its first row, before the `stop` sibling): lines the user types. Everything
	// else is hidden, including foreign rows a page renders (the Journal lists 50+ task rows from other pages).
	noteApplyRange(slot, range, state) {
		if (!range) return;
		// The Journal (and any page with view plugins) renders extra .listview-items with rows of OTHER records, before or
		// after its own lines, lazily. Only the list holding the run is ours; the rest is hidden as a whole.
		const lists = [...slot.querySelectorAll('.listview-items')];
		const own = lists.find((l) => [...l.querySelectorAll('.listitem[data-guid]')].some((r) => range.all.has(r.dataset.guid)));
		for (const l of lists) l.classList.toggle('wb-hide', !!own && l !== own && !l.contains(own) && !own.contains(l));
		const rows = [...(own || slot).querySelectorAll('.listitem[data-guid]')];
		if (own) for (const r of slot.querySelectorAll('.listitem[data-guid]')) if (!own.contains(r)) r.classList.add('wb-hide');
		const firstIdx = rows.findIndex((r) => range.all.has(r.dataset.guid));
		let stopIdx = Infinity; if (range.stop) { const i = rows.findIndex((r) => r.dataset.guid === range.stop); if (i >= 0) stopIdx = i; }
		const known = state && state.known;
		rows.forEach((r, i) => { const g = r.dataset.guid; const vis = range.all.has(g) || (known && !known.has(g) && firstIdx >= 0 && i > firstIdx && i < stopIdx); r.classList.toggle('wb-hide', !vis); });
		if (state && !state.known && firstIdx >= 0) state.known = new Set(rows.map((r) => r.dataset.guid));
	},
	noteWatchRange(slot, range, ed) {
		if (!range) return null; const state = { known: null }; if (ed) ed.rangeState = state; this.noteApplyRange(slot, range, state);
		const mo = new MutationObserver(() => { if (mo._t) return; mo._t = requestAnimationFrame(() => { mo._t = null; this.noteApplyRange(slot, range, state); }); });
		mo.observe(slot, { childList: true, subtree: true }); if (ed) ed.off.push(() => mo.disconnect()); return mo;
	},
	// after editing: the run = its surviving lines plus new siblings typed inside it, up to the first old foreign sibling
	async noteRefreshLines(n, range0, state) {
		if (!n.lines || !range0) return; const got = await this.noteItems(n); if (!got) return; const { rec, items } = got;
		const sibs = items.filter((x) => range0.top ? this.noteIsTop(x, rec) : liRaw(x).pguid === range0.rootId);
		const mine = new Set(range0.tops.map(liGuid)); const known = state && state.known;
		const first = sibs.findIndex((x) => mine.has(liGuid(x))); if (first < 0) return;
		const tops = []; for (let i = first; i < sibs.length; i++) { const g = liGuid(sibs[i]); if (mine.has(g) || (known && !known.has(g))) tops.push(g); else break; }
		if (!tops.length) return; if (tops.join() !== (n.lines || []).join()) { n.lines = tops; n.lineGuid = tops[0]; this.scheduleSave(); }
	},
	// move the card's lines to (parentTarget, after anchor), in order; returns the new run or null
	async noteMoveLines(n, parentTarget, anchor) {
		let lines = [], container = null;
		if (n.recordGuid === this.rec.guid && !n.lines) {
			const li = await this.noteLine(n); if (!li) return null;
			let items = []; try { items = (await this.rec.getLineItems()) || []; } catch (e) {}
			const kids = items.filter((x) => liRaw(x).pguid === liGuid(li)); if (kids.length) { lines = kids; container = li; } else lines = [li];
		} else {
			await this.noteEnsureLines(n); const got = await this.noteItems(n); if (!got) return null; const range = this.noteRange(n, got.rec, got.items); if (!range) return null; lines = range.tops;
		}
		const guids = [];
		for (const li of lines) { let m = null; try { m = await li.move(parentTarget, anchor); } catch (e) { console.warn('[Whiteboard] move failed', e); } if (!m) break; anchor = m; guids.push(liGuid(m) || liGuid(li)); }
		if (!guids.length) return null;
		if (container && guids.length === lines.length) { try { await container.delete(); } catch (e) {} }
		n.lines = guids; n.lineGuid = guids[0]; n._snap = null; return guids;
	},
	// Make page: a new page in `col`, titled by the first line; every line moves into it; the card becomes a page card
	async notePromoteToPage(n, col) {
		if (this._noteEditor && this._noteEditor.n === n) await this.noteEditClose();
		let lines = [];
		if (n.recordGuid === this.rec.guid && !n.lines) { const li = await this.noteLine(n); if (!li) { this.plugin.toast('The block behind this card is gone.'); return; } let items = []; try { items = (await this.rec.getLineItems()) || []; } catch (e) {} lines = items.filter((x) => liRaw(x).pguid === liGuid(li)); if (!lines.length) lines = [li]; }
		else { await this.noteEnsureLines(n); const got = await this.noteItems(n); const range = got && this.noteRange(n, got.rec, got.items); if (!range) { this.plugin.toast('The block behind this card is gone.'); return; } lines = range.tops; }
		const title = this.noteText(lines[0]).split('\n')[0].slice(0, 120) || 'Untitled';
		const guid = await this.plugin.createPage(title, col); if (!guid) return;
		const rec = await wbRecordPoll(this.plugin, guid, 30); if (!rec) { this.plugin.toast('The new page did not show up in time.'); return; }
		const moved = await this.noteMoveLines(n, rec, null); if (!moved) { this.plugin.toast('Could not move the text into the new page.'); return; }
		// the first line is now the title: drop it unless it has children of its own
		try { const items = (await rec.getLineItems()) || []; const first = items.find((x) => liGuid(x) === moved[0]); if (first && !items.some((x) => liRaw(x).pguid === moved[0])) await first.delete(); } catch (e) {}
		this.pushHistory();
		const card = wbNode('card', n.x, n.y, Math.max(200, n.w), 80, { recordGuid: guid });
		this.scene.nodes = this.scene.nodes.map((x) => (x.id === n.id ? card : x));
		for (const e of this.scene.edges) { if (e.from === n.id) e.from = card.id; if (e.to === n.id) e.to = card.id; }
		const el = this.nodeEls.get(n.id); if (el) { el.remove(); this.nodeEls.delete(n.id); }
		this.selected = new Set([card.id]); this.renderAll(); this.scheduleSave(); this.buildCtx();
		this.plugin.toast('Made a page in ' + (col ? col.getName() : 'the collection') + '.');
	},
	// --- attach: MOVE the block to the end of a page (refs, dates and tags travel with it) ---------------------
	async noteAttach(n, destGuid) {
		const li = await this.noteLine(n); if (!li) { this.plugin.toast('The block behind this card is gone.'); return false; }
		const dest = await this.plugin.record(destGuid); if (!dest) return false;
		let items = []; try { items = (await dest.getLineItems()) || []; } catch (e) {}
		const tops = items.filter((x) => !x.parent_guid || x.parent_guid === dest.guid); const last = tops.length ? tops[tops.length - 1] : null;
		const ok = await this.noteMoveLines(n, dest, last);
		if (!ok) { this.plugin.toast('Could not move the block to that page.'); return false; }
		this.pushHistory(); n.recordGuid = destGuid; n.attached = true; n._rev = (n._rev || 0) + 1; this.renderNode(n); this.buildCtx(); this.scheduleSave();
		this.plugin.toast('Card attached to ' + (dest.getName() || 'the page') + '.'); return true;
	},

});
{
	const baseRenderNode = WbBoard.prototype.renderNode;
	WbBoard.prototype.renderNode = function (n) {
		if (n.type !== 'note' && n.type !== 'line') return baseRenderNode.call(this, n);
		let el = this.nodeEls.get(n.id);
		if (el && ((el.dataset.wbType && el.dataset.wbType !== n.type) || (el.childElementCount && !el.classList.contains('wb-note')))) { el.remove(); this.nodeEls.delete(n.id); el = null; }
		if (!el) { el = wbEl('div', 'wb-node'); el.dataset.id = n.id; el.dataset.wbType = n.type; this.nodes.appendChild(el); this.nodeEls.set(n.id, el); }
		if (!this._noteRO && window.ResizeObserver) { this._noteRO = new ResizeObserver((ents) => { if (this.destroyed) return; for (const q of ents) { const id = q.target.dataset.id; const nn = id && this.nodeById(id); if (nn && this.isNoteNode(nn)) this.measureNote(nn, q.target); } }); this.disposers.push(() => { try { this._noteRO.disconnect(); } catch (e) {} }); }
		if (this._noteRO && !el._wbObserved) { el._wbObserved = 1; try { this._noteRO.observe(el); } catch (e) {} }
		this.renderNoteNode(n, el);
	};
	const baseBeginEdit = WbBoard.prototype.beginEdit;
	WbBoard.prototype.beginEdit = function (id) { const n = this.nodeById(id); if (n && this.isNoteNode(n)) { this.noteEdit(n); return; } return baseBeginEdit.call(this, id); };
	const baseOnDbl = WbBoard.prototype.onDbl;
	WbBoard.prototype.onDbl = function (e) { let hit = this.hitNode(e); if (!hit && this.hitAt) { try { hit = this.hitAt(e); } catch (x) {} } if (hit && this.isNoteNode(hit)) { this.noteEdit(hit); return; } return baseOnDbl.call(this, e); };
	const baseApplyCamera = WbBoard.prototype.applyCamera;
	WbBoard.prototype.applyCamera = function () { baseApplyCamera.call(this); for (const n of this.scene.nodes) if (this.isNoteNode(n)) { const el = this.nodeEls.get(n.id); if (el) this.notePlaceCard(n, el); } if (this._noteEditor) this.notePlaceEditor(); };
	const baseRenderNodesFast = WbBoard.prototype.renderNodesFast;
	WbBoard.prototype.renderNodesFast = function (items) { baseRenderNodesFast.call(this, items); for (const n of items) if (this.isNoteNode(n)) { const el = this.nodeEls.get(n.id); if (el) this.notePlaceCard(n, el); } };
	const baseRenderOverlay = WbBoard.prototype.renderOverlay;
	WbBoard.prototype.renderOverlay = function () { baseRenderOverlay.call(this); if (this._noteEditor) this.notePlaceEditor(); };
	const baseDestroy = WbBoard.prototype.destroy;
	WbBoard.prototype.destroy = function () { try { if (this._noteEditor) this.noteEditClose(); } catch (e) {} return baseDestroy.call(this); };
	const baseOnUpNote = WbBoard.prototype.onUp;
	WbBoard.prototype.onUp = function (e, cancelled) { const d = this.drag; const rn = d && d.kind === 'resize' && d.n && this.isNoteNode(d.n) ? d.n : null; const r = baseOnUpNote.call(this, e, cancelled); if (rn && !cancelled) { rn.minH = Math.max(60, Math.round(rn.h)); rn._rev = (rn._rev || 0) + 1; this.renderNode(rn); } return r; };
	// deleting a board-local card deletes its block too (it lived only here); an attached card just leaves the board
	const baseDelete = WbBoard.prototype.deleteSelection;
	WbBoard.prototype.deleteSelection = function () {
		const local = [...this.selected].map((id) => this.nodeById(id)).filter((n) => n && n.type === 'note' && n.recordGuid === this.rec.guid && !n.lines && !n.whole); // only a card's own block on the board page; a card showing a page's lines never deletes them
		baseDelete.call(this);
		if (this.isCollectionBoard()) setTimeout(() => this.syncCollection(), 50);
		for (const n of local) this.noteLine(n).then((li) => { if (li && li.delete) li.delete(); }).catch(() => {});
	};
	const baseBuildCtx = WbBoard.prototype.buildCtx;
	WbBoard.prototype.buildCtx = function () {
		baseBuildCtx.call(this); if (!this.ctx) return;
		const sel = [...this.selected].map((id) => this.nodeById(id)).filter(Boolean); if (!sel.length || !sel.every((n) => this.isNoteNode(n))) return;
		const del = [...this.ctx.querySelectorAll('.wb-tb')].find((x) => x.title === 'Delete'); const ins = (el) => this.ctx.insertBefore(el, del || null);
		const one = sel.length === 1 ? sel[0] : null;
		ins(this.tb(WB_I.edit || WB_SVG('<path d="M4 20h4l10-10-4-4L4 16z"></path>') , 'Edit (Enter)', () => one && this.noteEdit(one)));
		const col = sel[0].color ? wbStickyColor(sel[0].color).hex : 'transparent';
		ins(this.tb('<span class="wb-cdot" style="background:' + col + ';border:1px dashed var(--wb-muted)"></span>', 'Card color', (b) => this.colorPop(b, sel[0].color || null, (id) => { this.pushHistory(); for (const n of sel) { n.color = id || null; n._rev = (n._rev || 0) + 1; } this.renderAll(); this.scheduleSave(); }, { auto: 'No color' })));
		if (one && one.recordGuid !== this.rec.guid) ins(this.tb(WB_I.open + '<span>Open page</span>', 'Open the page this block lives in, beside', () => this.plugin.openLine(one.recordGuid, one.lineGuid, this.panel, true)));
		ins(this.sep());
	};
	const basePluginOnLoad = Plugin.prototype.onLoad;
	Plugin.prototype.onLoad = function () { basePluginOnLoad.call(this); this.ui.injectCSS(WB_NOTE_CSS); wbInjectLightCardTheme(); };
}


// ===========================================================================
// Attach a card to a page: Quick Capture's destination picker (his ruling 2026-09-05: take the shared component, do not
// rebuild). Pure helpers come from shared/destination-picker.js via tools/sync-picker.mjs (region below); the UI and
// what a pick DOES live here, with wb- classes. A pick MOVES the card's block: page top/bottom, under/after a heading,
// nested under / after a line, or today's Journal.
// ===========================================================================
// <<<SHARED destination-picker — GENERATED, DO NOT EDIT HERE.
// Source: shared/destination-picker.js  |  regenerate: node tools/sync-picker.mjs
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
const WB_DEST_PLACEHOLDER = 'Search pages, lines, or a date for the Journal (e.g. "tomorrow")';
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function rowGuid(o) { try { return o && o._getRow ? o._getRow().guid : null; } catch (e) { return null; } }
// A collection's icon comes from its CONFIGURATION (`icon`); PluginCollectionAPI
// has no getIcon(). Thymer also stores a few non-font "fill" icons (blinking-dot)
// that it renders as CSS rather than a glyph — those would come out blank, so
// only pass through real `ti-` classes and let the caller fall back.
function collIconFromConf(conf) {
	const ic = conf && conf.icon;
	if (!ic || typeof ic !== 'string') return '';
	return ic.startsWith('ti-') ? ic : '';
}
// Line items: the runtime accessors (getType/getParent/getHeadingSize) are
// unreliable — read the raw row. Top-level when pguid === record guid.
function liRaw(li) { try { return (li && li._getItem) ? (li._getItem() || {}) : {}; } catch (e) { return {}; } }
function liGuid(li) { return liRaw(li).guid || null; }
function liType(li) { return liRaw(li).type || 'text'; }
function isHeading(li) { return liType(li) === 'heading'; }
function isEmptyLine(li) { return liType(li) === 'text' && lineText(li) === ''; }
function headingSize(li) { const mp = liRaw(li).mp; return (mp && mp.hsize) || 1; }
function lineText(li) {
	const ts = liRaw(li).ts; if (!Array.isArray(ts)) return '';
	let s = ''; for (let i = 0; i < ts.length; i += 2) s += String(ts[i + 1] || ''); return s.trim();
}
function topLevelItems(items, recGuid) { return (items || []).filter((li) => liRaw(li).pguid === recGuid); }
// Build the page's heading outline: real document order + nesting depth.
// getLineItems() is a FLAT list that is NOT in document order (every top-level
// line comes first, then the children), so listing headings straight from it
// puts nested ones at the end. It IS sibling-ordered within a single parent,
// so regrouping by parent guid and walking depth-first restores the true order.
// `depth` counts ANCESTOR HEADINGS, not raw tree depth, so the result reads as
// an outline: two same-size headings where one sits under the other still come
// out on different levels.
function outlineHeadings(items, recGuid, skip) {
	const kids = new Map();
	for (const li of (items || [])) {
		const pg = liRaw(li).pguid;
		if (!pg) continue;
		if (!kids.has(pg)) kids.set(pg, []);
		kids.get(pg).push(li);
	}
	const out = [];
	const walk = (parentGuid, depth) => {
		for (const li of (kids.get(parentGuid) || [])) {
			const g = liGuid(li);
			if (!g) continue;
			const isH = isHeading(li) && !(skip && skip.has(g));
			if (isH) out.push({ guid: g, text: lineText(li), size: headingSize(li), depth });
			walk(g, isH ? depth + 1 : depth);
		}
	};
	walk(recGuid, 0);
	return out;
}
function lastOf(arr) { return arr && arr.length ? arr[arr.length - 1] : null; }
// The move target for "place directly after `target` at the same level":
// the record when the target is top-level, else the target's parent line.
function siblingParent(items, target, rec) {
	const pg = liRaw(target).pguid;
	if (pg === rowGuid(rec)) return rec;
	return (items || []).find((li) => liGuid(li) === pg) || rec;
}
function truncate(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function wbNorm(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); }
// Rank a page-name match: exact > prefix > word-start > plain substring, summed
// across the "+" parts, so the strongest titles float to the top of the Pages list.
function wbNameScore(nn, parts) {
	let s = 0;
	for (const p of parts) {
		if (nn === p) s += 100;
		else if (nn.startsWith(p)) s += 45;
		else if (nn.includes(' ' + p)) s += 25;
		else s += 8;
	}
	return s;
}
// Minimal date fallback (used only if Thymer's DateTime parser is unreachable):
// ISO YYYY-MM-DD, plus today / tomorrow / yesterday. Returns a JS Date or null.
function fallbackJournalDate(s) {
	const t = s.toLowerCase().trim();
	const today = new Date(); today.setHours(0, 0, 0, 0);
	if (t === 'today') return today;
	if (t === 'tomorrow') { const d = new Date(today); d.setDate(d.getDate() + 1); return d; }
	if (t === 'yesterday') { const d = new Date(today); d.setDate(d.getDate() - 1); return d; }
	const m = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
	if (m) { const d = new Date(+m[1], +m[2] - 1, +m[3]); d.setHours(0, 0, 0, 0); return isNaN(d.getTime()) ? null : d; }
	return null;
}
// Escape + bold EVERY occurrence of the matched words in the full text (no
// windowing — used by the line hover preview so the search terms stand out).
function wbHighlightAll(text, parts) {
	const full = String(text == null ? '' : text);
	const words = [...new Set((parts || []).concat((parts || []).flatMap((p) => p.split(/\s+/))))].filter((w) => w.length >= 2).sort((a, b) => b.length - a.length);
	if (!words.length) return esc(full);
	const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const re = new RegExp('(' + words.map(escRe).join('|') + ')', 'ig');
	let html = '', last = 0, m;
	while ((m = re.exec(full)) !== null) {
		html += esc(full.slice(last, m.index)) + '<b>' + esc(m[0]) + '</b>';
		last = m.index + m[0].length;
		if (m.index === re.lastIndex) re.lastIndex++;
	}
	return html + esc(full.slice(last));
}
// A short one-line snippet centred on the first matched part, with matched
// words highlighted (<b>, accent-coloured via CSS).
function wbSnippetHTML(text, parts) {
	const full = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
	const words = [...new Set((parts || []).concat((parts || []).flatMap((p) => p.split(/\s+/))))].filter((w) => w.length >= 2).sort((a, b) => b.length - a.length);
	const tail = (s, n) => s.slice(0, n) + (s.length > n ? '…' : '');
	if (!words.length) return esc(tail(full, 160));
	const lower = full.toLowerCase();
	let first = -1;
	for (const w of words) { const i = lower.indexOf(w); if (i >= 0 && (first < 0 || i < first)) first = i; }
	if (first < 0) return esc(tail(full, 160));
	const start = Math.max(0, first - 50);
	const end = Math.min(full.length, first + 115);
	const win = full.slice(start, end);
	const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const re = new RegExp('(' + words.map(escRe).join('|') + ')', 'ig');
	let html = '', last = 0, m;
	while ((m = re.exec(win)) !== null) {
		html += esc(win.slice(last, m.index)) + '<b>' + esc(m[0]) + '</b>';
		last = m.index + m[0].length;
		if (m.index === re.lastIndex) re.lastIndex++;
	}
	html += esc(win.slice(last));
	return (start > 0 ? '…' : '') + html + (end < full.length ? '…' : '');
}
// Reconstruct {type, text} segments from the pair-encoded live model.
function segmentsFromState(state) {
	const ts = (state && state.text_segments) || [];
	const segs = [];
	for (let i = 0; i + 1 < ts.length; i += 2) segs.push({ type: String(ts[i]), text: ts[i + 1] });
	return segs;
}
// >>>SHARED
function lastChildOf(items, parentGuid) { return lastOf((items || []).filter((li) => liRaw(li).pguid === parentGuid)); }
async function lastTopLevel(rec) { try { const items = await rec.getLineItems(); return lastOf(topLevelItems(items, rowGuid(rec))); } catch (e) { return null; } }
const WB_DEST_CSS = [
'.wb-dpop{position:fixed;z-index:100003;display:block;width:min(560px,calc(100vw - 24px));background:var(--cmdpal-bg-color,var(--wb-surface,#26262b));color:var(--cmdpal-fg-color,var(--text-color,#ddd));font-family:var(--font-mono,inherit);border:1px solid var(--wb-line,rgba(127,127,127,.4));border-radius:var(--radius-normal,3px);box-shadow:0 16px 48px rgba(0,0,0,.5);overflow:hidden;}',
'.wb-dpop.wb-dpop-menu{width:280px;padding:5px 0 10px;font-size:var(--text-size-normal,15.2px);border-radius:var(--radius-normal,3px);box-shadow:none;}.wb-dpop-menu .wb-dpop-input{font-size:var(--text-size-smaller,.8125rem);padding:10px;height:34px;}.wb-dpop-menu .wb-dpop-list{max-height:360px;padding-bottom:0;}.wb-dpop-menu .wb-opt{margin:0 5px 0 5px;padding:5px 10px;font-size:var(--text-size-small,13.3px);line-height:16px;gap:11px;border-radius:3px;}.wb-dpop-menu .wb-opt > .ti{width:16px;text-align:center;}.wb-dpop-menu .wb-sec{margin:4px 8px 0;padding:6px 7px 2px;border-top:1px solid rgba(196,196,196,.14);text-transform:none;letter-spacing:0;font-size:11px;opacity:.5;}.wb-dpop-menu .wb-sec:first-child{border-top:0;margin-top:0;}',
'.wb-opt .wb-opt-check{margin-left:auto;visibility:hidden;opacity:.9;}.wb-opt.wb-on .wb-opt-check{visibility:visible;}.wb-opt .wb-opt-open{opacity:.55;}.wb-opt .wb-opt-open:hover{opacity:1;}.wb-opt.wb-on .wb-opt-sub{margin-left:0;}',
'.wb-dpop-input{width:100%;box-sizing:border-box;border:none;outline:none;padding:10px;font-size:var(--text-size-small,.875rem);font-family:inherit;background:transparent;color:var(--cmdpal-fg-color,var(--text-color,#eee));border-bottom:1px solid var(--divider-color,rgba(127,127,127,.2));}',
'.wb-dpop-list{max-height:300px;overflow-y:auto;padding-bottom:6px;}',
'.wb-opt{padding:5px 10px;cursor:pointer;font-size:var(--text-size-small,.875rem);line-height:16px;font-weight:var(--font-weight-normal,400);display:flex;align-items:center;gap:8px;color:var(--cmdpal-fg-color,var(--text-color,#ddd));}',
'.wb-opt:hover:not(.wb-active){background:rgba(127,127,127,.12);}',
'.wb-opt.wb-active{background:var(--cmdpal-selected-bg-color,var(--ed-button-primary-bg,#3aa37f));color:var(--cmdpal-selected-fg-color,#fff);}',
'.wb-opt.wb-active .ti,.wb-opt.wb-active .wb-opt-sub{color:var(--cmdpal-selected-fg-color,#fff);opacity:.85;}',
'.wb-opt .ti{opacity:.7;font-size:14px;flex:0 0 auto;}',
'.wb-opt-text{flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap;}',
'.wb-opt-text b{color:var(--cmdpal-hilite-color,var(--color-blackwhite-0,#fff));font-weight:var(--font-weight-bold,700);}',
'.wb-opt-sub{opacity:.55;font-size:11.5px;flex:0 0 auto;max-width:170px;overflow:hidden;white-space:nowrap;}',
'.wb-sec{padding:8px 10px 3px;font-size:11px;opacity:.55;text-transform:uppercase;letter-spacing:.04em;}',
'.wb-hlvl{font-size:10px;opacity:.6;flex:0 0 auto;min-width:18px;}',
'.wb-dpop-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;border-top:1px solid var(--divider-color,rgba(127,127,127,.2));font-size:11.5px;opacity:.85;}',
'.wb-dpop-foot .wb-indent{display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border:1px solid var(--wb-line,rgba(127,127,127,.35));border-radius:var(--radius-normal,3px);cursor:pointer;}',
'.wb-dpop-foot .wb-indent.wb-on{color:var(--color-primary-500,#65c8bb);border-color:var(--color-primary-500,#65c8bb);}',
].join('\n');
Object.assign(WbBoard.prototype, {
	// ---- open / close -----------------------------------------------------------------------------------------
	noteAttachPicker(anchor, n, opts) {
		opts = opts || {}; this.plugin.closeMenus(); this.closeDestPicker();
		const pop = document.createElement('div'); pop.className = 'wb-dpop';
		pop.innerHTML = '<input class="wb-dpop-input" type="text" placeholder=\'Search pages, lines, or a date for the Journal (e.g. "tomorrow")\' /><div class="wb-dpop-list"></div>';
		pop.addEventListener('pointerdown', (e) => e.stopPropagation()); pop.addEventListener('mousedown', (e) => e.stopPropagation());
		this.host.appendChild(pop); this.popEl = pop; this.popNode = n; this.destOpts = []; this.destSel = 0; this.searchToken = (this.searchToken || 0) + 1; this.newNoteMode = false;
		this.destMode = opts.pagesOnly ? { onPick: opts.onPick, toggle: opts.toggle || null } : null; if (this.destMode) { pop.classList.add('wb-dpop-menu'); pop.querySelector('.wb-dpop-input').placeholder = opts.toggle ? 'Search pages' : 'Search pages'; }
		if (this.indentUnder === undefined) { try { this.indentUnder = localStorage.getItem('wb_indent_under') !== '0'; } catch (e) { this.indentUnder = true; } }
		const input = pop.querySelector('.wb-dpop-input'); const list = pop.querySelector('.wb-dpop-list');
		try { this.recordsCache = this.plugin.data.getAllRecords() || []; } catch (e) { this.recordsCache = []; }
		this.loadCollMap(); this.renderDefaultDestOptions(list);
		input.addEventListener('input', () => { if (this.newNoteMode) return; clearTimeout(this.searchTimer); const q = input.value.trim(); this.searchTimer = setTimeout(() => this.runDestSearch(q, list), 180); });
		input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'ArrowDown') { e.preventDefault(); this.setDestSel(this.destSel + 1); } else if (e.key === 'ArrowUp') { e.preventDefault(); this.setDestSel(this.destSel - 1); } else if (e.key === 'Enter') { e.preventDefault(); const o = this.destOpts[this.destSel]; if (o) o.pick(); } else if (e.key === 'Escape') { e.preventDefault(); this.closeDestPicker(); } });
		const r = anchor.getBoundingClientRect(); const hr = this.host.getBoundingClientRect(); const w = this.destMode ? 280 : Math.min(560, window.innerWidth - 24);
		pop.style.left = Math.max(hr.left + 8, Math.min(r.left, hr.right - w - 8)) + 'px';
		if (opts.above) { pop.style.top = ''; pop.style.bottom = Math.max(8, window.innerHeight - r.top + 6) + 'px'; } else pop.style.top = Math.min(r.bottom + 6, window.innerHeight - 420) + 'px';
		const out = (e) => { if (!pop.contains(e.target) && !(e.target.closest && e.target.closest('.wb-linepreview'))) this.closeDestPicker(); }; document.addEventListener('pointerdown', out, true); pop._out = out;
		setTimeout(() => input.focus(), 0);
	},
	closeDestPicker() { this.newNoteMode = false; this.destMode = null; clearTimeout(this.searchTimer); this.searchToken = (this.searchToken || 0) + 1; this.destOpts = []; this.destSel = 0; this.hideLinePreview(); if (this.popEl) { try { document.removeEventListener('pointerdown', this.popEl._out, true); } catch (e) {} this.popEl.remove(); this.popEl = null; } this.popNode = null; },
	// ---- results (Quick Capture's renderer, wb- classes) ----------------------------------------------------------
	resetDestList(list) { this.destOpts = []; this.destSel = 0; this.hideLinePreview(); list.innerHTML = ''; },
	sec(list, text) { const h = document.createElement('div'); h.className = 'wb-sec'; h.textContent = text; list.appendChild(h); },
	addDestOpt(list, el, pick) { const idx = this.destOpts.length; el.addEventListener('click', (e) => { e.stopPropagation(); pick(); }); el.addEventListener('pointermove', () => { if (this.destSel !== idx) this.setDestSel(idx); }); this.destOpts.push({ el, pick }); if (idx === this.destSel) el.classList.add('wb-active'); list.appendChild(el); },
	setDestSel(i) { const n = this.destOpts.length; if (!n) return; const next = ((i % n) + n) % n; const prev = this.destOpts[this.destSel]; if (prev) prev.el.classList.remove('wb-active'); this.destSel = next; const cur = this.destOpts[next]; cur.el.classList.add('wb-active'); try { cur.el.scrollIntoView({ block: 'nearest' }); } catch (e) {} },
	renderDefaultDestOptions(list) {
		this.resetDestList(list);
		if (this.destMode) {
			const tg = this.destMode.toggle;
			if (tg) { const linked = tg.linked(); this.sec(list, linked.length ? 'Linked pages' : 'No pages linked yet'); for (const x of linked) this.addDestOpt(list, this.destToggleRow(x.name, x.icon, true, x.guid, null), () => this.destToggle(x.guid, { name: x.name, icon: x.icon, rec: x.rec }, list)); }
			return;
		}
		this.sec(list, 'Default');
		const journal = document.createElement('div'); journal.className = 'wb-opt'; journal.innerHTML = '<span class="ti ti-calendar-event"></span><span class="wb-opt-text">Today\'s Journal</span>';
		this.addDestOpt(list, journal, () => this.chooseDest({ kind: 'journal' }));
		const nn = document.createElement('div'); nn.className = 'wb-opt'; nn.innerHTML = '<span class="ti ti-file-plus"></span><span class="wb-opt-text">New note in a collection</span>';
		this.addDestOpt(list, nn, () => this.pickNewNote(list));
		this.sec(list, 'Type to search pages, lines, or a date');
	},
	async pickNewNote(list) {
		const input = this.popEl && this.popEl.querySelector('.wb-dpop-input'); if (!input) return;
		clearTimeout(this.searchTimer); const my = ++this.searchToken; this.newNoteMode = true; input.value = ''; input.placeholder = 'Enter a title for the new note'; this.resetDestList(list); this.sec(list, 'Loading collections'); input.focus();
		let cols = []; try { cols = (await this.plugin.refreshCols()) || []; } catch (e) {}
		if (!this.popEl || !this.newNoteMode || my !== this.searchToken) return;
		cols = cols.filter((c) => { try { return c && typeof c.createRecord === 'function' && !(c.isJournalPlugin && c.isJournalPlugin()) && !this.plugin.isDynamicCollection(c) && !this.plugin.isExcludedCollection(c) && c.getName() !== WB_BOARDS; } catch (e) { return false; } });
		cols.sort((a, b) => (a.getName() || '').localeCompare(b.getName() || ''));
		this.resetDestList(list); this.sec(list, 'New note');
		const back = document.createElement('div'); back.className = 'wb-opt'; back.innerHTML = '<span class="ti ti-arrow-left"></span><span class="wb-opt-text">Back to destinations</span>';
		this.addDestOpt(list, back, () => { this.newNoteMode = false; this.searchToken++; input.value = ''; input.placeholder = WB_DEST_PLACEHOLDER; this.renderDefaultDestOptions(list); input.focus(); });
		this.sec(list, 'Choose a collection');
		for (const c of cols) {
			let icon = ''; try { icon = collIconFromConf(c.getConfiguration()); } catch (e) {} icon = icon || 'ti-folder';
			const opt = document.createElement('div'); opt.className = 'wb-opt'; opt.innerHTML = '<span class="ti ' + esc(icon) + '"></span><span class="wb-opt-text">' + esc(c.getName() || 'Collection') + '</span>';
			this.addDestOpt(list, opt, () => { const title = input.value.trim(); this.newNoteMode = false; this.chooseDest({ kind: 'newnote', collGuid: c.getGuid(), name: title || 'Untitled', collName: c.getName() || '', icon }); });
		}
		if (this.destOpts.length > 1) this.setDestSel(1);
	},
	async loadCollMap() { try { const cols = await this.plugin.refreshCols(); const m = {}; for (const c of (cols || [])) { let g = null; try { g = c.getGuid ? c.getGuid() : null; } catch (e) {} let nm = ''; try { nm = c.getName ? c.getName() : ''; } catch (e) {} let ic = ''; try { ic = collIconFromConf(c.getConfiguration()); } catch (e) {} if (g) m[g] = { name: nm, icon: ic }; } this.collMap = m; } catch (e) {} },
	collName(guid) { const e = guid && this.collMap && this.collMap[guid]; return (e && e.name) || ''; },
	collIcon(guid) { const e = guid && this.collMap && this.collMap[guid]; return (e && e.icon) || ''; },
	collGuidOf(rec) { try { return rec && rec._getRow ? rec._getRow().pguid : null; } catch (e) { return null; } },
	iconOf(rec, collGuid) { let ic = null; try { ic = rec && rec.getIcon ? (rec.getIcon(true) || rec.getIcon()) : null; } catch (e) {} return ic || this.collIcon(collGuid) || 'ti-file'; },
	iconForPage(pageGuid, collGuid) { let rec = null; try { rec = pageGuid ? this.plugin.data.getRecord(pageGuid) : null; } catch (e) {} return this.iconOf(rec, collGuid); },
	displayText(segments) { return (segments || []).map((s) => { if (typeof s.text === 'string') return s.text; const t = s.text || {}; if (s.type === 'ref') { if (t.title) return t.title; try { const r = t.guid && this.plugin.data.getRecord(t.guid); if (r && r.getName) return r.getName(); } catch (e) {} return '↗'; } return t.title || t.text || t.name || ''; }).join(''); },
	parseJournalDate(q) { const s = String(q || '').trim(); if (!s) return null; let d = null; try { const DT = (typeof DateTime !== 'undefined') ? DateTime : null; if (DT && DT.parseDateTimeString) { const dt = DT.parseDateTimeString(s); if (dt && typeof dt.toDate === 'function') { const jd = dt.toDate(); if (jd && !isNaN(jd.getTime())) d = jd; } } } catch (e) {} if (!d) d = fallbackJournalDate(s); if (!d) return null; const label = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).replace(',', ''); const jd = d; return { dt: { toDate: () => jd }, label }; },
	async runDestSearch(q, list) {
		if (!q) { this.renderDefaultDestOptions(list); return; }
		const my = ++this.searchToken; const parts = q.split('+').map((p) => wbNorm(p)).filter(Boolean); if (!parts.length) { this.renderDefaultDestOptions(list); return; }
		const jdate = this.destMode ? null : this.parseJournalDate(q); const terms = new Set(); for (const p of parts) { terms.add(p); const w = p.split(/\s+/).filter((x) => x.length >= 2).sort((a, b) => b.length - a.length)[0]; if (w) terms.add(w); }
		const skip = new Set([this.rec.guid, this.popNode && this.popNode.recordGuid === this.rec.guid ? '' : '']);
		const pageSeen = new Set(), lineSeen = new Set(); const pages = [], lines = [];
		const addPage = (rec, guid, name) => { if (!guid || skip.has(guid) || pageSeen.has(guid)) return; pageSeen.add(guid); pages.push({ rec, guid, name: name || 'Untitled', collGuid: this.collGuidOf(rec), score: wbNameScore(wbNorm(name), parts) }); };
		const sortPages = () => pages.sort((a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name));
		const selfLine = this.popNode ? this.popNode.lineGuid : null;
		const considerLine = (guid, segments, pageFn) => { if (this.destMode || !guid || guid === selfLine || lineSeen.has(guid) || lines.length >= 40) return; lineSeen.add(guid); const text = this.displayText(segments).trim(); if (!text) return; const lt = wbNorm(text); if (!parts.every((p) => lt.includes(p))) return; let info = null; try { info = pageFn(); } catch (e) {} if (!info || !info.guid || skip.has(info.guid)) return; lines.push({ lineGuid: guid, pageGuid: info.guid, text, page: info.name || '', collGuid: info.collGuid || null }); };
		for (const rec of this.recordsCache || []) { const guid = rowGuid(rec); if (!guid || skip.has(guid) || pageSeen.has(guid)) continue; const name = (rec.getName && rec.getName()) || ''; if (!name || !parts.every((p) => wbNorm(name).includes(p))) continue; addPage(rec, guid, name); }
		sortPages();
		const byGuid = (window.g_universe && window.g_universe.itemsByGuid) || {}; const nowMs = () => performance.now(); const t0 = nowMs();
		for (const guid in byGuid) { if (lines.length >= 40 || nowMs() - t0 > 150) break; const it = byGuid[guid]; if (!it || it.is_deleted || it.is_trashed || it.type === 'document') continue; if (!it.rguid || skip.has(it.rguid)) continue; const ts = it.text_segments; if (!ts || !ts.length) continue; let raw = ''; for (let i = 0; i + 1 < ts.length; i += 2) { if (typeof ts[i + 1] === 'string') raw += ts[i + 1] + ' '; } const rawNorm = wbNorm(raw); if (!parts.some((p) => rawNorm.includes(p))) continue; considerLine(it.guid || guid, segmentsFromState(it), () => { const r = this.plugin.data.getRecord(it.rguid); return r ? { guid: it.rguid, name: r.getName && r.getName(), collGuid: this.collGuidOf(r) } : null; }); }
		this.renderDestResults(list, pages, lines, parts, true, jdate);
		for (const t of terms) { let res; try { res = await this.plugin.data.searchByQuery(t, 60); } catch (e) { res = {}; } if (my !== this.searchToken) return; for (const r of res.records || []) { const g = rowGuid(r); if (!g || skip.has(g) || pageSeen.has(g)) continue; const name = (r.getName && r.getName()) || ''; if (!parts.every((p) => wbNorm(name).includes(p))) continue; addPage(r, g, name); } for (const li of res.lines || []) { considerLine(li.guid, li.segments, () => { const r = li.getRecord && li.getRecord(); return r ? { guid: rowGuid(r), name: r.getName && r.getName(), collGuid: this.collGuidOf(r) } : null; }); } }
		if (my !== this.searchToken) return; sortPages(); this.renderDestResults(list, pages, lines, parts, false, jdate);
	},
	destToggleRow(name, icon, on, guid, parts) {
		const opt = document.createElement('div'); opt.className = 'wb-opt' + (on ? ' wb-on' : '');
		opt.innerHTML = '<span class="ti ' + esc(wbTi(icon, 'ti-file')) + '"></span><span class="wb-opt-text">' + (parts ? wbSnippetHTML(name, parts) : esc(name)) + '</span>' + (on ? '<span class="ti ti-arrow-up-right wb-opt-open" title="Open the page"></span>' : '') + '<span class="ti ti-check wb-opt-check"></span>';
		const open = opt.querySelector('.wb-opt-open'); if (open) { open.addEventListener('pointerdown', (e) => e.stopPropagation()); open.addEventListener('click', (e) => { e.stopPropagation(); if (this.destMode && this.destMode.toggle) this.destMode.toggle.onOpen(guid); }); }
		return opt;
	},
	destToggle(guid, info, list) {
		const tg = this.destMode && this.destMode.toggle; if (!tg) return; const on = !tg.isOn(guid); tg.onToggle(guid, on, info);
		const inp = this.popEl && this.popEl.querySelector('.wb-dpop-input'); const q = inp ? inp.value.trim() : ''; const sel = this.destSel;
		if (q) this.runDestSearch(q, list); else this.renderDefaultDestOptions(list);
		if (this.destOpts.length) this.setDestSel(Math.min(sel, this.destOpts.length - 1));
	},
	renderDestResults(list, pages, lines, parts, searching, jdate) {
		this.resetDestList(list);
		if (jdate) { this.sec(list, 'Journal'); const j = document.createElement('div'); j.className = 'wb-opt'; j.innerHTML = '<span class="ti ti-calendar-event"></span><span class="wb-opt-text">Journal · ' + esc(jdate.label) + '</span>'; this.addDestOpt(list, j, () => this.chooseDest({ kind: 'journal', date: jdate.dt, dateLabel: jdate.label })); }
		if (!pages.length && !lines.length) { if (!jdate) { const e = document.createElement('div'); e.className = 'wb-opt'; e.textContent = searching ? 'Searching' : 'No pages or lines found'; list.appendChild(e); } return; }
		if (pages.length) { this.sec(list, 'Pages'); for (const p of pages.slice(0, 40)) { const coll = this.collName(p.collGuid); if (this.destMode && this.destMode.toggle) { const on = this.destMode.toggle.isOn(p.guid); const icon = this.iconOf(p.rec, p.collGuid); const row = this.destToggleRow(p.name, icon, on, p.guid, parts); if (coll) { const sub = document.createElement('span'); sub.className = 'wb-opt-sub'; sub.textContent = coll; row.insertBefore(sub, row.querySelector('.wb-opt-check')); } this.addDestOpt(list, row, () => this.destToggle(p.guid, { name: p.name, icon, rec: p.rec }, list)); continue; } const opt = document.createElement('div'); opt.className = 'wb-opt'; opt.innerHTML = '<span class="ti ' + esc(this.iconOf(p.rec, p.collGuid)) + '"></span><span class="wb-opt-text">' + wbSnippetHTML(p.name, parts) + '</span>' + (coll ? '<span class="wb-opt-sub">' + esc(coll) + '</span>' : ''); this.addDestOpt(list, opt, () => this.pickPage(p.rec, list)); } }
		if (lines.length) { this.sec(list, 'Lines'); for (const l of lines.slice(0, 20)) { const opt = document.createElement('div'); opt.className = 'wb-opt'; opt.innerHTML = '<span class="ti ' + esc(this.iconForPage(l.pageGuid, l.collGuid)) + '"></span><span class="wb-opt-text">' + wbSnippetHTML(l.text, parts) + '</span>' + (l.page ? '<span class="wb-opt-sub">' + esc(l.page) + '</span>' : ''); const ctx = [l.page, this.collName(l.collGuid)].filter(Boolean).join(' · '); opt.addEventListener('mouseenter', () => this.showLinePreview(opt, l.text, ctx, parts)); opt.addEventListener('mouseleave', () => this.hideLinePreview()); this.addDestOpt(list, opt, () => this.chooseDest({ kind: 'line', guid: l.lineGuid, pageGuid: l.pageGuid, name: truncate(l.text, 34), pageName: l.page, icon: this.iconForPage(l.pageGuid, l.collGuid) })); } }
	},
	showLinePreview(rowEl, text, ctx, parts) {
		this.hideLinePreview(); if (!text) return;
		const box = document.createElement('div'); box.className = 'wb-linepreview'; const t = document.createElement('div'); t.className = 'wb-lp-text'; t.innerHTML = wbHighlightAll(text, parts); box.appendChild(t);
		if (ctx) { const c = document.createElement('div'); c.className = 'wb-lp-ctx'; c.textContent = ctx; box.appendChild(c); }
		document.body.appendChild(box); this.linePreviewEl = box;
		const r = rowEl.getBoundingClientRect(); const vw = window.innerWidth, vh = window.innerHeight; const belowSpace = vh - r.bottom - 12, aboveSpace = r.top - 12; const placeBelow = belowSpace >= aboveSpace;
		box.style.maxHeight = Math.max(80, Math.min(placeBelow ? belowSpace : aboveSpace, Math.round(vh * 0.6))) + 'px';
		const bw = box.offsetWidth, bh = box.offsetHeight; const left = Math.max(8, Math.min(r.left, vw - bw - 8)); let top = placeBelow ? r.bottom + 4 : r.top - bh - 4; top = Math.max(8, Math.min(top, vh - bh - 8));
		box.style.left = left + 'px'; box.style.top = top + 'px';
	},
	hideLinePreview() { if (this.linePreviewEl) { this.linePreviewEl.remove(); this.linePreviewEl = null; } },
	async pickPage(rec, list) {
		const guid = rowGuid(rec); const name = rec.getName ? rec.getName() : 'Page';
		let headings = [], hasContent = false;
		try { const items = await rec.getLineItems(); headings = outlineHeadings(items, guid, new Set([this.popNode && this.popNode.lineGuid])); hasContent = topLevelItems(items, guid).some((li) => !isEmptyLine(li)); } catch (e) {}
		const icon = this.iconOf(rec, this.collGuidOf(rec)); if (!hasContent || this.destMode) { this.chooseDest({ kind: 'page', guid, name, icon }); return; }
		this.resetDestList(list); this.sec(list, name + ' · where?');
		const top = document.createElement('div'); top.className = 'wb-opt'; top.innerHTML = '<span class="ti ti-arrow-bar-to-up"></span><span class="wb-opt-text">Top of page</span>'; this.addDestOpt(list, top, () => this.chooseDest({ kind: 'page', guid, name, atTop: true, icon }));
		const bottomIdx = this.destOpts.length; const bottom = document.createElement('div'); bottom.className = 'wb-opt'; bottom.innerHTML = '<span class="ti ti-arrow-bar-to-down"></span><span class="wb-opt-text">Bottom of page</span><span class="wb-opt-sub">default</span>'; this.addDestOpt(list, bottom, () => this.chooseDest({ kind: 'page', guid, name, icon }));
		for (const h of headings) { if (!h.guid) continue; const opt = document.createElement('div'); opt.className = 'wb-opt'; opt.style.paddingLeft = (10 + Math.min(h.depth, 6) * 14) + 'px'; opt.innerHTML = '<span class="wb-hlvl">H' + h.size + '</span><span class="wb-opt-text">' + esc(h.text || 'Heading') + '</span>'; this.addDestOpt(list, opt, () => this.chooseDest({ kind: 'page', guid, name, afterHeadingGuid: h.guid, headingText: h.text, icon })); }
		this.setDestSel(bottomIdx);
	},
	// ---- what a pick DOES: move the card's block (Quick Capture's resolution, one block instead of many) --------
	// a pick: with the editor open it only SETS the destination (Send moves); otherwise it moves at once
	chooseDest(dest) { if (this.destMode && this.destMode.onPick) { const f = this.destMode.onPick; this.closeDestPicker(); f(dest); return; } const ed = this._noteEditor; const n = this.popNode; this.closeDestPicker(); if (ed && ed.n === n && ed.setDest) { ed.setDest(dest); return; } this.popNode = n; this.applyDest(dest); },
	async applyDest(dest) {
		const n = this.popNode || (this._noteEditor && this._noteEditor.n); this.closeDestPicker(); if (!n) return;
		const li = await this.noteLine(n); if (!li) { this.plugin.toast('The block behind this card is gone.'); return; }
		const indent = !!this.indentUnder; let destRec = null, parentTarget = null, anchor = null, label = '';
		try {
			if (dest.kind === 'journal') {
				const dt = dest.date || null; destRec = await this.plugin.journalRecord(dt);
				if (!destRec) { this.plugin.toast('No Journal found in this workspace. Pick a page instead.'); return; }
				label = dest.dateLabel ? ('the Journal, ' + dest.dateLabel) : "today's Journal"; parentTarget = destRec; anchor = await lastTopLevel(destRec);
			} else if (dest.kind === 'newnote') {
				const col = ((await this.plugin.refreshCols()) || []).find((c) => c.getGuid() === dest.collGuid); if (!col) { this.plugin.toast('That collection is gone.'); return; }
				const guid = await this.plugin.createPage(dest.name || 'Untitled', col); if (!guid) return;
				destRec = await wbRecordPoll(this.plugin, guid, 30); if (!destRec) { this.plugin.toast('The new page did not show up in time.'); return; }
				label = dest.name + ' (new page in ' + dest.collName + ')'; parentTarget = destRec; anchor = null;
			} else if (dest.kind === 'line') {
				destRec = this.plugin.data.getRecord(dest.pageGuid); if (!destRec) { this.plugin.toast('Destination page not found.'); return; }
				label = dest.name; const ditems = await destRec.getLineItems(); const target = ditems.find((x) => liGuid(x) === dest.guid);
				if (!target) { parentTarget = destRec; anchor = lastOf(topLevelItems(ditems, rowGuid(destRec))); label = dest.pageName || label; }
				else if (indent) { parentTarget = target; anchor = lastChildOf(ditems, dest.guid); }
				else { parentTarget = siblingParent(ditems, target, destRec); anchor = target; }
			} else {
				destRec = this.plugin.data.getRecord(dest.guid); if (!destRec) { this.plugin.toast('Destination page not found.'); return; }
				label = dest.name;
				if (dest.afterHeadingGuid) { const ditems = await destRec.getLineItems(); const heading = ditems.find((x) => liGuid(x) === dest.afterHeadingGuid); label += ' › ' + (dest.headingText || 'heading'); if (!heading) { parentTarget = destRec; anchor = lastOf(topLevelItems(ditems, rowGuid(destRec))); } else if (indent) { parentTarget = heading; anchor = lastChildOf(ditems, dest.afterHeadingGuid); } else { parentTarget = siblingParent(ditems, heading, destRec); anchor = heading; } }
				else if (dest.atTop) { parentTarget = destRec; anchor = null; label += ' › Top'; }
				else { parentTarget = destRec; anchor = await lastTopLevel(destRec); }
			}
		} catch (e) { this.plugin.toast('Could not resolve the destination.'); return; }
		const ok = await this.noteMoveLines(n, parentTarget, anchor);
		if (!ok) { this.plugin.toast('Could not move the block there.'); return; }
		this.pushHistory(); n.recordGuid = rowGuid(destRec) || n.recordGuid; n.attached = true; n._rev = (n._rev || 0) + 1; this.renderNode(n); this.buildCtx(); this.scheduleSave();
		if (this._noteEditor && this._noteEditor.n === n) { if (this._noteEditor.setDest) this._noteEditor.setDest(null); if (this._noteEditor.paintAction) this._noteEditor.paintAction(); }
		this.plugin.toast('Card attached to ' + label + '.');
	},
});
{
	const basePluginOnLoad = Plugin.prototype.onLoad;
	Plugin.prototype.onLoad = function () { basePluginOnLoad.call(this); this.ui.injectCSS(WB_DEST_CSS); };
	const baseDestroy = WbBoard.prototype.destroy;
	WbBoard.prototype.destroy = function () { try { this.closeDestPicker(); } catch (e) {} return baseDestroy.call(this); };
}


// ===========================================================================
// Link cards (his ask 2026-09-20, Miro's link preview as the model): paste a web address on the board and it becomes a
// card with the page's picture, site, title and description. The app cannot read a foreign page itself (CORS, measured),
// and Thymer has no link preview of its own, so the facts come from microlink.io. HIS RULING ("Beslut A", a trial): every
// pasted address is sent to that service, once, when the card is made or refreshed; what comes back is stored in the
// scene, so an open board asks nobody. The free tier allows about 50 lookups a day; a failed lookup leaves a plain card.
// The card is a fixed 280 px layout scaled to the node's width, like the page cards, so a resize keeps its proportions.
// ===========================================================================
const WB_LINK_W = 280;
const WB_LINK_API = 'https://api.microlink.io/?url=';
const WB_LINK_RE = /^https?:\/\/[^\s]+$/i;
const WB_LINK_CSS = [
'.wb-linknode{overflow:visible;}',
'.wb-linkcard{position:absolute;left:0;top:0;width:' + WB_LINK_W + 'px;transform-origin:0 0;box-sizing:border-box;background:var(--wb-card);border:1px solid var(--wb-card-line);border-radius:var(--wb-radius);box-shadow:var(--wb-shadow);overflow:hidden;color:var(--wb-text);}',
'.wb-linkcard .wb-lk-pic{display:block;width:100%;aspect-ratio:16 / 9;object-fit:cover;background:color-mix(in srgb,var(--wb-text) 6%,transparent);border-bottom:1px solid var(--wb-card-line);pointer-events:none;}',
'.wb-linkcard .wb-lk-body{padding:12px 14px 14px;display:flex;flex-direction:column;gap:6px;}',
'.wb-linkcard .wb-lk-site{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--wb-muted);min-width:0;padding-right:30px;}',
'.wb-linkcard .wb-lk-site img{width:14px;height:14px;border-radius:2px;flex:0 0 auto;pointer-events:none;}',
'.wb-linkcard .wb-lk-title{font-size:14px;font-weight:600;line-height:1.35;overflow-wrap:anywhere;}',
'.wb-linkcard .wb-lk-desc{font-size:12px;line-height:1.5;max-height:4.5em;overflow:hidden;color:var(--wb-muted);overflow-wrap:anywhere;}',
'.wb-linkcard .wb-lk-open{position:absolute;top:8px;right:8px;width:26px;height:26px;display:flex;align-items:center;justify-content:center;border-radius:var(--wb-radius);background:var(--wb-surface);border:1px solid var(--wb-line);color:var(--wb-text);cursor:pointer;}',
'.wb-linkcard .wb-lk-open:hover{filter:brightness(1.2);}.wb-linkcard .wb-lk-open svg{width:14px;height:14px;}',
].join('\n');
const WB_I_OPEN = WB_SVG('<path d="M14 5h5v5"></path><path d="M19 5l-8 8"></path><path d="M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4"></path>');
function wbLinkHost(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }
Object.assign(WbBoard.prototype, {
	createLinkAt(url, w) {
		this.pushHistory();
		const n = wbNode('link', Math.round(w.x - WB_LINK_W / 2), Math.round(w.y - 60), WB_LINK_W, 120, { url, title: '', desc: '', image: '', site: wbLinkHost(url), logo: '' });
		this.scene.nodes.push(n); this.selected = new Set([n.id]); this.selectedEdge = null; this.renderAll(); this.scheduleSave(); this.linkFetch(n);
		return n;
	},
	async linkFetch(n) {
		if (n._fetching) return; n._fetching = true; n._rev = (n._rev || 0) + 1; this.renderNode(n);
		let d = null; try { const r = await Promise.race([fetch(WB_LINK_API + encodeURIComponent(n.url)), wbSleep(12000).then(() => null)]); const j = r ? await r.json() : null; if (j && j.status === 'success') d = j.data || null; } catch (e) {}
		n._fetching = false; if (this.destroyed || !this.scene.nodes.includes(n)) return;
		if (d) { n.title = d.title || ''; n.desc = d.description || ''; n.image = (d.image && d.image.url) || ''; n.logo = (d.logo && d.logo.url) || ''; n.site = d.publisher || wbLinkHost(n.url); this.scheduleSave(); }
		else { n._failed = true; this.plugin.toast('No preview came back for that link. The card keeps the address.'); }
		n._rev = (n._rev || 0) + 1; this.renderNode(n); this.invalidateChrome();
	},
	openLink(n) { if (n && WB_LINK_RE.test(n.url || '')) { try { window.open(n.url, '_blank', 'noopener'); } catch (e) {} } },
	renderLinkNode(n, el) {
		if (!el.classList.contains('wb-linknode')) el.classList.add('wb-linknode');
		const key = String(n._rev || 0) + ':' + (n._fetching ? 1 : 0); let card = el.querySelector('.wb-linkcard');
		if (el.dataset.rev !== key || !card) {
			el.dataset.rev = key; el.innerHTML = ''; card = wbEl('div', 'wb-linkcard');
			if (n.image) { const img = document.createElement('img'); img.className = 'wb-lk-pic'; img.draggable = false; img.loading = 'lazy'; img.alt = ''; img.src = n.image; img.addEventListener('error', () => { img.remove(); this.measureLink(n, el); }); card.appendChild(img); }
			const body = wbEl('div', 'wb-lk-body'); const site = wbEl('div', 'wb-lk-site');
			if (n.logo) { const lg = document.createElement('img'); lg.draggable = false; lg.alt = ''; lg.src = n.logo; lg.addEventListener('error', () => lg.remove()); site.appendChild(lg); }
			const sn = document.createElement('span'); sn.textContent = n.site || wbLinkHost(n.url); site.appendChild(sn); body.appendChild(site);
			const tt = wbEl('div', 'wb-lk-title'); tt.textContent = n.title || (n._fetching ? 'Loading' : n.url); body.appendChild(tt);
			if (n.desc) { const ds = wbEl('div', 'wb-lk-desc'); ds.textContent = n.desc; body.appendChild(ds); }
			card.appendChild(body);
			const open = wbEl('div', 'wb-lk-open', WB_I_OPEN); open.title = 'Open link'; open.setAttribute('role', 'button');
			open.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); }); open.addEventListener('click', (e) => { e.stopPropagation(); this.openLink(n); });
			card.appendChild(open); el.appendChild(card);
			if (!el._wbLinkRo) { el._wbLinkRo = new ResizeObserver(() => { if (!this.destroyed && el.isConnected) this.measureLink(n, el); }); } el._wbLinkRo.disconnect(); el._wbLinkRo.observe(card);
		}
		card.style.transform = 'scale(' + (n.w / WB_LINK_W) + ')';
		this.measureLink(n, el);
	},
	measureLink(n, el) {
		const card = el.querySelector('.wb-linkcard'); if (!card) return;
		const h = Math.max(40, Math.round(card.offsetHeight * (n.w / WB_LINK_W)));
		if (Math.abs(h - n.h) > 1) { n.h = h; el.style.height = h + 'px'; this.invalidateChrome(); }
	},
});
{
	const baseRenderNodeLink = WbBoard.prototype.renderNode;
	WbBoard.prototype.renderNode = function (n) {
		if (n.type !== 'link') return baseRenderNodeLink.call(this, n);
		let el = this.nodeEls.get(n.id);
		if (el && el.dataset.wbType && el.dataset.wbType !== n.type) { el.remove(); this.nodeEls.delete(n.id); el = null; }
		if (!el) { el = wbEl('div', 'wb-node'); el.dataset.id = n.id; el.dataset.wbType = n.type; this.nodes.appendChild(el); this.nodeEls.set(n.id, el); }
		el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; el.style.width = n.w + 'px'; el.style.height = n.h + 'px';
		this.renderLinkNode(n, el);
	};
	// A pasted web address becomes a link card. With one text element selected the older rule still wins (paste goes INTO it).
	const baseOnPasteLink = WbBoard.prototype.onPaste;
	WbBoard.prototype.onPaste = function (e) {
		if (!this.destroyed && !this.editing && e.clipboardData) {
			const txt = (e.clipboardData.getData('text/plain') || '').trim();
			const one = this.selected.size === 1 ? this.nodeById([...this.selected][0]) : null; const into = one && (one.type === 'sticky' || one.type === 'text' || one.type === 'shape' || one.type === 'mind');
			if (WB_LINK_RE.test(txt) && !into) { e.preventDefault(); e.stopPropagation(); const r = this.canvas.getBoundingClientRect(); this.createLinkAt(txt, this.toWorld(r.width / 2, r.height / 2)); return; }
		}
		return baseOnPasteLink.call(this, e);
	};
	const baseOnDblLink = WbBoard.prototype.onDbl;
	WbBoard.prototype.onDbl = function (e) { const hit = this.hitNode(e); if (hit && hit.type === 'link') { this.openLink(hit); return; } return baseOnDblLink.call(this, e); };
	const baseBuildCtxLink = WbBoard.prototype.buildCtx;
	WbBoard.prototype.buildCtx = function () {
		baseBuildCtxLink.call(this);
		const n = this.selected.size === 1 && !this.selectedEdge ? this.nodeById([...this.selected][0]) : null; if (!n || n.type !== 'link' || !this.ctx) return;
		const del = [...this.ctx.querySelectorAll('.wb-tb')].find((x) => x.title === 'Delete');
		const openBtn = this.tb(WB_I_OPEN, 'Open link', () => this.openLink(n));
		const again = this.tb(WB_SVG('<path d="M20 11a8 8 0 1 0-2.3 5.7"></path><path d="M20 4v7h-7"></path>'), 'Fetch the preview again', () => this.linkFetch(n));
		this.ctx.insertBefore(openBtn, del || null); this.ctx.insertBefore(again, del || null); this.ctx.insertBefore(this.sep(), del || null);
	};
	const basePluginOnLoadLink = Plugin.prototype.onLoad;
	Plugin.prototype.onLoad = function () { basePluginOnLoadLink.call(this); this.ui.injectCSS(WB_LINK_CSS); };
}

// ===========================================================================
// The boards page (his ask 2026-09-20, Miro's "Boards in this team" as the model): every board as a tile with a picture
// of its content, its name, when it changed and the page it hangs on; sorting, New Board, and Rename / Trash per tile.
// It is drawn in two places by the same code: the custom panel when no board is chosen (the old picker), and a custom
// VIEW of the Boards collection. A custom view needs code ON the collection, so the collection carries a stub that only
// registers the label and hands every hook to this plugin at call time (Storyroom's pattern); ensureHomeView() writes it
// once and again only when WB_STUB_VERSION moves. Tokens are Thymer's own, because a collection view is not a .wb-host.
// ===========================================================================
const WB_HOME_VIEW = { id: 'wb_home', label: 'Boards' };
const WB_STUB_VERSION = 1;
const WB_STUB_SRC = [
'// Whiteboard boards-view stub v' + WB_STUB_VERSION + ', written by the Whiteboard plugin. Do not edit by hand.',
'class Plugin extends CollectionPlugin {',
'	onLoad() {',
'		this._views = [];',
'		const note = (el) => { if (el) el.innerHTML = "<div style=\\"padding:40px 32px;color:#8a8a8f;font-size:13px;line-height:1.6;max-width:520px\\">Whiteboard is switched off. Turn on the Whiteboard plugin under Plugins to see the boards here.</div>"; };',
'		const drop = (v) => { if (v.inst) { try { v.inst.onDestroy(); } catch (e) {} v.inst = null; } };',
'		const mount = (v) => { const h = window.__wbHome; if (!h) return; drop(v); try { v.inst = h.view(v.ctx); v.inst.onLoad(); if (v.last) v.inst.onRefresh(v.last); } catch (e) { console.warn("[whiteboard stub] mount", e); } };',
'		this.views.register("' + WB_HOME_VIEW.label + '", (ctx) => {',
'			const v = { ctx, inst: null, last: null }; this._views.push(v);',
'			const call = (k, a) => { if (v.inst && v.inst[k]) return v.inst[k](a); };',
'			return {',
'				onLoad: () => { if (window.__wbHome) mount(v); else note(ctx.getElement()); },',
'				onRefresh: (a) => { v.last = a; return call("onRefresh", a); },',
'				onPanelResize: () => call("onPanelResize"),',
'				onDestroy: () => { drop(v); this._views = this._views.filter((x) => x !== v); },',
'				onFocus: () => call("onFocus"),',
'				onBlur: () => call("onBlur"),',
'				onKeyboardNavigation: (a) => call("onKeyboardNavigation", a),',
'			};',
'		});',
'		this._onReady = () => { for (const v of this._views) mount(v); };',
'		this._onOff = () => { for (const v of this._views) { drop(v); try { note(v.ctx.getElement()); } catch (e) {} } };',
'		window.addEventListener("whiteboard:ready", this._onReady);',
'		window.addEventListener("whiteboard:off", this._onOff);',
'	}',
'	onUnload() {',
'		window.removeEventListener("whiteboard:ready", this._onReady);',
'		window.removeEventListener("whiteboard:off", this._onOff);',
'	}',
'}',
''].join('\n');
const WB_HOME_CSS = [
'.wb-home{position:relative;height:100%;overflow:auto;box-sizing:border-box;padding:20px 0 48px;color:var(--text-color);font-size:13px;user-select:none;}',
'.wb-home.wb-home-panel{position:absolute;inset:var(--wb-bar,35px) 0 0 0;height:auto;padding:28px 32px 48px;}',
'.wb-home .wb-hhead{display:flex;align-items:center;gap:10px;margin-bottom:24px;}',
'.wb-home .wb-htitle{font-size:20px;font-weight:600;flex:1 1 auto;min-width:0;}',
'.wb-home .wb-hbtn{display:inline-flex;align-items:center;gap:8px;height:30px;padding:0 12px;box-sizing:border-box;border-radius:var(--radius-normal,3px);border:1px solid color-mix(in srgb,var(--text-color) 22%,transparent);color:var(--text-color);cursor:pointer;white-space:nowrap;}',
'.wb-home .wb-hbtn:hover{filter:brightness(1.18);}',
'.wb-home .wb-hbtn svg{width:14px;height:14px;}',
'.wb-home .wb-hbtn .wb-hdim{color:var(--color-text-700,#8a8a8a);}',
'.wb-home .wb-hbtn.wb-hprimary{background:var(--ed-button-primary-bg,#3aa37f);border-color:transparent;color:#fff;font-weight:600;}',
'.wb-home .wb-hgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:28px 24px;}',
'.wb-home .wb-htile{display:flex;flex-direction:column;gap:10px;cursor:pointer;min-width:0;}',
'.wb-home .wb-hpic{position:relative;aspect-ratio:4 / 3;border-radius:var(--radius-normal,3px);border:1px solid color-mix(in srgb,var(--text-color) 14%,transparent);overflow:hidden;background:var(--cards-bg,rgba(127,127,127,.08));}',
'.wb-home .wb-hpic canvas{display:block;width:100%;height:100%;}',
'.wb-home .wb-htile:hover .wb-hpic{filter:brightness(1.15);border-color:color-mix(in srgb,var(--text-color) 30%,transparent);}',
'.wb-home .wb-hmore{position:absolute;top:8px;right:8px;width:26px;height:26px;display:flex;align-items:center;justify-content:center;border-radius:var(--radius-normal,3px);background:var(--cmdpal-bg-color,#212126);border:1px solid color-mix(in srgb,var(--text-color) 18%,transparent);color:var(--text-color);opacity:0;}',
'.wb-home .wb-hmore svg{width:16px;height:16px;}',
'.wb-home .wb-htile:hover .wb-hmore{opacity:1;}',
'@media (pointer:coarse){.wb-home .wb-hmore{opacity:1;}}',
'.wb-home .wb-hname{font-size:14px;font-weight:600;line-height:1.35;overflow-wrap:anywhere;}',
'.wb-home .wb-hsub{font-size:12px;color:var(--color-text-700,#8a8a8a);margin-top:-6px;display:flex;align-items:center;gap:6px;min-width:0;}',
'.wb-home .wb-hsub .ti{font-size:13px;}',
'.wb-home .wb-hempty{color:var(--color-text-700,#8a8a8a);padding:40px 0;}',
].join('\n');
function wbWhen(d) {
	if (!d || isNaN(d.getTime())) return '';
	const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); const diff = Math.round((day(new Date()) - day(d)) / 86400000);
	if (diff === 0) return 'Today'; if (diff === 1) return 'Yesterday';
	const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	return M[d.getMonth()] + ' ' + d.getDate() + (d.getFullYear() === new Date().getFullYear() ? '' : ', ' + d.getFullYear());
}
const WB_HOME_SORTS = [{ v: 'opened', label: 'Last opened' }, { v: 'updated', label: 'Last changed' }, { v: 'name', label: 'Name' }];
Object.assign(Plugin.prototype, {
	homeOpened() { try { return JSON.parse(localStorage.getItem('wb_opened') || '{}') || {}; } catch (e) { return {}; } },
	homeNoteOpened(guid) { try { const m = this.homeOpened(); m[guid] = Date.now(); localStorage.setItem('wb_opened', JSON.stringify(m)); } catch (e) {} },
	// the scene a tile is drawn from: what this session already holds, else the saved file (read only, no recovery logic)
	async homeScene(rec) {
		this._homeScenes = this._homeScenes || new Map(); const rev = this.serverRev(rec); const hit = this._homeScenes.get(rec.guid);
		const mem = WB_CACHE.get(rec.guid); if (mem && mem.json && (mem.rev || 0) >= rev) { try { return JSON.parse(mem.json); } catch (e) {} }
		if (hit && hit.rev === rev) return hit.scene;
		let scene = null; try { const p = rec.prop(WB_F.scene.label); const blob = p ? await p.fileBlob() : null; const ab = blob ? await blob.download() : null; if (ab) { const x = JSON.parse(new TextDecoder().decode(ab)); if (x && Array.isArray(x.nodes)) scene = x; } } catch (e) {}
		if (scene) this._homeScenes.set(rec.guid, { rev, scene }); return scene;
	},
	// One boards page in `el`. Returns { refresh, destroy }. `panel` is where a board opens (null = the active panel).
	renderHome(el, panel, inPanel) {
		const gen = WB_GEN; let dead = false, t = null, given = null; // given = the rows Thymer's own view hands over, already filtered by its search box
		const root = wbEl('div', 'wb-home' + (inPanel ? ' wb-home-panel' : '')); el.appendChild(root);
		root.addEventListener('pointerdown', (e) => e.stopPropagation());
		const open = (rec, e) => { if (e && (e.metaKey || e.ctrlKey)) { Promise.resolve(this.ui.createPanel(panel ? { afterPanel: panel } : undefined)).then((p) => { if (p) this.openBoard(rec.guid, p); }); return; } this.openBoard(rec.guid, panel || null); };
		const paint = async () => {
			if (dead || gen !== window.__wbGen) return;
			let recs = given;
			// a custom view can sit on an empty snapshot for ever (playbook, 2026-09-19): an empty hand-over with nothing typed in the filter box is not believed
			if (!recs || (!recs.length && !((el.closest('.panel') || document).querySelector('input.is-collection-filter') || {}).value)) recs = await this.allBoards();
			if (dead) return;
			let sort = 'opened'; try { sort = localStorage.getItem('wb_home_sort') || 'opened'; } catch (e) {}
			// In the collection view the panel is in Thymer's own wide layout (homeView asks for it), so the filter field above runs
			// edge to edge too; our sides carry no padding there, which keeps the tiles in line with that field.
			const opened = this.homeOpened(); const upd = (r) => { try { const d = r.getUpdatedAt(); return d ? d.getTime() : 0; } catch (e) { return 0; } };
			// the rows Thymer hands a view are already in the VIEW's own sort (his point, 2026-09-20): no second sort on top of it
			const list = recs === given ? recs.slice() : recs.slice().sort((a, b) => sort === 'name' ? (a.getName() || '').localeCompare(b.getName() || '') : sort === 'updated' ? upd(b) - upd(a) : (opened[b.guid] || upd(b)) - (opened[a.guid] || upd(a)));
			const top = root.scrollTop; root.innerHTML = '';
			const head = wbEl('div', 'wb-hhead'); head.appendChild(wbEl('div', 'wb-htitle', 'Boards')); // only in the panel: the collection view carries Thymer's own title, New Board and sort
			const cur = WB_HOME_SORTS.find((x) => x.v === sort) || WB_HOME_SORTS[0];
			const sortBtn = wbEl('div', 'wb-hbtn', '<span class="wb-hdim">Sort by</span><span>' + cur.label + '</span>'); sortBtn.setAttribute('role', 'button');
			sortBtn.addEventListener('click', (e) => { e.stopPropagation(); wbMenu(sortBtn, WB_HOME_SORTS, sort, (v) => { try { localStorage.setItem('wb_home_sort', v); } catch (x) {} paint(); }, { width: 180, dots: false, alignRight: true }); });
			const add = wbEl('div', 'wb-hbtn wb-hprimary', WB_I.plus + '<span>New Board</span>'); add.setAttribute('role', 'button'); add.addEventListener('click', (e) => { e.stopPropagation(); this.newBoard(); });
			if (inPanel) { head.appendChild(sortBtn); head.appendChild(add); root.appendChild(head); }
			if (!list.length) { root.appendChild(wbEl('div', 'wb-hempty', given ? 'No boards match.' : 'No boards yet.')); return; }
			const grid = wbEl('div', 'wb-hgrid');
			for (const rec of list) {
				const tile = wbEl('div', 'wb-htile'); tile.setAttribute('role', 'button'); tile.addEventListener('click', (e) => open(rec, e));
				const pic = wbEl('div', 'wb-hpic'); const cv = document.createElement('canvas'); cv.width = 640; cv.height = 480; pic.appendChild(cv);
				const more = wbEl('div', 'wb-hmore', WB_I.more); more.title = 'Options'; more.setAttribute('role', 'button');
				more.addEventListener('click', (e) => { e.stopPropagation(); this.homeTileMenu(more, rec, open, paint); });
				pic.appendChild(more); tile.appendChild(pic);
				tile.appendChild(wbEl('div', 'wb-hname', wbEsc(rec.getName() || 'Untitled board')));
				let when = ''; try { when = wbWhen(rec.getUpdatedAt()); } catch (e) {}
				const pages = this.boardPages(rec); const pg = pages[0]; let pgIcon = 'ti-file-text'; try { pgIcon = wbTi(pg && pg.getIcon && pg.getIcon(true), 'ti-file-text'); } catch (e) {}
				tile.appendChild(wbEl('div', 'wb-hsub', '<span>' + wbEsc(when) + '</span>' + (pg ? '<span class="ti ' + wbEsc(pgIcon) + '"></span><span>' + wbEsc((pg.getName() || 'Untitled') + (pages.length > 1 ? ' +' + (pages.length - 1) : '')) + '</span>' : '')));
				grid.appendChild(tile);
				this.homeScene(rec).then((scene) => { if (!dead && scene && cv.isConnected) { try { wbPaintScene(cv, scene); } catch (e) {} } });
			}
			root.appendChild(grid); root.scrollTop = top;
		};
		paint();
		return { refresh: (records) => { if (Array.isArray(records)) given = records; clearTimeout(t); t = setTimeout(paint, 250); }, destroy: () => { dead = true; clearTimeout(t); root.remove(); } };
	},
	homeTileMenu(anchor, rec, open, repaint) {
		wbMenu(anchor, [{ v: 'open', label: 'Open', icon: 'ti-layout-board' }, { v: 'beside', label: 'Open in a new panel', icon: 'ti-layout-columns' }, { sep: true }, { v: 'rename', label: 'Rename', icon: 'ti-pencil' }, { v: 'trash', label: 'Move to trash', icon: 'ti-trash' }], null, (v) => {
			if (v === 'open') open(rec, null); else if (v === 'beside') open(rec, { metaKey: true });
			else if (v === 'rename') setTimeout(() => this.homeRename(anchor, rec, repaint), 0);
			else if (v === 'trash') setTimeout(() => this.homeTrash(anchor, rec, repaint), 0);
		}, { width: 220, dots: false, checks: false, alignRight: true });
	},
	homePop(anchor, pop) {
		this.closeMenus(); pop.addEventListener('pointerdown', (e) => e.stopPropagation()); document.body.appendChild(pop); this._pop = pop;
		const r = anchor.getBoundingClientRect(); pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px'; pop.style.top = Math.min(r.bottom + 6, window.innerHeight - pop.offsetHeight - 8) + 'px';
		const out = (e) => { if (!pop.contains(e.target)) this.closeMenus(); }; document.addEventListener('pointerdown', out, true); pop._out = out;
	},
	homeRename(anchor, rec, repaint) {
		const pop = wbEl('div', 'wb-rename'); const inp = document.createElement('input'); inp.value = rec.getName() || ''; inp.placeholder = 'Board name';
		for (const ev of ['keypress', 'keyup']) inp.addEventListener(ev, (e) => e.stopPropagation());
		inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key !== 'Enter') return; e.preventDefault(); const v = inp.value.trim(); this.closeMenus(); if (v && v !== rec.getName()) { try { const t = rec.prop('Title'); if (t) t.set(v); } catch (x) {} setTimeout(repaint, 400); } });
		pop.appendChild(inp); this.homePop(anchor, pop); setTimeout(() => { inp.focus(); inp.select(); }, 0);
	},
	homeTrash(anchor, rec, repaint) {
		const pop = wbEl('div', 'wb-confirm'); pop.appendChild(wbEl('div', '', 'Move <b>' + wbEsc(rec.getName() || 'this board') + '</b> to the trash? It can be restored from Thymer\'s trash.'));
		const btns = wbEl('div', 'wb-cbtns'); const mk = (label, cls, fn) => { const x = wbEl('div', 'wb-cbtn ' + (cls || ''), label); x.addEventListener('click', (e) => { e.stopPropagation(); this.closeMenus(); fn(); }); btns.appendChild(x); };
		mk('Cancel', '', () => {}); mk('Move to trash', 'wb-primary', () => { try { rec.trash(); } catch (e) { this.toast('Could not move the board to the trash.'); } setTimeout(repaint, 500); });
		pop.appendChild(btns); this.homePop(anchor, pop);
	},
	// Closing a board used to leave Thymer's empty start view when it was the last panel (his recording 2026-09-20). Now the
	// boards page opens in its place. Only a BOARD's panel counts (the boards page itself and the note editor's panel close for
	// real), and only when nothing else is open: with a second panel beside it, closing a board just closes it.
	onPanelClosed(panel) {
		if (!panel) return; let pid = null; try { pid = panel.getId(); } catch (e) { return; }
		const b = this.boards.get(pid); if (!b) return;
		try { b.destroy(); } catch (e) {} this.boards.delete(pid); try { localStorage.removeItem('wb_panel_' + pid); } catch (e) {}
		setTimeout(async () => {
			if (WB_GEN !== window.__wbGen) return;
			let left = []; try { left = (this.ui.getPanels() || []).filter((p) => { try { return !p.isSidebar(); } catch (e) { return true; } }); } catch (e) {}
			// Thymer keeps ONE panel of type 'empty' when the last one closes (measured): that is the start view he landed on, and it is the panel we fill
			const isEmpty = (p) => { try { return p.getType() === 'empty'; } catch (e) { return false; } };
			if (left.some((p) => !isEmpty(p))) return;
			this._homeNext = true; let p = left[0] || null; if (!p) { try { p = await this.ui.createPanel(); } catch (e) {} }
			if (!p) { this._homeNext = false; return; }
			p.navigateToCustomType(WB_PANEL); try { this.ui.setActivePanel(p); } catch (e) {}
		}, 80);
	},
	// the hooks the collection's stub asks for, one set per open view
	homeView(ctx) {
		let home = null, fed = false, dead = false;
		// MEASURED 2026-09-20: a freshly mounted custom view is handed NOTHING (no onRefresh, ctx.getAllRecords() empty) until
		// something makes Thymer refresh it, and its toolbar shows a sort the configuration never chose ("Sub-page of"). Setting
		// the sort the configuration DOES hold, through the context, is Thymer's own refresh path: the label turns right and the
		// rows arrive in that order. Without it the tiles came from the fallback in our own order and "the view's sort did nothing".
		const kick = async (n) => {
			if (dead || fed || n > 5) return;
			try { const col = await this.boardsCollection(false); const v = col && (col.getConfiguration().views || []).find((x) => x.id === WB_HOME_VIEW.id); if (v && v.sort_field_id && !dead && !fed) ctx.setSortColumn(v.sort_field_id, v.sort_dir || 'asc'); } catch (e) {}
			setTimeout(() => kick(n + 1), 700);
		};
		return {
			onLoad: () => { const el = ctx.getElement(); if (!el) return; el.innerHTML = ''; try { ctx.makeWideLayout(); } catch (e) {} home = this.renderHome(el, null, false); setTimeout(() => kick(0), 400); },
			onRefresh: (a) => { if (a && Array.isArray(a.records) && a.records.length) fed = true; if (home) home.refresh(a && a.records); },
			onPanelResize: () => {}, onFocus: () => {}, onBlur: () => {}, onKeyboardNavigation: () => {},
			onDestroy: () => { dead = true; if (home) home.destroy(); home = null; },
		};
	},
	// Writes the view entry and the stub into the Boards collection, once. It never touches a collection that carries code
	// of its own, and it re-reads the configuration right before writing (the fields check saves the same object at load).
	async ensureHomeView() {
		const col = await this.boardsCollection(false); if (!col || WB_GEN !== window.__wbGen) return;
		let api = null; try { api = this.data.getPluginByGuid(col.getGuid()); } catch (e) {} if (!api || !api.saveCode) return;
		let code = ''; try { code = (api.getExistingCodeAndConfig() || {}).code || ''; } catch (e) { return; }
		const ours = code.indexOf('Whiteboard boards-view stub v') >= 0; const blank = !code.trim() || (code.length < 200 && code.indexOf('Put your custom code here') >= 0);
		if (!ours && !blank) { console.warn('[Whiteboard] the Boards collection has code of its own; the Boards view was not installed'); return; }
		const conf = col.getConfiguration(); conf.views = conf.views || [];
		const have = conf.views.find((v) => v.id === WB_HOME_VIEW.id);
		// a view without a sort of its own shows a label nobody chose; undefined = never set (null is HIS "Custom Order" and stays)
		if (have && have.sort_field_id === undefined) { have.sort_field_id = 'updated_at'; have.sort_dir = 'desc'; await col.saveConfiguration(conf); await wbSleep(600); console.log('[Whiteboard] gave the Boards view a sort of its own (Modified, newest first)'); }
		if (!have) { conf.views.unshift({ id: WB_HOME_VIEW.id, type: 'custom', icon: 'ti-layout-grid', label: WB_HOME_VIEW.label, description: '', read_only: false, shown: true, sort_field_id: 'updated_at', sort_dir: 'desc' }); await col.saveConfiguration(conf); await wbSleep(600); console.log('[Whiteboard] added the Boards view to the Boards collection'); }
		if (code.indexOf('boards-view stub v' + WB_STUB_VERSION + ',') < 0) { await Promise.resolve(api.saveCode(WB_STUB_SRC)); console.log('[Whiteboard] stub v' + WB_STUB_VERSION + ' written to the Boards collection'); }
	},
});
{
	const basePluginOnLoadHome = Plugin.prototype.onLoad;
	Plugin.prototype.onLoad = function () {
		basePluginOnLoadHome.call(this); this.ui.injectCSS(WB_HOME_CSS);
		try { this._evIds.push(this.events.on('panel.closed', (ev) => this.onPanelClosed(ev && ev.panel))); } catch (e) {}
		window.__wbHome = { owner: this, stub: WB_STUB_VERSION, view: (ctx) => this.homeView(ctx) };
		try { window.dispatchEvent(new Event('whiteboard:ready')); } catch (e) {}
		setTimeout(() => { this.ensureHomeView().catch((e) => console.warn('[Whiteboard] ensureHomeView', e)); }, 3000);
	};
	const basePluginOnUnloadHome = Plugin.prototype.onUnload;
	Plugin.prototype.onUnload = function () {
		if (window.__wbHome && window.__wbHome.owner === this) { window.__wbHome = undefined; try { window.dispatchEvent(new Event('whiteboard:off')); } catch (e) {} }
		return basePluginOnUnloadHome.call(this);
	};
	const baseOpenBoardHome = Plugin.prototype.openBoard;
	Plugin.prototype.openBoard = function (guid, panel) { this.homeNoteOpened(guid); return baseOpenBoardHome.call(this, guid, panel); };
}

// ===========================================================================
// Touch (his ask 2026-09-20, design: Whiteboard Mobile canvas). Everything here is gated on pointerType === 'touch' or the
// wb-touch class, so a mouse keeps every behaviour it had. Phase 1: a pointer registry, two-finger pinch (zoom about the
// midpoint plus pan), one finger on empty canvas pans, a still long-press opens the Selection menu, a double tap (or a tap
// on the element already selected) edits, and every handle, dot and plus grows to a finger's size. Phase 0 rides along:
// "Copy diagnostics" in the board menu puts the device facts and the last input events on the clipboard for the phone.
// ===========================================================================
const WB_TOUCH_CSS = [
'.wb-host.wb-touch .wb-canvas{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;}',
'.wb-host.wb-touch .wb-handle{width:16px;height:16px;margin:-8px 0 0 -8px;border-width:2px;}',
'.wb-host.wb-touch .wb-dot{width:22px;height:22px;margin:-11px 0 0 -11px;border-width:2px;display:flex;align-items:center;justify-content:center;}',
'.wb-host.wb-touch .wb-dot::after{content:"+";font-size:16px;line-height:1;font-weight:600;color:var(--wb-bg);}', // tap = a connected copy on that side, drag = a line; the glyph says so
'.wb-host.wb-touch .wb-epoint{width:22px;height:22px;margin:-11px 0 0 -11px;}',
'.wb-host.wb-touch .wb-eadd{width:18px;height:18px;margin:-9px 0 0 -9px;opacity:.5;}',
'.wb-host.wb-touch .wb-mmplus{width:32px;height:32px;border-radius:16px;}.wb-host.wb-touch .wb-mmplus svg{width:14px;height:14px;}',
'.wb-host.wb-touch .wb-tool{width:44px;height:44px;}.wb-host.wb-touch .wb-rail{width:52px;}',
'.wb-host.wb-touch .wb-tb{height:40px;min-width:40px;}',
'.wb-diag{position:fixed;z-index:100003;width:min(520px,calc(100vw - 24px));padding:10px;display:flex;flex-direction:column;gap:8px;background:var(--wb-surface,var(--cmdpal-bg-color,#212126));border:1px solid var(--wb-line,rgba(196,196,196,.14));border-radius:var(--radius-normal,3px);box-shadow:var(--wb-shadow,0 8px 28px rgba(0,0,0,.35));}',
'.wb-diag textarea{width:100%;box-sizing:border-box;height:220px;resize:vertical;background:transparent;color:var(--text-color);border:1px solid var(--wb-line,rgba(196,196,196,.14));border-radius:var(--radius-normal,3px);font:inherit;font-size:11px;padding:6px 8px;outline:none;}',
'.wb-diag .wb-diagrow{display:flex;justify-content:flex-end;gap:10px;}',
].join('\n');
function wbTouchUI() {
	try { if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return true; } catch (e) {}
	try { const m = document.documentElement.dataset.mobileType; if (m === 'phone' || m === 'tablet') return true; } catch (e) {}
	return false;
}
const WB_TAP_MS = 350, WB_TAP_PX = 24, WB_HOLD_MS = 400, WB_HOLD_PX = 8;
{
	const baseBindInput = WbBoard.prototype.bindInput;
	WbBoard.prototype.bindInput = function () {
		this.pointers = new Map(); this._diag = []; this.pinch = null; this._lastTap = null; this._hold = null;
		if (wbTouchUI()) this.host.classList.add('wb-touch');
		baseBindInput.call(this);
		// A finger's lift can land on an element that stops propagation (a toolbar, a note editor), and then the canvas never
		// hears it: the pointer stayed in the registry and pinchRest stayed on, which swallowed every touch until the next
		// full lift (measured with synthetic events). So the registry is settled at DOCUMENT level, capture phase, before
		// anything else can eat the event; onUp only reads what is left.
		const settle = (e) => { if (WB_GEN !== window.__wbGen || this.destroyed || e.pointerType !== 'touch') return; this.pointers.delete(e.pointerId); if (this.pinch && this.pinch.ids.includes(e.pointerId)) this.pinchEnd(); if (![...this.pointers.values()].some((p) => p.type === 'touch')) { this.pinchRest = false; this.holdCancel(); } };
		for (const ev of ['pointerup', 'pointercancel']) { document.addEventListener(ev, settle, true); const off = () => document.removeEventListener(ev, settle, true); this.disposers.push(off); WB_LISTENERS.push(off); }
	};
	// a ring of the last input events, so the phone can tell us what it actually delivered
	WbBoard.prototype.diagNote = function (e, what) {
		try { const t = e.target; const cls = t && t.className && typeof t.className === 'string' ? t.className.split(' ').slice(0, 2).join('.') : (t && t.tagName) || ''; this._diag.push(Math.round(performance.now()) + ' ' + (what || e.type) + ' ' + (e.pointerType || '') + (e.isPrimary === false ? ' 2nd' : '') + ' #' + e.pointerId + ' ' + Math.round(e.clientX) + ',' + Math.round(e.clientY) + ' ' + cls); if (this._diag.length > 40) this._diag.shift(); } catch (x) {}
	};
	WbBoard.prototype.diagnostics = function () {
		const L = []; const vv = window.visualViewport; const hr = this.host.getBoundingClientRect(); const cr = this.canvas.getBoundingClientRect();
		L.push('Whiteboard diagnostics ' + new Date().toISOString() + ' gen ' + (window.__wbGen || 0));
		L.push('ua ' + navigator.userAgent);
		L.push('window ' + window.innerWidth + 'x' + window.innerHeight + ' dpr ' + window.devicePixelRatio + ' visualViewport ' + (vv ? Math.round(vv.width) + 'x' + Math.round(vv.height) + ' scale ' + vv.scale + ' offset ' + Math.round(vv.offsetLeft) + ',' + Math.round(vv.offsetTop) : 'none'));
		L.push('mobileType ' + (document.documentElement.dataset.mobileType || 'unset') + ' maxTouchPoints ' + navigator.maxTouchPoints + ' coarse ' + (window.matchMedia ? window.matchMedia('(pointer: coarse)').matches : '?') + ' hoverNone ' + (window.matchMedia ? window.matchMedia('(hover: none)').matches : '?') + ' touchClass ' + this.host.classList.contains('wb-touch'));
		L.push('host ' + Math.round(hr.left) + ',' + Math.round(hr.top) + ' ' + Math.round(hr.width) + 'x' + Math.round(hr.height) + ' canvas ' + Math.round(cr.left) + ',' + Math.round(cr.top) + ' ' + Math.round(cr.width) + 'x' + Math.round(cr.height) + ' bar ' + this.host.style.getPropertyValue('--wb-bar'));
		const root = this.host.closest('.panel'); const bar = root && root.querySelector('.panel-bar--tabsbar'); const br = bar && bar.getBoundingClientRect();
		L.push('panelBar ' + (bar ? Math.round(br.width) + 'x' + Math.round(br.height) + ' at ' + Math.round(br.top) : 'none') + ' panels ' + document.querySelectorAll('.panel').length + ' cam ' + Math.round(this.cam.x) + ',' + Math.round(this.cam.y) + ' z ' + this.cam.z.toFixed(2) + ' nodes ' + this.scene.nodes.length);
		const st = wbSyncStatus();
		L.push('save ' + (this.saveState || 'clean') + ' dirty ' + !!this.dirty + ' knownRev ' + this.knownRev + ' | sync ready ' + wbSyncReady() + ' why ' + (WB_SYNC.why || '-') + ' hook ' + (WB_SYNC.hookGen === WB_GEN) + ' processedAgo ' + (WB_SYNC.processedAt ? Math.round((Date.now() - WB_SYNC.processedAt) / 1000) + 's' : 'never') + ' onLine ' + navigator.onLine + ' | status ' + (st ? 'online ' + st.isOnline + ' ws ' + st.hasWebsocket + ' syncing ' + st.isSyncing + ' reply ' + (st.lastSyncReplyTime ? 'yes' : 'no') : 'none'));
		L.push('mount trace (newest last):'); for (const x of wbTraceRead()) L.push('  ' + x);
		L.push('events (newest last):'); for (const x of this._diag) L.push('  ' + x);
		return L.join('\n');
	};
	WbBoard.prototype.copyDiagnostics = function (anchor) {
		const txt = this.diagnostics();
		const show = () => {
			this.plugin.closeMenus(); const pop = wbEl('div', 'wb-diag'); pop.addEventListener('pointerdown', (e) => e.stopPropagation());
			const ta = document.createElement('textarea'); ta.value = txt; ta.readOnly = true; ta.addEventListener('keydown', (e) => e.stopPropagation()); pop.appendChild(ta);
			const rowEl = wbEl('div', 'wb-diagrow'); const close = wbEl('span', 'wb-taglink', 'Close'); close.addEventListener('click', () => this.plugin.closeMenus()); rowEl.appendChild(close); pop.appendChild(rowEl);
			document.body.appendChild(pop); this.plugin._pop = pop; const r = anchor.getBoundingClientRect(); pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px'; pop.style.top = Math.min(r.bottom + 4, window.innerHeight - pop.offsetHeight - 8) + 'px';
			const out = (e) => { if (!pop.contains(e.target)) this.plugin.closeMenus(); }; document.addEventListener('pointerdown', out, true); pop._out = out;
			setTimeout(() => { ta.focus(); ta.select(); }, 0);
		};
		if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(() => this.plugin.toast('Diagnostics copied. Paste them to Claude.'), show);
		else show();
	};
	// --- pinch: two touch pointers zoom about their midpoint and pan with it ---
	WbBoard.prototype.touchOf = function (e) { return e.pointerType === 'touch'; };
	WbBoard.prototype.pinchBegin = function (e) {
		const ids = [...this.pointers.keys()].filter((id) => this.pointers.get(id).type === 'touch').slice(-2); if (ids.length < 2) return false;
		if (this.drag) { const d = this.drag; if (d.kind === 'move' && d.orig) d.items.forEach((n, i) => { const o = d.orig[i]; if (o) { n.x = o.x; n.y = o.y; } }); try { this.canvas.releasePointerCapture(d.pid); } catch (x) {} this.drag = null; this.canvas.classList.remove('wb-panning'); this.renderAll(); }
		this.holdCancel();
		const a = this.pointers.get(ids[0]), b = this.pointers.get(ids[1]);
		this.pinch = { ids, dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }; this._pinchIds = ids.slice();
		for (const id of ids) { try { this.canvas.setPointerCapture(id); } catch (x) {} }
		return true;
	};
	WbBoard.prototype.pinchMove = function () {
		const p = this.pinch; const a = this.pointers.get(p.ids[0]), b = this.pointers.get(p.ids[1]); if (!a || !b) return;
		const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1; const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
		const r = this.canvas.getBoundingClientRect(); const f = dist / p.dist;
		if (Math.abs(f - 1) > 0.002) this.zoomAt(mid.x - r.left, mid.y - r.top, f);
		this.cam.x += mid.x - p.mid.x; this.cam.y += mid.y - p.mid.y; this.applyCamera();
		p.dist = dist; p.mid = mid;
	};
	WbBoard.prototype.pinchEnd = function () { this._pinchIds = this.pinch ? this.pinch.ids.slice() : this._pinchIds; this.pinch = null; this.pinchRest = true; }; // the finger still down must not start a drag
	// --- long-press: still for 400 ms on an element opens its Selection menu ---
	WbBoard.prototype.holdCancel = function () { if (this._hold) { clearTimeout(this._hold.t); this._hold = null; } };
	WbBoard.prototype.holdArm = function (e, n) {
		this.holdCancel(); const x = e.clientX, y = e.clientY;
		this._hold = { x, y, t: setTimeout(() => {
			this._hold = null; if (this.destroyed || this.pinch) return;
			const d = this.drag; if (d) { if (d.kind === 'move' && d.orig) d.items.forEach((q, i) => { const o = d.orig[i]; if (o) { q.x = o.x; q.y = o.y; } }); try { this.canvas.releasePointerCapture(d.pid); } catch (x2) {} this.drag = null; this.canvas.classList.remove('wb-panning'); }
			if (!this.selected.has(n.id)) { this.selected = new Set([n.id]); this.selectedEdge = null; }
			this.renderAll(); this.buildCtx(); this._heldTap = true;
			const el = this.nodeEls.get(n.id) || this.canvas; const sel = [...this.selected].map((id) => this.nodeById(id)).filter(Boolean);
			if (this.selectionMenu) this.selectionMenu(el, sel);
		}, WB_HOLD_MS) };
	};
	const baseOnDown = WbBoard.prototype.onDown;
	WbBoard.prototype.onDown = function (e) {
		this.diagNote(e);
		if (this.touchOf(e)) {
			this.host.classList.add('wb-touch');
			this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: 'touch' });
			const touches = [...this.pointers.values()].filter((p) => p.type === 'touch').length;
			if (touches === 1 && !this.pinchRest) this._pinchIds = null;
			if (touches >= 2) { if (!this.pinch) this.pinchBegin(e); e.preventDefault(); return; }
			if (this.pinchRest) { e.preventDefault(); return; }
			const t = e.target; const hit = this.hitNode(e);
			// A frame that is not selected counts as empty canvas under a finger: his boards live inside big frames, and a mouse's
			// "drag the frame to move it" would leave no way to pan at all. Tap selects the frame, and only a selected frame moves.
			const looseFrame = !!(hit && hit.type === 'frame' && !(this.selected.size === 1 && this.selected.has(hit.id)));
			const onThing = !looseFrame && !!(t && t.closest && (t.closest('.wb-node') || t.closest('g[data-id]') || (t.dataset && (t.dataset.handle || t.dataset.side || t.dataset.epoint != null || t.dataset.eadd != null)) || t.closest('.wb-ctx') || t.closest('.wb-rail') || t.closest('.wb-zoom') || t.closest('.wb-topbar') || t.closest('.wb-mmplus') || t.closest('.wb-mmbadge')));
			this._downWasSelected = !!(hit && this.selected.size === 1 && this.selected.has(hit.id) && !this.editing);
			this._heldTap = false; this._downFrame = looseFrame ? hit : null;
			// one finger on empty canvas pans (Select mode turns it back into a marquee); a mouse keeps its marquee
			if (!onThing && this.tool === 'select' && !this.touchSelectMode && !this.space) {
				this.plugin.closeMenus(); if (this.editing) this.commitEdit();
				e.preventDefault(); this.startDrag(e, { kind: 'pan', cx: this.cam.x, cy: this.cam.y }); this.canvas.classList.add('wb-panning');
				if (looseFrame) this.holdArm(e, hit); // a still press on the frame selects it and opens its menu
				return;
			}
			if (hit && !hit.locked && this.tool === 'select') this.holdArm(e, hit);
		}
		return baseOnDown.call(this, e);
	};
	const baseOnMove = WbBoard.prototype.onMove;
	WbBoard.prototype.onMove = function (e) {
		if (this.touchOf(e)) {
			const p = this.pointers.get(e.pointerId); if (p) { p.x = e.clientX; p.y = e.clientY; }
			if (this.pinch) { if (this.pinch.ids.includes(e.pointerId)) this.pinchMove(); return; }
			if (this.pinchRest) return;
			if (this._hold && Math.hypot(e.clientX - this._hold.x, e.clientY - this._hold.y) > WB_HOLD_PX) this.holdCancel();
		}
		return baseOnMove.call(this, e);
	};
	const baseOnUp = WbBoard.prototype.onUp;
	WbBoard.prototype.onUp = function (e, cancelled) {
		this.diagNote(e, cancelled ? 'cancel' : 'up');
		if (this.touchOf(e)) {
			this.pointers.delete(e.pointerId);
			const wasPinchFinger = this._pinchIds && this._pinchIds.includes(e.pointerId);
			if (this.pinch || wasPinchFinger || this.pinchRest) { if (this.drag) { try { this.canvas.releasePointerCapture(this.drag.pid); } catch (x) {} this.drag = null; } return; } // a pinch finger lifting is never a tap
			this.holdCancel();
			if (this._heldTap) { this._heldTap = false; this.drag = null; return; } // the long-press already acted; this lift is not a tap
			const d = this.drag; const tap = d && !d.started && !cancelled;
			const r = baseOnUp.call(this, e, cancelled);
			if (tap && this._downFrame && d.kind === 'pan') { const f = this._downFrame; this._downFrame = null; if (this.nodeById(f.id)) { this.selected = new Set([f.id]); this.selectedEdge = null; this.renderAll(); this.buildCtx(); } return r; } // a tap on a loose frame selects it
			if (tap && d.kind === 'pan' && (this.selected.size || this.selectedEdge)) { this.selected = new Set(); this.selectedEdge = null; this.renderAll(); this.buildCtx(); return r; } // a tap on empty canvas deselects (the pan branch skipped the click path that did this for a mouse)
			if (tap) {
				const now = Date.now(); const last = this._lastTap; this._lastTap = { t: now, x: e.clientX, y: e.clientY };
				const dbl = last && now - last.t < WB_TAP_MS && Math.hypot(e.clientX - last.x, e.clientY - last.y) < WB_TAP_PX;
				if (dbl || this._downWasSelected) { this._lastTap = null; this._downWasSelected = false; if (this.onDbl) this.onDbl(e); }
			}
			return r;
		}
		return baseOnUp.call(this, e, cancelled);
	};
	const basePluginOnLoadTouch = Plugin.prototype.onLoad;
	Plugin.prototype.onLoad = function () { basePluginOnLoadTouch.call(this); this.ui.injectCSS(WB_TOUCH_CSS); };
}

// ===========================================================================
// Phone chrome (phase 2 of the mobile design). Everything is ADDED under the wb-phone class and the desktop chrome is only
// hidden, never removed, so every existing lookup keeps finding its elements. The class follows Thymer's own verdict
// (html[data-mobile-type="phone"]) and is re-read on resize. The phone gets: our controls inside Thymer's own title
// strip (undo, redo, the board's name, a menu), one bottom bar (Select, Add, zoom), the Add and board menus as sheets,
// and the element toolbar docked where the bottom bar was. Thymer's Capture button is hidden while a board is open, it
// sat on top of the zoom bar.
// ===========================================================================
function wbPhoneUI() { try { return document.documentElement.dataset.mobileType === 'phone'; } catch (e) { return false; } }
const WB_PHONE_CSS = [
'.wb-host.wb-phone .wb-rail,.wb-host.wb-phone .wb-topbar,.wb-host.wb-phone .wb-zoom:not(.wb-savebar),.wb-host.wb-phone .wb-focusbar,.wb-host.wb-phone .wb-minimap,.wb-host.wb-phone .wb-cbar{display:none !important;}',
// Thymer's own Capture button is hidden while a board is open (it does nothing there) and OUR Add button takes its place and
// its look: same classes, so Thymer's stylesheet draws and places it (his ruling 2026-09-20: one button, like native, no bar).
'body.wb-phone-board .mobile-bottom-bar:not(.wb-fabbar){display:none !important;}',
'body.wb-phone-note .mobile-bottom-bar:not(.wb-donebar){display:none !important;}.wb-donebar{display:flex !important;z-index:100001;bottom:calc(var(--mobile-viewport-bottom,0px) + var(--mobile-editor-toolbar-offset,0px)) !important;}', // above Thymer's keyboard toolbar (z 9999) and lifted with the keyboard like the sheets // while a card's block is open for editing on the phone, Done replaces Thymer's Capture button
'.wb-host.wb-phone .wb-fabbar{display:flex !important;z-index:9;}.wb-host.wb-phone.wb-has-ctx .wb-fabbar{display:none !important;}',
'.wb-strip{display:flex;align-items:center;margin-left:auto;min-width:0;flex:1 1 auto;}',
'.wb-strip .wb-sb{width:44px;height:44px;display:flex;align-items:center;justify-content:center;border-radius:var(--radius-normal,3px);color:var(--text-color);flex:0 0 auto;}',
'.wb-strip .wb-sb.is-dim{opacity:.45;}.wb-strip .wb-sb svg{width:18px;height:18px;}.wb-strip .wb-sb.wb-sb-more svg{width:20px;height:20px;}',
'.wb-strip .wb-stitle{flex:1 1 auto;min-width:0;text-align:left;font-size:12px;font-weight:600;color:var(--text-color);white-space:nowrap;overflow:hidden;padding:0 4px;}', // left-aligned: a long name shows its START, a centred one lost both ends
'.wb-host.wb-phone .wb-ctx{position:fixed !important;left:calc(var(--mobile-viewport-left,0px) + 12px) !important;right:auto !important;top:auto !important;width:calc(var(--mobile-viewport-width,100vw) - 24px);bottom:calc(var(--mobile-viewport-bottom,0px) + max(12px,var(--mobile-visible-safe-area-bottom,0px))) !important;max-width:none !important;height:56px;box-sizing:border-box;padding:6px !important;flex-wrap:nowrap !important;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;z-index:100001;}',
'.wb-host.wb-phone .wb-ctx::-webkit-scrollbar{display:none;}.wb-host.wb-phone .wb-ctx .wb-tb{height:44px;min-width:44px;flex:0 0 auto;}.wb-host.wb-phone .wb-ctx .wb-tsep{height:26px;}',
// Our own popovers are placed by an anchor's rect; on the phone the anchor may be off screen or inside the overflow, so every
// one of them is pinned to the bottom as a sheet instead. A stylesheet !important beats the inline left/top they set.
'body.wb-phone-board .wb-sheet,body.wb-phone-board .wb-pop,body.wb-phone-board .wb-picker,body.wb-phone-board .wb-rename,body.wb-phone-board .wb-confirm,body.wb-phone-board .wb-diag,body.wb-phone-board .wb-thread,body.wb-phone-board .wb-dpop,body.wb-phone-board .wb-tagpop{position:fixed !important;left:var(--mobile-viewport-left,0px) !important;right:auto !important;top:auto !important;bottom:calc(var(--mobile-viewport-bottom,0px) + var(--mobile-editor-toolbar-offset,0px)) !important;width:var(--mobile-viewport-width,100vw) !important;max-width:none !important;box-sizing:border-box;padding-bottom:calc(16px + var(--mobile-visible-safe-area-bottom,0px)) !important;border-radius:var(--radius-normal,3px) var(--radius-normal,3px) 0 0 !important;border-left:0 !important;border-right:0 !important;border-bottom:0 !important;}',
'body.wb-phone-board .wb-pop{display:flex !important;flex-wrap:wrap;justify-content:center;gap:10px !important;padding:14px 12px !important;}body.wb-phone-board .wb-pop .wb-sw{width:36px;height:36px;}body.wb-phone-board .wb-pop .wb-custom{flex-basis:100%;justify-content:center;}',
// The Add sheet (design: handle, title, the sticky colours, then the tools as tiles in three columns)
'.wb-sheet{display:flex;flex-direction:column;gap:10px;padding:8px 12px 24px;background:var(--wb-surface,var(--cmdpal-bg-color,#212126));border-top:1px solid var(--wb-line);box-shadow:0 -8px 24px rgba(0,0,0,.4);z-index:100003;color:var(--wb-text);}',
'.wb-shandle{width:36px;height:4px;border-radius:2px;background:rgba(196,196,196,.25);align-self:center;flex:0 0 auto;}',
'.wb-sheet .wb-slabel{font-size:12px;color:var(--wb-muted);padding:2px 4px 0;}',
'.wb-sheet .wb-srow{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:2px 4px;margin-bottom:8px;}', // the palette is 17 colours: two rows beat a clipped one
'body.wb-phone-board .wb-sheet{padding-bottom:calc(10px + var(--mobile-visible-safe-area-bottom,0px)) !important;}',
'body.wb-phone-board .wb-host input,body.wb-phone-board .wb-host textarea,body.wb-phone-board .qb-menu input,body.wb-phone-board .wb-pop input,body.wb-phone-board .wb-picker input,body.wb-phone-board .wb-rename input,body.wb-phone-board .wb-dpop input,body.wb-phone-board .wb-thread textarea,body.wb-phone-board .wb-diag textarea,body.wb-phone-board .wb-tagpop input{font-size:16px !important;}', // iOS zooms the page for a field under 16px, and the zoom stays
'.qb-menu.qb-menu-sheet .autocomplete--option{padding-left:16px;padding-right:16px;}',
// The page picker as a phone sheet (his ask 2026-09-20: "mer luft i allt", and a search field that looks like a field, not a title)
'body.wb-phone-board .wb-picker{display:flex;flex-direction:column;gap:10px;padding:8px 12px 10px !important;}',
'body.wb-phone-board .wb-picker::before{content:"";display:block;flex:0 0 auto;width:36px;height:4px;border-radius:2px;background:rgba(196,196,196,.25);margin:0 auto 2px;}',
'body.wb-phone-board .wb-picker input{height:44px;padding:0 12px;border:1px solid var(--wb-line,rgba(196,196,196,.14));border-radius:var(--radius-normal,3px);background:rgba(196,196,196,.06);font-size:16px;margin:0;}',
'body.wb-phone-board .wb-picker input::placeholder{color:var(--wb-muted,#8a8a8a);}',
'body.wb-phone-board .wb-picker .wb-plist{max-height:50vh;display:flex;flex-direction:column;gap:2px;}',
'body.wb-phone-board .wb-picker .wb-prow{min-height:44px;height:auto;padding:0 10px;gap:12px;font-size:14px;}',
'body.wb-phone-board .wb-picker .wb-prow .ti{font-size:18px;width:22px;}',
'body.wb-phone-board .wb-picker .wb-prow .wb-plabel{text-overflow:clip;}',
'body.wb-phone-board .wb-picker .wb-prow .wb-pmeta{font-size:12px;}',
'body.wb-phone-board .wb-picker .wb-psec{font-size:11px;color:var(--wb-muted,#8a8a8a);padding:10px 10px 4px;}',
'.wb-sheet .wb-ssw{flex:0 0 22px;width:22px;height:22px;border-radius:50%;border:1px solid rgba(0,0,0,.15);box-sizing:border-box;}.wb-sheet .wb-ssw.is-on{box-shadow:0 0 0 2px var(--wb-surface,#212126),0 0 0 4px var(--wb-accent);}',
'.wb-sheet .wb-sgrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;}',
'.wb-sheet .wb-stile{height:72px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;border:1px solid var(--wb-line);border-radius:var(--radius-normal,3px);color:var(--wb-text);font-size:12px;}.wb-sheet .wb-stile svg{width:22px;height:22px;}.wb-sheet .wb-stile.is-on{background:color-mix(in srgb,var(--wb-text) 10%,transparent);}',
// every menu opened as a sheet gets the same handle and air at the top (his ask): Thymer sets padding-top 0 on its sheets
'.qb-menu.qb-menu-sheet{padding-top:8px !important;}.qb-menu.qb-menu-sheet::before{content:"";display:block;flex:0 0 auto;width:36px;height:4px;border-radius:2px;background:rgba(196,196,196,.25);margin:0 auto 6px;}',
].join('\n');
{
	const baseBindInputPhone = WbBoard.prototype.bindInput;
	WbBoard.prototype.bindInput = function () {
		baseBindInputPhone.call(this);
		this.syncPhone();
		let t = null; const onResize = () => { if (WB_GEN !== window.__wbGen || this.destroyed) return; clearTimeout(t); t = setTimeout(() => { if (!this.destroyed) this.syncPhone(); }, 120); };
		window.addEventListener('resize', onResize); const off = () => window.removeEventListener('resize', onResize); this.disposers.push(off); WB_LISTENERS.push(off);
	};
	// Thymer decides what a phone is; we follow it, and re-measure the strip our canvas sits under (it is 52px on a phone, 35 on the desktop)
	wbM.sheetDefault = () => wbPhoneUI() && document.body.classList.contains('wb-phone-board');
	WbBoard.prototype.syncPhone = function () {
		const phone = wbPhoneUI(); const was = this.host.classList.contains('wb-phone');
		this.host.classList.toggle('wb-phone', phone); this.host.classList.toggle('wb-touch', phone || wbTouchUI() || this.host.classList.contains('wb-touch'));
		this.measureChrome(); this.applyCamera();
		if (phone) { this.buildPhoneChrome(); document.body.classList.add('wb-phone-board'); }
		else if (was) { this.teardownPhoneChrome(); document.body.classList.remove('wb-phone-board'); }
		if (this.ctx) this.buildCtx();
	};
	WbBoard.prototype.phoneBtn = function (cls, html, title, fn) {
		const b = wbEl('div', cls, html); b.title = title; b.setAttribute('role', 'button'); b.setAttribute('aria-label', title);
		b.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); }); b.addEventListener('click', (e) => { e.stopPropagation(); fn(b); });
		return b;
	};
	WbBoard.prototype.buildPhoneChrome = function () {
		if (!this.pbar || !this.pbar.isConnected) {
			const bar = wbEl('div', 'mobile-bottom-bar wb-fabbar'); bar.addEventListener('pointerdown', (e) => e.stopPropagation());
			const grp = wbEl('div', 'mobile-bottom-bar--group');
			const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'mobile-bottom-bar--btn mobile-bottom-bar--primary'; btn.setAttribute('aria-label', 'Add');
			btn.innerHTML = '<span class="ti ti-plus"></span><span class="mobile-bottom-bar--label">Add</span>';
			btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); this.phoneAddSheet(btn); });
			grp.appendChild(btn); bar.appendChild(grp); this.host.appendChild(bar); this.pbar = bar;
		}
		// our controls inside Thymer's own strip, after its round buttons
		const root = this.host.closest('.panel'); const tabsbar = root && root.querySelector('.panel-bar--tabsbar');
		// one strip per panel, whatever mounted before us: a strip left by an earlier instance of this board (a reload, a
		// re-mount) is swept out, and our own is moved rather than rebuilt when Thymer has replaced the bar element
		if (root) for (const old of root.querySelectorAll('.wb-strip')) if (old !== this.strip) old.remove();
		if (tabsbar && this.strip && this.strip.isConnected && this.strip.parentNode !== tabsbar) tabsbar.appendChild(this.strip);
		if (tabsbar && !(this.strip && this.strip.isConnected && this.strip.parentNode === tabsbar)) {
			if (this.strip) this.strip.remove();
			const st = wbEl('div', 'wb-strip'); st.addEventListener('pointerdown', (e) => e.stopPropagation());
			this.sUndo = this.phoneBtn('wb-sb', WB_SVG('<path d="M9 14 4 9l5-5"></path><path d="M4 9h10a6 6 0 0 1 0 12h-3"></path>'), 'Undo', () => { this.undoOnce(); this.paintStrip(); });
			this.sRedo = this.phoneBtn('wb-sb', WB_SVG('<path d="m15 14 5-5-5-5"></path><path d="M20 9H10a6 6 0 0 0 0 12h3"></path>'), 'Redo', () => { this.redoOnce(); this.paintStrip(); });
			this.sTitle = wbEl('div', 'wb-stitle');
			st.appendChild(this.sUndo); st.appendChild(this.sRedo); st.appendChild(this.sTitle);
			st.appendChild(this.phoneBtn('wb-sb wb-sb-more', WB_I.more, 'Board menu', (b) => this.phoneMoreSheet(b)));
			tabsbar.appendChild(st); this.strip = st;
		}
		this.paintStrip();
	};
	WbBoard.prototype.paintStrip = function () {
		if (this.sTitle) { let name = ''; try { name = this.rec.getName() || 'Board'; } catch (e) { name = 'Board'; } this.sTitle.textContent = name; }
		if (this.sUndo) this.sUndo.classList.toggle('is-dim', !this.undo.length);
		if (this.sRedo) this.sRedo.classList.toggle('is-dim', !this.redo.length);
	};
	WbBoard.prototype.teardownPhoneChrome = function () { if (this.pbar) { this.pbar.remove(); this.pbar = null; } if (this.strip) { this.strip.remove(); this.strip = null; } try { const root = this.host.closest('.panel'); if (root) for (const old of root.querySelectorAll('.wb-strip')) old.remove(); } catch (e) {} };
	// The Add sheet, as designed: a handle, a title, the sticky colours, then the tools as tiles. Sticky, text and shape land in
	// the middle of the view at once, the rest arm their tool. An own element rather than the shared menu, which draws lists.
	WbBoard.prototype.phoneAddSheet = function (anchor) {
		this.plugin.closeMenus();
		const pop = wbEl('div', 'wb-sheet'); pop.addEventListener('pointerdown', (e) => e.stopPropagation());
		// the sheet lives under <body>, where the board's own tokens do not reach: copy them over so borders, ring and text read right
		try { const cs = getComputedStyle(this.host); for (const v of ['--wb-line', '--wb-accent', '--wb-text', '--wb-muted', '--wb-surface']) { const val = cs.getPropertyValue(v); if (val) pop.style.setProperty(v, val); } } catch (e) {}
		pop.appendChild(wbEl('div', 'wb-shandle')); pop.appendChild(wbEl('div', 'wb-slabel', 'Add'));
		const row = wbEl('div', 'wb-srow');
		for (const c of WB_STICKY_COLORS) { const sw = wbEl('div', 'wb-ssw' + (c.id === this.stickyColor ? ' is-on' : '')); sw.style.background = c.hex; sw.title = c.id; sw.addEventListener('click', (e) => { e.stopPropagation(); this.stickyColor = c.id; this.tintStickyTool(); row.querySelectorAll('.wb-ssw').forEach((x) => x.classList.toggle('is-on', x === sw)); }); row.appendChild(sw); }
		pop.appendChild(row);
		const tools = [
			['sticky', 'Sticky', WB_I.sticky], ['text', 'Text', WB_I.text], ['shape', 'Shape', WB_SHAPE_ICON[this.shapeKind] || WB_I.shape],
			['frame', 'Frame', WB_I.frame], ['image', 'Image', WB_I.image], ['card', 'Page', WB_I.card],
			['connect', 'Connect', WB_I.connect], ['comment', 'Comment', WB_I.comment], ['mind', 'Mind map', WB_I.mind], ['stack', 'Sticky stack', WB_I.stack],
		];
		const grid = wbEl('div', 'wb-sgrid');
		for (const [v, label, svg] of tools) {
			const t = wbEl('div', 'wb-stile' + (v === this.tool && v !== 'select' ? ' is-on' : ''), svg + '<span>' + label + '</span>'); t.setAttribute('role', 'button'); t.setAttribute('aria-label', label);
			t.addEventListener('click', (e) => { e.stopPropagation(); this.plugin.closeMenus(); this.phoneAdd(v); });
			grid.appendChild(t);
		}
		pop.appendChild(grid);
		document.body.appendChild(pop); this.plugin._pop = pop;
		const out = (e) => { if (!pop.contains(e.target)) this.plugin.closeMenus(); }; document.addEventListener('pointerdown', out, true); pop._out = out;
	};
	WbBoard.prototype.phoneAdd = function (v) {
		const r = this.canvas.getBoundingClientRect(); const c = this.toWorld(r.width / 2, r.height / 2);
		if (v === 'sticky' || v === 'text' || v === 'shape') { this.setTool(v); this.createAt(v, c); this.setTool('select'); return; }
		if (v === 'mind') { this.createMindAt(c); return; }
		if (v === 'image') { this.pickImage(); return; }
		if (v === 'note') { if (this.createNoteAt) this.createNoteAt(c); return; }
		if (v === 'card') { this.openCardPicker(c.x, c.y, { x: r.left + r.width / 2, y: r.top + r.height / 2 }); return; }
		if (v === 'frame') { if (this.createFrameAt) this.createFrameAt(c); return; }
		this.setTool(v); this.plugin.toast(v === 'connect' ? 'Connect: drag from one element to another.' : v === 'comment' ? 'Comment: tap where the comment goes.' : 'Tap the board where it goes.');
	};
	// the board menu as a sheet: the pieces the hidden desktop chrome offered, spoken through their own handlers
	WbBoard.prototype.phoneMoreSheet = function (anchor) {
		const st = this.scene.settings || {}; const focusOn = !!(st.focus && st.focus.on);
		let name = 'Board'; try { name = this.rec.getName() || 'Board'; } catch (e) {}
		// No Focus mode on the phone (his call 2026-09-20: it dims everything but the tapped element and there is no way out).
		// The row only appears when focus is already ON, so a board left dimmed by the desktop can still be freed here.
		const rows = [
			{ title: name, head: true },
			{ v: 'boards', label: 'Boards', svg: WB_I.board }, { v: 'pages', label: 'Pages this board sits on', svg: WB_I.card },
			{ v: 'fit', label: 'Fit to content', svg: WB_I.fit }, { v: 'selmode', label: (this.touchSelectMode ? 'Select with one finger: on' : 'Select with one finger: off'), svg: WB_I.select }, { v: 'map', label: (this.mapOn ? 'Minimap: on' : 'Minimap: off'), svg: WB_SVG('<path d="M3 7l6-3 6 3 6-3v13l-6 3-6-3-6 3z"></path><path d="M9 4v13M15 7v13"></path>') },
		].concat(focusOn ? [{ v: 'focus', label: 'Turn focus mode off', svg: WB_I.focus }] : []).concat([
			{ sep: true },
			{ v: 'settings', label: 'Board settings', svg: WB_I.gear }, { v: 'rename', label: 'Rename board', svg: WB_I.label }, { v: 'diag', label: 'Copy diagnostics', icon: 'ti-copy' },
		]);
		wbMenu(anchor, rows, null, (v) => {
			if (v === 'boards') setTimeout(() => this.plugin.openBoardMenu(anchor, this), 0);
			else if (v === 'pages') setTimeout(() => this.pagesPicker(anchor), 0);
			else if (v === 'fit') this.fitAll();
			else if (v === 'selmode') { this.touchSelectMode = !this.touchSelectMode; this.setTool('select'); this.plugin.toast(this.touchSelectMode ? 'One finger now draws a selection box. Two fingers pan.' : 'One finger pans again.'); }
			else if (v === 'focus') { const b = this.focusBar && this.focusBar.querySelector('.wb-tb'); if (b) b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })); }
			else if (v === 'map') { if (this.mapBtn) this.mapBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })); }
			else if (v === 'settings') setTimeout(() => this.boardMenu(anchor), 0);
			else if (v === 'rename') setTimeout(() => this.renamePop(anchor), 0);
			else if (v === 'diag') this.copyDiagnostics(anchor);
		}, { width: 320, dots: false, checks: false, sheet: wbPhoneUI() });
	};
	const basePushHistoryPhone = WbBoard.prototype.pushHistory;
	WbBoard.prototype.pushHistory = function () { basePushHistoryPhone.call(this); if (this.strip) this.paintStrip(); };
	WbBoard.prototype.dockCtx = function () {
		const c = this.ctx; if (!c) return;
		const kids = [...c.children]; const del = kids.find((b) => b.title === 'Delete'); if (del) del.remove();
		const avail = window.innerWidth - 24 - 12 - 44 - 44 - 8; // gutters, padding, More, Delete, gaps (the bar is fixed to the viewport)
		let used = 0; const keep = [], over = [];
		for (const el of kids) { if (el === del) continue; const w = (el.classList.contains('wb-tsep') ? 5 : Math.max(44, el.offsetWidth || 44)) + 4; if (used + w <= avail && !over.length) { used += w; keep.push(el); } else over.push(el); }
		const overBtns = over.filter((el) => el.classList.contains('wb-tb'));
		for (const el of over) el.remove();
		while (keep.length && keep[keep.length - 1].classList.contains('wb-tsep')) { keep.pop().remove(); }
		this.ctxOverflow = overBtns;
		if (overBtns.length) { c.appendChild(this.sep()); c.appendChild(this.tb(WB_I.more, 'More', (b) => this.ctxOverflowSheet(b))); }
		if (del) { c.appendChild(this.sep()); c.appendChild(del); }
	};
	WbBoard.prototype.ctxOverflowSheet = function (anchor) {
		const rows = this.ctxOverflow.map((b, i) => { const svg = b.querySelector('svg'); const dot = b.querySelector('.wb-cdot'); const label = b.title || (b.textContent || '').trim() || 'Option'; return { v: String(i), label, svg: svg ? svg.outerHTML : (dot ? '<span class="wb-cdot" style="' + dot.getAttribute('style') + '"></span>' : WB_I.more) }; });
		wbMenu(anchor, rows, null, (v) => { const b = this.ctxOverflow[Number(v)]; if (b) setTimeout(() => b.dispatchEvent(new MouseEvent('click', { bubbles: true })), 0); }, { width: 320, dots: false, checks: false, sheet: true });
	};
	// a pencil and a plus beside the one selected element: edit, and a connected copy below (the desktop's side dots, at finger size)
	const basePlaceCtxPhone = WbBoard.prototype.placeCtx;
	WbBoard.prototype.placeCtx = function () { if (this.host.classList.contains('wb-phone')) return; return basePlaceCtxPhone.call(this); }; // the phone docks it by CSS
	const baseDestroyPhone = WbBoard.prototype.destroy;
	WbBoard.prototype.destroy = function () { try { this.teardownPhoneChrome(); document.body.classList.remove('wb-phone-board'); } catch (e) {} return baseDestroyPhone.call(this); };
	// A note card's editor is a SECOND panel, and a phone shows one: tapping Edit replaced the board with an empty panel (his
	// recording 2026-09-22). On the phone the board's own panel goes to the card's block instead (the same navigation the float
	// editor uses), and a Done button in Thymer's Capture style brings the board back through openBoard, our own proven path;
	// Thymer's Back cannot land on a custom panel. The board instance dies on the way out, so the plugin owns the button.
	const baseNoteEditPhone = WbBoard.prototype.noteEdit;
	WbBoard.prototype.noteEdit = function (n) { if (wbPhoneUI() && this.notePhoneEdit) return this.notePhoneEdit(n); return baseNoteEditPhone.call(this, n); };
	WbBoard.prototype.notePhoneEdit = async function (n) {
		if (!n || !this.isNoteNode(n)) return;
		let nv0 = null; try { nv0 = await this.noteNav(n); } catch (e) {}
		if (!nv0 || this.destroyed) { this.plugin.toast('The block behind this card is gone.'); return; }
		this.commitEdit(); this.plugin.closeMenus();
		const plugin = this.plugin, panel = this.panel, boardGuid = this.rec.guid;
		plugin.phoneNoteDoneBar(panel, boardGuid);
		try { panel.navigateTo(nv0.nav); } catch (e) { plugin.phoneNoteDoneOff(); plugin.toast('Could not open the card for editing.'); }
	};
	Plugin.prototype.phoneNoteDoneOff = function () { const d = this._phoneDone; if (!d) return; this._phoneDone = null; try { d.bar.remove(); } catch (e) {} try { this._noAuto.delete(d.boardGuid); } catch (e) {} document.body.classList.remove('wb-phone-note'); };
	Plugin.prototype.phoneNoteDoneBar = function (panel, boardGuid) {
		this.phoneNoteDoneOff();
		const bar = wbEl('div', 'mobile-bottom-bar wb-donebar'); bar.addEventListener('pointerdown', (e) => e.stopPropagation());
		const grp = wbEl('div', 'mobile-bottom-bar--group');
		const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'mobile-bottom-bar--btn mobile-bottom-bar--primary'; btn.setAttribute('aria-label', 'Done');
		btn.innerHTML = '<span class="ti ti-check"></span><span class="mobile-bottom-bar--label">Done</span>';
		// the finger's lift acts at once (a page editor can eat the click that would follow); the click stays for a mouse
		let done = false; const go = (e) => { e.stopPropagation(); e.preventDefault(); if (done) return; done = true; this.phoneNoteDoneOff(); let p = null; try { p = this.ui.getActivePanel(); } catch (e) {} if (!p || (p.isSidebar && p.isSidebar())) p = panel; this._phoneReturn = { guid: boardGuid, at: Date.now() }; this.openBoard(boardGuid, p); }; // the phone's ONE panel, asked for fresh
		btn.addEventListener('pointerup', (e) => { if (e.pointerType === 'touch') go(e); }); btn.addEventListener('click', go);
		grp.appendChild(btn); bar.appendChild(grp); document.body.appendChild(bar); document.body.classList.add('wb-phone-note');
		this._phoneDone = { bar, pid: panel.getId(), boardGuid }; this._phoneReturn = { guid: boardGuid, at: Date.now() }; // the way home, kept OFF the panel id: his phone mounted twice with no guid at all after Done (07:59:05, diagnostics), the panel handle and its id do not survive the trip there
		try { this._noAuto.add(boardGuid); } catch (e) {} // a note on "This board" lives in the BOARD's page, and a board page opens as a board: without this the navigation to the block was reverted at once (measured in the web client)
	};
	// the button goes when its panel shows anything but the card's page: the board again, another page, a closed panel
	const baseOnPanelNavigatedPhone = Plugin.prototype.onPanelNavigated;
	Plugin.prototype.onPanelNavigated = function (panel) {
		try { const d = this._phoneDone; if (d && panel && panel.getId() === d.pid) { const nav = panel.getNavigation() || {}; if (nav.type !== 'edit_panel') this.phoneNoteDoneOff(); } } catch (e) {}
		return baseOnPanelNavigatedPhone.call(this, panel);
	};
	const baseOnPanelClosedPhone = Plugin.prototype.onPanelClosed;
	Plugin.prototype.onPanelClosed = function (panel) { try { const d = this._phoneDone; if (d && panel && panel.getId() === d.pid) this.phoneNoteDoneOff(); } catch (e) {} return baseOnPanelClosedPhone.call(this, panel); };
	const basePluginOnUnloadPhone = Plugin.prototype.onUnload;
	Plugin.prototype.onUnload = function () { this.phoneNoteDoneOff(); return basePluginOnUnloadPhone.call(this); };
	const basePluginOnLoadPhone = Plugin.prototype.onLoad;
	Plugin.prototype.onLoad = function () { basePluginOnLoadPhone.call(this); this.ui.injectCSS(WB_PHONE_CSS); };
}
{
	// The toolbar is placed AFTER the whole override chain has built it; the base class measured a much narrower bar.
	const baseBuildCtxFinal = WbBoard.prototype.buildCtx;
	WbBoard.prototype.buildCtx = function () { baseBuildCtxFinal.call(this); if (this.ctx) { this.hoistColor(); if (this.host.classList.contains('wb-phone')) this.dockCtx(); else this.placeCtx(); } this.host.classList.toggle('wb-has-ctx', !!this.ctx); };
}
