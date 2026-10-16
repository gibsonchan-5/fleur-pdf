// annotation-sync 的无头测试：esbuild 打包成单文件 ESM → node:assert 逐分支断言。
// 运行：node scripts/test-annotation-sync.mjs
// 依赖仓库内 esbuild（devDependency），不引入测试框架。

import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const outDir = mkdtempSync(join(tmpdir(), 'fleur-ann-sync-'));
const outfile = join(outDir, 'bundle.mjs');

await build({
	entryPoints: ['src/annotation-sync.ts'],
	bundle: true,
	format: 'esm',
	platform: 'neutral',
	outfile,
	logLevel: 'silent',
});

const { ANN_SYNC_DIR, annSyncFileName, mergeAnnotationData } = await import(outfile);

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

const mkAnn = (id, over = {}) => ({
	id, type: 'highlight', page: 1, text: `text-${id}`,
	createdAt: 1000, ...over,
});

console.log(`ANN_SYNC_DIR = ${ANN_SYNC_DIR}`);
assert.equal(ANN_SYNC_DIR, 'FleurPDF/data/annotations');

// ── 文件名 ──
test('annSyncFileName：同名不同路径不冲突（hash 后缀）', () => {
	const a = annSyncFileName('notes/book.pdf');
	const b = annSyncFileName('papers/book.pdf');
	assert.notEqual(a, b);
	assert.ok(a.endsWith('.json'));
	assert.ok(!a.includes('/'), '文件名内不应含路径分隔符');
});

// ── 合并：远端新增收编 ──
test('远端独有批注 → 收编（changed=true）', () => {
	const local = { fileId: 'a.pdf', annotations: [mkAnn('l1')] };
	const remote = { version: 1, file: 'a.pdf', updatedAt: '', annotations: [mkAnn('r1')], tombstones: {} };
	const { data, changed } = mergeAnnotationData(local, remote);
	assert.deepEqual(data.annotations.map(a => a.id).sort(), ['l1', 'r1']);
	assert.equal(changed, true);
});

// ── 合并：本端新增保留 ──
test('本端独有批注 → 保留（远端 null）', () => {
	const local = { fileId: 'a.pdf', annotations: [mkAnn('l1')] };
	const { data, changed } = mergeAnnotationData(local, null);
	assert.deepEqual(data.annotations.map(a => a.id), ['l1']);
	assert.equal(changed, false);
});

// ── 编辑冲突：updatedAt 后写者胜 ──
test('同 id 均有 updatedAt → 更晚者胜', () => {
	const local = { fileId: 'a.pdf', annotations: [mkAnn('x', { comment: 'local', updatedAt: 2000 })] };
	const remote = { version: 1, file: 'a.pdf', updatedAt: '', tombstones: {},
		annotations: [mkAnn('x', { comment: 'remote', updatedAt: 3000 })] };
	const { data } = mergeAnnotationData(local, remote);
	assert.equal(data.annotations[0].comment, 'remote');
});
test('同 id 本端更新更晚 → 本端胜', () => {
	const local = { fileId: 'a.pdf', annotations: [mkAnn('x', { comment: 'local', updatedAt: 5000 })] };
	const remote = { version: 1, file: 'a.pdf', updatedAt: '', tombstones: {},
		annotations: [mkAnn('x', { comment: 'remote', updatedAt: 3000 })] };
	const { data } = mergeAnnotationData(local, remote);
	assert.equal(data.annotations[0].comment, 'local');
});
test('历史数据无 updatedAt → 本端胜（兜底）', () => {
	const local = { fileId: 'a.pdf', annotations: [mkAnn('x', { comment: 'local' })] };
	const remote = { version: 1, file: 'a.pdf', updatedAt: '', tombstones: {},
		annotations: [mkAnn('x', { comment: 'remote', updatedAt: 9999 })] };
	const { data } = mergeAnnotationData(local, remote);
	assert.equal(data.annotations[0].comment, 'local');
});

// ── 墓碑 ──
test('墓碑时刻 ≥ 批注 createdAt → 对端批注被删', () => {
	const local = { fileId: 'a.pdf', annotations: [mkAnn('l1')] };
	const remote = { version: 1, file: 'a.pdf', updatedAt: '', tombstones: { r1: 2000 },
		annotations: [mkAnn('r1', { createdAt: 1000 })] };
	const { data } = mergeAnnotationData(local, remote);
	assert.deepEqual(data.annotations.map(a => a.id), ['l1']);
});
test('删后又改（updatedAt 晚于墓碑）→ 存活', () => {
	const local = { fileId: 'a.pdf', annotations: [] };
	const remote = { version: 1, file: 'a.pdf', updatedAt: '', tombstones: { r1: 2000 },
		annotations: [mkAnn('r1', { createdAt: 1000, updatedAt: 3000 })] };
	const { data } = mergeAnnotationData(local, remote);
	assert.deepEqual(data.annotations.map(a => a.id), ['r1']);
});
test('墓碑并集：双方取更晚', () => {
	const local = { fileId: 'a.pdf', annotations: [], tombstones: { a: 3000, b: 100 } };
	const remote = { version: 1, file: 'a.pdf', updatedAt: '', tombstones: { a: 100, b: 200, c: 50 }, annotations: [] };
	const { data } = mergeAnnotationData(local, remote);
	assert.deepEqual(data.tombstones, { a: 3000, b: 200, c: 50 });
});
test('本端批注被对端墓碑删除 → 消失且墓碑带回归本端', () => {
	const local = { fileId: 'a.pdf', annotations: [mkAnn('l1', { createdAt: 1000 })] };
	const remote = { version: 1, file: 'a.pdf', updatedAt: '', tombstones: { l1: 5000 }, annotations: [] };
	const { data, changed } = mergeAnnotationData(local, remote);
	assert.deepEqual(data.annotations, []);
	assert.equal(data.tombstones.l1, 5000);
	assert.equal(changed, true);
});

// ── AI 结果同规则 ──
test('AI 结果：远端收编 + 墓碑生效', () => {
	const local = { fileId: 'a.pdf', annotations: [], aiResults: [{ id: 'ai1', text: '', question: 'q', answer: 'a', createdAt: 1000 }] };
	const remote = { version: 1, file: 'a.pdf', updatedAt: '',
		annotations: [],
		aiResults: [{ id: 'ai2', text: '', question: 'q2', answer: 'a2', createdAt: 1000 }],
		tombstones: { ai1: 2000 } };
	const { data } = mergeAnnotationData(local, remote);
	assert.deepEqual(data.aiResults.map(r => r.id), ['ai2']);
});

// ── 排序确定性 + 往返幂等（一跳）──
test('合并结果排序确定（createdAt 升序，id 决胜），再合并一跳幂等', () => {
	const local = { fileId: 'a.pdf', annotations: [mkAnn('b', { createdAt: 200 }), mkAnn('a', { createdAt: 200 })] };
	const remote = { version: 1, file: 'a.pdf', updatedAt: '', tombstones: {},
		annotations: [mkAnn('c', { createdAt: 100 })] };
	const { data } = mergeAnnotationData(local, remote);
	assert.deepEqual(data.annotations.map(a => a.id), ['c', 'a', 'b']);
	// 用合并结果作为本端再合并同一个远端 → 不再变化
	const second = mergeAnnotationData(
		{ fileId: 'a.pdf', annotations: data.annotations, tombstones: data.tombstones }, remote);
	assert.equal(second.changed, false);
	assert.deepEqual(second.data.annotations.map(a => a.id), ['c', 'a', 'b']);
});

// ── 脏数据防御 ──
test('远端坏形状（annotations 非数组/tombstones 非对象）→ 按空处理不抛', () => {
	const local = { fileId: 'a.pdf', annotations: [mkAnn('l1')] };
	const remote = { version: 1, file: 'a.pdf', updatedAt: '', annotations: 'oops', tombstones: 'oops' };
	const { data, changed } = mergeAnnotationData(local, remote);
	assert.deepEqual(data.annotations.map(a => a.id), ['l1']);
	assert.equal(changed, false);
});
test('远端 null → 本端原样', () => {
	const local = { fileId: 'a.pdf', annotations: [mkAnn('l1')] };
	const { data, changed } = mergeAnnotationData(local, null);
	assert.equal(changed, false);
	assert.deepEqual(data.annotations.map(a => a.id), ['l1']);
});
test('内容相同但对象引用不同 → changed=false（不产生同步风暴）', () => {
	const local = { fileId: 'a.pdf', annotations: [mkAnn('l1')], tombstones: {} };
	const remote = { version: 1, file: 'a.pdf', updatedAt: '', annotations: [JSON.parse(JSON.stringify(mkAnn('l1')))], tombstones: {} };
	const { changed } = mergeAnnotationData(local, remote);
	assert.equal(changed, false);
});

console.log(`\n${passed} 个断言组通过${process.exitCode ? '（存在失败）' : ''}`);
if (process.exitCode) process.exit(1);
