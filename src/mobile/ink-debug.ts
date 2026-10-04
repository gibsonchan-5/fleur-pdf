import { TFile, type Plugin } from 'obsidian';

/**
 * 手写断触真机诊断记录器。
 *
 * 背景：桌面探针能复现「pointercancel 后续写」路径，但小米平板真机仍断触，
 * 说明真机上发生的事不在已覆盖的分支里。三个待证假设：
 *   ① 硬件压感掉落 → 伪 pointerup（无 cancel），引擎正常提交导致笔画断开；
 *   ② 系统把事件整个吞掉（无 up 无 cancel），手势悬死；
 *   ③ MIUI 防误触把笔报成 touch（走错分支）。
 *
 * 本记录器是**纯外部观察者**：window 捕获阶段 + passive 监听，绝不
 * preventDefault / stopPropagation，对书写路径零干扰。把断触前后完整的
 * 指针/触摸/焦点事件流写进 vault 非隐藏文件 `FleurPDF/ink-debug.json`，
 * 随 vault 同步到电脑端即可分析。
 */

interface InkDbgRecord {
	/** 序号 */
	i: number;
	/** 距开始毫秒 */
	t: number;
	/** 事件类型 */
	e: string;
	/** pointerType */
	pt?: string;
	/** pointerId */
	id?: number;
	/** isPrimary */
	pri?: boolean;
	/** clientX */
	x?: number;
	/** clientY */
	y?: number;
	/** pressure */
	pr?: number;
	/** tiltX / tiltY */
	tx?: number;
	ty?: number;
	/** pointer width / height（触控笔常为恒定值，掉压时可能异常） */
	w?: number;
	h?: number;
	/** buttons 位掩码 */
	b?: number;
	/** getCoalescedEvents 数量（采样率诊断） */
	n?: number;
	/** 目标元素摘要 */
	tg?: string;
	/** 备注标记（如自动停止） */
	m?: string;
}

const LOG_PATH = 'FleurPDF/ink-debug.json';
/** Markdown 副本路径：md 走 vault 索引，即时显示在侧边栏并随笔记同步跨设备 */
const LOG_MD_PATH = 'FleurPDF/ink-debug.md';
/** 每 2s 落盘一次，断触导致页面崩溃也不丢前面的事件 */
const FLUSH_MS = 2000;
/** 上限保护：到达后自动停止，避免无限膨胀 */
const MAX_EVENTS = 40000;

const POINTER_EVENTS = [
	'pointerdown',
	'pointermove',
	'pointerup',
	'pointercancel',
	'pointerover',
	'pointerout',
	'gotpointercapture',
	'lostpointercapture',
] as const;

const APP_EVENTS = [
	'touchstart',
	'touchmove',
	'touchend',
	'touchcancel',
	'blur',
	'focus',
	'visibilitychange',
] as const;

export class InkDebugRecorder {
	private records: InkDbgRecord[] = [];
	private seq = 0;
	private t0 = 0;
	private meta: Record<string, unknown> = {};
	private handlers: Array<[string, EventListener]> = [];
	private timer: number | null = null;
	private dirty = false;

	constructor(private plugin: Plugin) {}

	get recording(): boolean {
		return this.timer !== null;
	}

	start(): void {
		if (this.recording) return;
		this.records = [];
		this.seq = 0;
		this.t0 = performance.now();
		this.meta = {
			startAt: new Date().toISOString(),
			userAgent: navigator.userAgent,
			platform: navigator.platform,
			screen: `${window.screen.width}x${window.screen.height} @${window.devicePixelRatio}`,
			maxTouchPoints: navigator.maxTouchPoints,
		};
		for (const type of [...POINTER_EVENTS, ...APP_EVENTS]) {
			const h = (ev: Event): void => this.record(ev);
			window.addEventListener(type, h, { capture: true, passive: true });
			this.handlers.push([type, h]);
		}
		this.timer = window.setInterval(() => void this.flush(), FLUSH_MS);
		this.dirty = true;
		void this.flush();
	}

	/** 停止并落盘，返回事件数与文件路径（供 Notice 展示）。 */
	async stop(reason = '手动停止'): Promise<{ count: number; path: string }> {
		if (this.timer !== null) {
			window.clearInterval(this.timer);
			this.timer = null;
		}
		for (const [type, h] of this.handlers) {
			window.removeEventListener(type, h, { capture: true } as EventListenerOptions);
		}
		this.handlers = [];
		if (this.records.length > 0 && this.records[this.records.length - 1].e !== 'diagnostic-stop') {
			this.push({ i: this.seq++, t: Math.round(performance.now() - this.t0), e: 'diagnostic-stop', m: reason });
		}
		await this.flush();
		return { count: this.records.length, path: LOG_MD_PATH };
	}

	private record(ev: Event): void {
		if (!this.recording) return;
		const r: InkDbgRecord = { i: this.seq++, t: Math.round(performance.now() - this.t0), e: ev.type };
		if (ev.type === 'visibilitychange') {
			r.m = document.visibilityState;
		} else if (ev instanceof PointerEvent) {
			r.pt = ev.pointerType;
			r.id = ev.pointerId;
			r.pri = ev.isPrimary;
			r.x = Math.round(ev.clientX * 10) / 10;
			r.y = Math.round(ev.clientY * 10) / 10;
			r.pr = Math.round(ev.pressure * 1000) / 1000;
			r.tx = ev.tiltX;
			r.ty = ev.tiltY;
			r.w = ev.width;
			r.h = ev.height;
			r.b = ev.buttons;
			const co = ev.getCoalescedEvents?.();
			r.n = co ? co.length : 0;
		} else if (ev instanceof TouchEvent) {
			const t0t = ev.touches[0];
			if (t0t) {
				r.x = Math.round(t0t.clientX * 10) / 10;
				r.y = Math.round(t0t.clientY * 10) / 10;
				r.pr = Math.round((t0t.force ?? 0) * 1000) / 1000;
			}
			r.n = ev.touches.length;
		}
		const tg = ev.target;
		if (tg instanceof Element) {
			const cls = typeof tg.className === 'string' ? `.${tg.className.split(/\s+/).slice(0, 2).join('.')}` : '';
			r.tg = `${tg.tagName.toLowerCase()}${cls}`.slice(0, 48);
		}
		this.push(r);
		if (this.records.length >= MAX_EVENTS) {
			void this.stop('事件数达上限，自动停止');
		}
	}

	private push(r: InkDbgRecord): void {
		this.records.push(r);
		this.dirty = true;
	}

	private async flush(): Promise<void> {
		if (!this.dirty) return;
		this.dirty = false;
		const json = JSON.stringify({ meta: this.meta, events: this.records });
		try {
			const { vault } = this.plugin.app;
			// ① JSON 原始文件（分析用）——adapter 直写，不经 vault 索引
			try {
				await vault.adapter.mkdir('FleurPDF');
			} catch {
				// 目录已存在
			}
			await vault.adapter.write(LOG_PATH, json);
		} catch (err) {
			console.error('[FleurPDF] ink-debug 落盘失败', err);
		}
		// ② Markdown 副本——走 vault API，写完立刻进侧边栏与同步索引。
		// 移动端对外部写入的 JSON 既不实时显示、也不保证被同步方案携带，
		// 而 md 是笔记同步的必达格式（断触排查数据靠它跨设备回传）。
		try {
			const { vault } = this.plugin.app;
			const mdPath = LOG_MD_PATH;
			const md = `# FleurPDF 手写断触诊断\n\n> 本文件由诊断命令自动生成，可整篇删除。\n\n\`\`\`json\n${json}\n\`\`\`\n`;
			let file = vault.getAbstractFileByPath(mdPath);
			if (file instanceof TFile) {
				await vault.modify(file, md);
			} else {
				try {
					await vault.createFolder('FleurPDF');
				} catch {
					// 目录已存在
				}
				file = await vault.create(mdPath, md);
			}
		} catch (err) {
			console.error('[FleurPDF] ink-debug Markdown 副本写入失败', err);
		}
	}
}
