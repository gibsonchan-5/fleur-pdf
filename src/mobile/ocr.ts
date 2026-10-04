// 本地 OCR 引擎（tesseract.js / WASM）——「截图取字」的离线通道。
//
// 合规边界（社区审核 + 用户隐私双重要求）：
//   · tesseract.js 与 tessdata 语言包均为 Apache-2.0（见 THIRD-PARTY-NOTICES.md）；
//   · 引擎文件（worker 脚本 + wasm 内核）**不随发布包分发**：仅当用户在设置里
//     开启「启用本地 OCR」（默认关）后首次使用时，才从 jsdelivr 按固定版本下载
//     （下载属用户显式选择的行为），写入插件目录缓存，之后完全离线可用；
//   · 只有语言包（traineddata，纯数据）按用户配置的源首次下载，IndexedDB 缓存；
//   · 识别全程本地推理，截图不出本机。
//
// 引擎资产（版本随 package.json 依赖锁定，升级依赖时同步改常量）：
//   tesseract.js@5.1.1  dist/worker.min.js
//   tesseract.js-core@5.1.1  tesseract-core-{simd-,}lstm.wasm.{js,wasm}

import { FileSystemAdapter, requestUrl, type Plugin } from 'obsidian';
import type { Worker as TesseractWorker } from 'tesseract.js';

/** 默认语言包源（tesseract.js 官方 CDN，eng / chi_sim 皆有；纯数据文件）。 */
export const DEFAULT_OCR_LANG_PATH = 'https://tessdata.projectnaptha.com/4.0.0';

/** 引擎文件的固定版本源（jsdelivr；与依赖版本锁定，升级依赖时同步更新）。 */
const TESSERACT_JS_VERSION = '5.1.1';
const TESSERACT_CORE_VERSION = '5.1.1';
const ENGINE_CDN = `https://cdn.jsdelivr.net/npm`;

/** 引擎文件清单：vault 内相对路径 ← CDN 路径。 */
const ENGINE_FILES: ReadonlyArray<{ rel: string; url: string }> = [
	{ rel: 'tesseract/worker.min.js', url: `${ENGINE_CDN}/tesseract.js@${TESSERACT_JS_VERSION}/dist/worker.min.js` },
	{ rel: 'tesseract/core/tesseract-core-simd-lstm.wasm.js', url: `${ENGINE_CDN}/tesseract.js-core@${TESSERACT_CORE_VERSION}/tesseract-core-simd-lstm.wasm.js` },
	{ rel: 'tesseract/core/tesseract-core-simd-lstm.wasm', url: `${ENGINE_CDN}/tesseract.js-core@${TESSERACT_CORE_VERSION}/tesseract-core-simd-lstm.wasm` },
	{ rel: 'tesseract/core/tesseract-core-lstm.wasm.js', url: `${ENGINE_CDN}/tesseract.js-core@${TESSERACT_CORE_VERSION}/tesseract-core-lstm.wasm.js` },
	{ rel: 'tesseract/core/tesseract-core-lstm.wasm', url: `${ENGINE_CDN}/tesseract.js-core@${TESSERACT_CORE_VERSION}/tesseract-core-lstm.wasm` },
];

export class OcrEngine {
	/** 按「语言组合」缓存 worker：同组合复用，换语言重建（切换成本一次性）。 */
	private worker: TesseractWorker | null = null;
	private workerLangs = '';
	private creating: Promise<TesseractWorker> | null = null;
	/** 最近一次 recognize 传入的进度回调（worker logger 在创建时绑定，只能转发）。 */
	private progressSink: ((ratio: number, status: string) => void) | null = null;

	constructor(private plugin: Plugin & { settings: { ocrLangPath: string; ocrLangs: string } }) {}

	/**
	 * 识别一张图（PNG dataURL）。
	 * @param onProgress 进度 0~1 与阶段描述（下载语言包 / 识别中）。
	 * @returns 纯文本；失败抛错（调用方转 Notice）。
	 */
	async recognize(
		dataUrl: string,
		onProgress?: (ratio: number, status: string) => void
	): Promise<string> {
		this.progressSink = onProgress ?? null;
		const worker = await this.ensureWorker(this.plugin.settings.ocrLangs || 'chi_sim+eng');
		// 中文场景保留词间空格开关：chi_sim 分词更自然
		await worker.setParameters({ preserve_interword_spaces: '1' });
		const res = await worker.recognize(dataUrl);
		return (res?.data?.text ?? '').trim();
	}

	/** 插件卸载时释放 worker（WASM 线程不泄露）。 */
	async terminate(): Promise<void> {
		const w = this.worker;
		this.worker = null;
		this.workerLangs = '';
		this.creating = null;
		if (w) {
			try {
				await w.terminate();
			} catch {
				/* 已死的 worker 不必救 */
			}
		}
	}

	private async ensureWorker(langs: string): Promise<TesseractWorker> {
		if (this.worker && this.workerLangs === langs) return this.worker;
		// 并发调用共享同一次创建
		if (this.creating && this.workerLangs === langs) return this.creating;
		this.workerLangs = langs;
		this.creating = this.createWorker(langs);
		try {
			this.worker = await this.creating;
			return this.worker;
		} catch (err) {
			this.creating = null;
			this.workerLangs = '';
			throw err;
		}
	}

	private async createWorker(langs: string): Promise<TesseractWorker> {
		// 引擎文件按需下载（用户已显式开启本地 OCR；已缓存则秒过）
		await this.ensureEngineAssets();

		const { createWorker, OEM } = await import('tesseract.js');
		const logger = (m: { status?: string; progress?: number }) => {
			if (!this.progressSink) return;
			const status = m.status ?? '';
			// 语言包下载阶段的原始状态是德语文件名，翻译成用户语言
			const isDownload = /loading tesseract core|initializing|download/i.test(status) || status.includes('traineddata');
			this.progressSink(
				typeof m.progress === 'number' ? m.progress : 0,
				isDownload ? '准备语言包' : status || '处理中'
			);
		};

		return createWorker(langs, OEM.LSTM_ONLY, {
			workerPath: this.assetPath('tesseract/worker.min.js'),
			// 目录形式：tesseract.js 自动按环境选择 simd / 非 simd 的 lstm core
			corePath: this.assetPath('tesseract/core'),
			langPath: this.plugin.settings.ocrLangPath || DEFAULT_OCR_LANG_PATH,
			logger,
			errorHandler: (e: unknown) => console.warn('[FleurPDF OCR]', e),
		});
	}

	/** 插件资产目录内文件的资源 URL（桌面 app://、移动端 https://localhost，均可被 webview 加载）。 */
	private assetPath(rel: string): string {
		const adapter = this.plugin.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			throw new Error('当前存储适配器不支持本地 OCR 资产');
		}
		return adapter.getResourcePath(`${this.plugin.manifest.dir}/${rel}`);
	}

	/**
	 * 确保引擎文件就位：插件目录里已有（手动放置或历史版本拷贝）直接用；
	 * 缺哪个补哪个 —— 从 jsdelivr 固定版本下载，写入插件目录缓存。
	 * 只在用户开启本地 OCR 后的首次使用触发，全程有进度回调。
	 */
	private async ensureEngineAssets(): Promise<void> {
		const adapter = this.plugin.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			throw new Error('当前存储适配器不支持本地 OCR（需要文件系统 vault）');
		}
		const missing: { rel: string; url: string }[] = [];
		for (const f of ENGINE_FILES) {
			if (!(await adapter.exists(`${this.plugin.manifest.dir}/${f.rel}`))) missing.push(f);
		}
		if (!missing.length) return;

		const total = missing.length;
		for (let i = 0; i < total; i++) {
			const f = missing[i];
			this.progressSink?.(
				i / total,
				`下载 OCR 引擎（${i + 1}/${total}，仅首次）`
			);
			// requestUrl 走宿主网络栈，不受 webview CORS 限制，移动端同样可用
			const buf = await requestUrl({ url: f.url, method: 'GET' }).arrayBuffer;
			if (!buf || buf.byteLength === 0) {
				throw new Error(`OCR 引擎文件下载失败（${f.rel}），请检查网络后重试`);
			}
			const path = `${this.plugin.manifest.dir}/${f.rel}`;
			// 一层层确保目录存在（adapter 不会自动建目录）
			const parts = path.split('/');
			parts.pop();
			for (let d = 1; d <= parts.length; d++) {
				const dir = parts.slice(0, d).join('/');
				if (dir && !(await adapter.exists(dir))) await adapter.mkdir(dir);
			}
			await adapter.writeBinary(path, buf);
		}
		this.progressSink?.(1, 'OCR 引擎就绪');
	}
}
