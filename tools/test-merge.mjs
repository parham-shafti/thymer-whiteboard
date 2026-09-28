// Offline test of wbMergeScene, extracted verbatim from plugin.js between its markers. node tools/test-merge.mjs
import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict';
const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'plugin.js'), 'utf8');
const a = src.indexOf('// ==== wbMergeScene'), b = src.indexOf('// ==== end wbMergeScene');
assert.ok(a > 0 && b > a, 'markers not found');
const { wbMergeScene } = new Function(src.slice(a, b) + '\nreturn { wbMergeScene };')();
const n = (id, o = {}) => Object.assign({ id, type: 'sticky', x: 0, y: 0, w: 170, h: 170, text: id, color: 'yellow' }, o);
const sc = (nodes, edges = [], extra = {}) => Object.assign({ v: 1, nodes, edges, settings: { bg: 'lines' }, tags: [], comments: [], rev: 1, savedAt: 1, view: { x: 0, y: 0, z: 1 } }, extra);
const ids = (s) => s.nodes.map((x) => x.id).join(',');
let t = 0; const ok = (name, fn) => { fn(); t++; console.log('ok', name); };

const base = sc([n('a'), n('b'), n('c')], [{ id: 'e1', from: 'a', to: 'b' }]);
ok('phone adds, desktop untouched: the addition arrives', () => {
	const remote = sc([n('a'), n('b'), n('c'), n('p', { text: 'from phone' })], base.edges, { rev: 2 });
	const m = wbMergeScene(base, structuredClone(base), remote); assert.equal(ids(m), 'a,b,c,p'); assert.equal(m.rev, 2);
});
ok('both add different notes: both kept', () => {
	const local = sc([n('a'), n('b'), n('c'), n('d')], base.edges); const remote = sc([n('a'), n('b'), n('c'), n('p')], base.edges, { rev: 2 });
	const m = wbMergeScene(base, local, remote); assert.deepEqual(new Set(m.nodes.map((x) => x.id)), new Set(['a', 'b', 'c', 'd', 'p']));
});
ok('move here, recolour there: both on the same note', () => {
	const local = structuredClone(base); local.nodes[0].x = 300; const remote = structuredClone(base); remote.nodes[0].color = 'pink'; remote.rev = 2;
	const m = wbMergeScene(base, local, remote); assert.equal(m.nodes[0].x, 300); assert.equal(m.nodes[0].color, 'pink');
});
ok('same property on both sides: this device wins', () => {
	const local = structuredClone(base); local.nodes[1].text = 'mine'; const remote = structuredClone(base); remote.nodes[1].text = 'theirs';
	assert.equal(wbMergeScene(base, local, remote).nodes[1].text, 'mine');
});
ok('deleted elsewhere, untouched here: gone', () => {
	const remote = sc([n('a'), n('c')], [], { rev: 2 }); const m = wbMergeScene(base, structuredClone(base), remote); assert.equal(ids(m), 'a,c'); assert.equal(m.edges.length, 0);
});
ok('deleted elsewhere, edited here: the edit survives', () => {
	const local = structuredClone(base); local.nodes[1].text = 'kept'; const remote = sc([n('a'), n('c')], [], { rev: 2 });
	assert.ok(wbMergeScene(base, local, remote).nodes.find((x) => x.id === 'b' && x.text === 'kept'));
});
ok('deleted here, edited elsewhere: stays deleted', () => {
	const local = sc([n('a'), n('c')], base.edges); const remote = structuredClone(base); remote.nodes[1].text = 'theirs';
	assert.equal(ids(wbMergeScene(base, local, remote)), 'a,c');
});
ok('stale client: only its measured height survives, the rest is the newer server copy', () => {
	const local = structuredClone(base); local.nodes[2].h = 180; const remote = structuredClone(base); remote.nodes[2].text = 'new text'; remote.nodes[2].x = 900; remote.nodes.push(n('z')); remote.rev = 9;
	const m = wbMergeScene(base, local, remote); const c = m.nodes.find((x) => x.id === 'c'); assert.equal(c.h, 180); assert.equal(c.text, 'new text'); assert.equal(c.x, 900); assert.ok(m.nodes.find((x) => x.id === 'z'));
});
ok('a removed property (html) here stays removed', () => {
	const b2 = structuredClone(base); b2.nodes[0].html = '<b>a</b>'; const local = structuredClone(b2); delete local.nodes[0].html; const remote = structuredClone(b2); remote.nodes[0].x = 5;
	const m = wbMergeScene(b2, local, remote); assert.equal('html' in m.nodes[0], false); assert.equal(m.nodes[0].x, 5);
});
ok('settings merge per key, view stays local', () => {
	const local = structuredClone(base); local.settings.snap = true; local.view = { x: 9, y: 9, z: 2 }; const remote = structuredClone(base); remote.settings.bg = 'dots';
	const m = wbMergeScene(base, local, remote); assert.equal(m.settings.snap, true); assert.equal(m.settings.bg, 'dots'); assert.deepEqual(m.view, { x: 9, y: 9, z: 2 });
});
ok('reorder here only: local paint order kept, remote addition placed', () => {
	const local = sc([n('c'), n('a'), n('b')], base.edges); const remote = sc([n('a'), n('b'), n('c'), n('p')], base.edges);
	assert.equal(ids(wbMergeScene(base, local, remote)), 'c,a,b,p');
});
console.log(t + ' tests passed');
