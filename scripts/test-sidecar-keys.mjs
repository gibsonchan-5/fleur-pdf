// sidecar 落盘键与一次性迁移的无头测试。
// 跑法：node scripts/test-sidecar-keys.mjs
//
// 覆盖：
//   1. 旧版有损键（非字母数字 → _）会让等长中文书名撞名 —— 固化这个前提；
//   2. 新键（djb2+FNV-1a 64 位）对全量中文路径唯一；
//   3. 迁移只认领 fileId/file 精确匹配的旧文件，撞键共享的不认领、不删除；
//   4. 新键文件归属不符时按空处理（不把脏数据当自己的）；
//   5. 便签 remove 会把「归属本文件」的旧键一并删掉（防删后复活）。
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = new URL('..', import.meta.url).pathname;
const workDir = mkdtempSync(join(tmpdir(), 'fleur-sidecar-keys-'));
const mockDir = join(workDir, 'mock');
mkdirSync(mockDir, { recursive: true });
const mockObsidian = join(mockDir, 'obsidian.mjs');
writeFileSync(mockObsidian, `
export class App {}
export function normalizePath(p) {
  return String(p).replace(/\\\\/g, '/').replace(/\\/{2,}/g, '/').replace(/^\\.\\//, '').replace(/\\/+$/, '');
}
export function debounce(fn) { return fn; }
`);

const outDir = join(workDir, 'bundle');
await build({
	entryPoints: [join(repo, 'src/store.ts'), join(repo, 'src/notes/note-store.ts')],
	outdir: outDir,
	bundle: true,
	format: 'esm',
	platform: 'neutral',
	alias: { obsidian: mockObsidian },
	logLevel: 'silent',
});

const { AnnotationStore, annotationKey, legacyAnnotationKey } =
	await import(pathToFileURL(join(outDir, 'store.js')).href);
const { NoteStore, notesKey, legacyNotesKey } =
	await import(pathToFileURL(join(outDir, 'notes', 'note-store.js')).href);

let passed = 0;
function test(name, fn) {
	try {
		fn();
		passed++;
		console.log(`  ✓ ${name}`);
	} catch (e) {
		console.error(`  ✗ ${name}\n    ${e.message}`);
		process.exitCode = 1;
	}
}
async function atest(name, fn) {
	try {
		await fn();
		passed++;
		console.log(`  ✓ ${name}`);
	} catch (e) {
		console.error(`  ✗ ${name}\n    ${e.message}`);
		process.exitCode = 1;
	}
}

/** 每个用例独立一个 vault 根，避免互相污染。 */
let seq = 0;
function makeVault() {
	const root = join(workDir, `vault-${++seq}`);
	mkdirSync(root, { recursive: true });
	const abs = (p) => join(root, p);
	const adapter = {
		async exists(p) { return existsSync(abs(p)); },
		async read(p) { return readFileSync(abs(p), 'utf8'); },
		async write(p, content) { mkdirSync(dirname(abs(p)), { recursive: true }); writeFileSync(abs(p), content); },
		async remove(p) { rmSync(abs(p)); },
		async mkdir(p) { mkdirSync(abs(p), { recursive: true }); },
	};
	return { root, app: { vault: { configDir: '.obsidian', adapter } } };
}
const dataDir = '.obsidian/plugins/fleur-pdf/data';
const readJson = (v, p) => JSON.parse(readFileSync(join(v.root, p), 'utf8'));
const writeJson = (v, p, obj) => {
	const full = join(v.root, p);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, JSON.stringify(obj));
};

const mkAnn = (id, over = {}) => ({ id, type: 'highlight', page: 1, text: `text-${id}`, createdAt: 1000, ...over });

// ── 1. 旧键撞名（固化为回归前提）──
console.log('旧版有损键：');
test('等长中文书名在旧键下撞名（这就是串书根因）', () => {
	assert.equal(legacyAnnotationKey('资料/红楼梦.pdf'), legacyAnnotationKey('资料/西游记.pdf'));
	assert.equal(legacyNotesKey('阅读/第一册.pdf'), legacyNotesKey('阅读/第二册.pdf'));
});

// ── 2. 新键唯一性 ──
console.log('新键：');
test('撞名样本在新键下各不相同', () => {
	const list = ['资料/红楼梦.pdf', '资料/西游记.pdf', '阅读/第一册.pdf', '阅读/第二册.pdf'];
	const keys = new Set(list.map(annotationKey));
	assert.equal(keys.size, list.length);
});
test('批注与便签键前缀互不冲突', () => {
	assert.notEqual(annotationKey('a.pdf'), notesKey('a.pdf'));
	assert.ok(annotationKey('a.pdf').startsWith('ann-'));
	assert.ok(notesKey('a.pdf').startsWith('notes-'));
});
test('500 条中文/论文式路径键唯一且稳定', () => {
	const names = [];
	for (let i = 0; i < 500; i++) {
		const n = `${'甲乙丙丁戊己庚辛壬癸'[i % 10]}${'子丑寅卯辰巳午未申酉'[(i * 7) % 10]}${'天地玄黄'[i % 4]}`;
		names.push(`阅读/论文资料/${n}（作者${i}，2026）.pdf`);
	}
	const keys = new Set(names.map(annotationKey));
	assert.equal(keys.size, names.length);
	for (const n of names.slice(0, 20)) assert.equal(annotationKey(n), annotationKey(n));
});

// ── 3. 批注迁移 ──
console.log('批注迁移：');
await atest('归属匹配的旧键文件被迁走：新键可读、旧键删除、内容一致', async () => {
	const v = makeVault();
	const A = '资料/红楼梦.pdf';
	writeJson(v, `${dataDir}/${legacyAnnotationKey(A)}.json`, { fileId: A, annotations: [mkAnn('a1')] });
	const store = new AnnotationStore(v.app, 'fleur-pdf');
	const data = await store.load(A);
	assert.deepEqual(data.annotations.map((x) => x.id), ['a1']);
	assert.equal(data.fileId, A);
	assert.ok(existsSync(join(v.root, `${dataDir}/${annotationKey(A)}.json`)));
	assert.ok(!existsSync(join(v.root, `${dataDir}/${legacyAnnotationKey(A)}.json`)));
	const again = await store.load(A);
	assert.deepEqual(again.annotations.map((x) => x.id), ['a1']);
});

await atest('撞键共享旧文件（fileId 是另一本）：不认领、不删除、不建新文件', async () => {
	const v = makeVault();
	const A = '资料/红楼梦.pdf';
	const B = '资料/西游记.pdf';
	assert.equal(legacyAnnotationKey(A), legacyAnnotationKey(B));
	writeJson(v, `${dataDir}/${legacyAnnotationKey(A)}.json`, { fileId: B, annotations: [mkAnn('b1')] });
	const store = new AnnotationStore(v.app, 'fleur-pdf');
	const data = await store.load(A);
	assert.deepEqual(data.annotations, []);
	assert.ok(existsSync(join(v.root, `${dataDir}/${legacyAnnotationKey(A)}.json`)), '旧文件必须保留');
	assert.ok(!existsSync(join(v.root, `${dataDir}/${annotationKey(A)}.json`)), '不应建立空新文件');
});

await atest('撞键双方互不串数据：A 迁走后 B 读到的仍是空', async () => {
	const v = makeVault();
	const A = '资料/红楼梦.pdf';
	const B = '资料/西游记.pdf';
	writeJson(v, `${dataDir}/${legacyAnnotationKey(A)}.json`, { fileId: A, annotations: [mkAnn('a1')] });
	const store = new AnnotationStore(v.app, 'fleur-pdf');
	assert.deepEqual((await store.load(A)).annotations.map((x) => x.id), ['a1']);
	assert.deepEqual((await store.load(B)).annotations, []);
	await store.addAnnotation(B, mkAnn('b9'));
	const bData = readJson(v, `${dataDir}/${annotationKey(B)}.json`);
	assert.deepEqual(bData.annotations.map((x) => x.id), ['b9']);
	assert.equal(bData.fileId, B);
	const aData = await store.load(A);
	assert.deepEqual(aData.annotations.map((x) => x.id), ['a1'], 'A 不应看到 B 的批注');
});

await atest('新键文件归属不符 → 按空处理且不读写旧键', async () => {
	const v = makeVault();
	const A = '资料/红楼梦.pdf';
	writeJson(v, `${dataDir}/${annotationKey(A)}.json`, { fileId: '别处/别人的书.pdf', annotations: [mkAnn('x1')] });
	writeJson(v, `${dataDir}/${legacyAnnotationKey(A)}.json`, { fileId: A, annotations: [mkAnn('a1')] });
	const store = new AnnotationStore(v.app, 'fleur-pdf');
	const data = await store.load(A);
	assert.deepEqual(data.annotations, []);
	// 旧键不能被顺走
	assert.ok(existsSync(join(v.root, `${dataDir}/${legacyAnnotationKey(A)}.json`)));
});

await atest('损坏的旧键文件 → 空数据，旧文件原样保留', async () => {
	const v = makeVault();
	const A = '资料/红楼梦.pdf';
	const legacyFull = join(v.root, `${dataDir}/${legacyAnnotationKey(A)}.json`);
	mkdirSync(dirname(legacyFull), { recursive: true });
	writeFileSync(legacyFull, '{ not json');
	const store = new AnnotationStore(v.app, 'fleur-pdf');
	assert.deepEqual((await store.load(A)).annotations, []);
	assert.ok(existsSync(legacyFull));
});

// ── 4. 便签迁移 ──
console.log('便签迁移：');
const notesPayload = (file, notes) => ({ version: 1, file, updated: 1, notes, exportPath: '' });
const mkNote = (id, over = {}) => ({ id, page: 1, x: 10, y: 20, w: 220, h: 160, text: `t-${id}`, createdAt: 1, ...over });

await atest('归属匹配的旧便签被迁走', async () => {
	const v = makeVault();
	const A = '阅读/第一册.pdf';
	const legacy = `${dataDir}/${legacyNotesKey(A)}.json`;
	writeJson(v, legacy, notesPayload(A, [mkNote('n1')]));
	const store = new NoteStore(v.app, 'fleur-pdf');
	const data = await store.load(A);
	assert.deepEqual(data.notes.map((x) => x.id), ['n1']);
	assert.ok(existsSync(join(v.root, `${dataDir}/${notesKey(A)}.json`)));
	assert.ok(!existsSync(join(v.root, legacy)));
});

await atest('撞键共享旧便签（file 是另一本）：不认领、不删除', async () => {
	const v = makeVault();
	const A = '阅读/第一册.pdf';
	const B = '阅读/第二册.pdf';
	writeJson(v, `${dataDir}/${legacyNotesKey(A)}.json`, notesPayload(B, [mkNote('b1')]));
	const store = new NoteStore(v.app, 'fleur-pdf');
	assert.deepEqual((await store.load(A)).notes, []);
	assert.ok(existsSync(join(v.root, `${dataDir}/${legacyNotesKey(A)}.json`)));
});

await atest('remove 只删归属本文件的旧键（防删后复活）', async () => {
	const v = makeVault();
	// 用不撞键的两条路径，才能构造「两份旧键文件并存」的局面
	const A = '阅读/book1.pdf';
	const B = '阅读/book2.pdf';
	assert.notEqual(legacyNotesKey(A), legacyNotesKey(B));
	const legacyA = `${dataDir}/${legacyNotesKey(A)}.json`;
	const legacyB = `${dataDir}/${legacyNotesKey(B)}.json`;
	writeJson(v, legacyA, notesPayload(A, [mkNote('a1')]));
	writeJson(v, legacyB, notesPayload(B, [mkNote('b1')]));
	const store = new NoteStore(v.app, 'fleur-pdf');
	await store.remove(A);
	assert.ok(!existsSync(join(v.root, legacyA)), '归属 A 的旧键应删');
	assert.ok(existsSync(join(v.root, legacyB)), '归属 B 的旧键不能动');
});

await atest('便签新键写出后往返读取一致', async () => {
	const v = makeVault();
	const A = '阅读/第一册.pdf';
	const store = new NoteStore(v.app, 'fleur-pdf');
	await store.save(A, { notes: [mkNote('n1'), mkNote('n2', { collapsed: true })], exportPath: 'example/export.md' });
	const back = await store.load(A);
	assert.deepEqual(back.notes.map((x) => x.id), ['n1', 'n2']);
	assert.equal(back.notes[1].collapsed, true);
	assert.equal(back.exportPath, 'example/export.md');
});

console.log(`\n${passed} 个断言组通过${process.exitCode ? '（存在失败）' : ''}`);
if (process.exitCode) process.exit(1);
