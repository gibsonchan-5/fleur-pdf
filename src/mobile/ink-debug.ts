import { Platform, TFile, type Plugin } from 'obsidian';

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
	/** 时长（ms）：frame-jank = 两帧间隔，longtask = 任务时长 */
	d?: number;
	/** 发生时覆盖层状态摘要（仅卡顿类记录） */
	st?: Record<string, unknown>;
}

const LOG_PATH = 'FleurPDF/ink-debug.json';
/** Markdown 副本路径：md 走 vault 索引，即时显示在侧边栏并随笔记同步跨设备 */
const LOG_MD_PATH = 'FleurPDF/ink-debug.md';
/** 每 2s 落盘一次，断触导致页面崩溃也不丢前面的事件 */
const FLUSH_MS = 2000;
/**
 * Markdown 副本的写入间隔（单位：flush 次数）。
 * md 走 vault.modify —— 每次写都触发索引刷新，若它正开在侧边栏还要重渲染整份
 * 1MB 文本；而 json 走 adapter 直写，不经索引。书写期每 2s 双写两份大文件，
 * 等于让诊断工具自己往帧预算里塞活（实测与卡顿无相位相关，但没必要留着）。
 * 改成每 10 次 flush（约 20s）与停止时各写一次：跨设备回传够用，崩溃最多
 * 晚 20s 才出现在 md 里，json 始终是完整的。
 */
const MD_EVERY_FLUSHES = 10;
/** 上限保护：到达后自动停止，避免无限膨胀 */
const MAX_EVENTS = 40000;
/** 掉帧判定阈值（ms）：两帧之间超过它记一条 frame-jank（60Hz 的一帧 16.7ms） */
const FRAME_JANK_MS = 50;
/** 掉帧记录上限：防卡顿风暴时把事件池灌满、挤掉真正的指针证据 */
const MAX_JANK_RECORDS = 600;

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
	private flushes = 0;
	private jankRecords = 0;

	/** 帧间隔探针：rAF 句柄 + 上一帧时刻（0 = 还没跑起来）。 */
	private frameRaf: number | null = null;
	private lastFrameAt = 0;
	/** 主线程长任务探针（PerformanceObserver，环境不支持就没有）。 */
	private longTaskObserver: PerformanceObserver | null = null;

	/**
	 * 覆盖层状态探针（由 main 注入）。诊断卡顿要能区分「输入没来」和「画不过来」，
	 * 光看指针事件流不够：必须同时知道当时挂了几张覆盖层 canvas、页上有多少笔画、
	 * 用的是哪种笔 —— 这三样决定栅格化代价。
	 */
	private probe: (() => Record<string, unknown> | null) | null = null;

	setProbe(fn: (() => Record<string, unknown> | null) | null): void {
		this.probe = fn;
	}

	constructor(private plugin: Plugin) {}

	get recording(): boolean {
		return this.timer !== null;
	}

	start(): void {
		if (this.recording) return;
		this.records = [];
		this.seq = 0;
		this.flushes = 0;
		this.jankRecords = 0;
		this.t0 = performance.now();
		this.meta = {
			startAt: new Date().toISOString(),
			// 审核合规：OS 信息取自 Obsidian Platform API，不用 navigator 检测
			platform: Platform.isIosApp ? 'iOS' : Platform.isAndroidApp ? 'Android' : Platform.isMobile ? 'Mobile' : 'Desktop',
			screen: `${window.screen.width}x${window.screen.height} @${window.devicePixelRatio}`,
			maxTouchPoints: navigator.maxTouchPoints,
		};
		for (const type of [...POINTER_EVENTS, ...APP_EVENTS]) {
			const h = (ev: Event): void => this.record(ev);
			window.addEventListener(type, h, { capture: true, passive: true });
			this.handlers.push([type, h]);
		}
		this.timer = window.setInterval(() => void this.flush(), FLUSH_MS);
		this.startFrameProbe();
		this.startLongTaskProbe();
		this.dirty = true;
		void this.flush();
	}

	/**
	 * 帧间隔探针。rAF 回调由合成器按 vsync 派发：主线程被占住、或栅格化/合成跟不上，
	 * 都会表现为两次回调之间拉开。指针事件时间戳看不出的那类卡顿（事件照常到、
	 * 画面跟不上），只有帧间隔能看出来。平滑书写时每帧一条都不记，只在
	 * 间隔 ≥ FRAME_JANK_MS 时记一条，并附当时的覆盖层状态。
	 */
	private startFrameProbe(): void {
		this.lastFrameAt = performance.now();
		const tick = (): void => {
			if (this.timer === null) {
				this.frameRaf = null;
				return;
			}
			const now = performance.now();
			const dt = now - this.lastFrameAt;
			this.lastFrameAt = now;
			if (dt >= FRAME_JANK_MS && this.jankRecords < MAX_JANK_RECORDS) {
				this.jankRecords++;
				this.push({
					i: this.seq++,
					t: Math.round(now - this.t0),
					e: 'frame-jank',
					d: Math.round(dt),
					st: this.probe?.() ?? undefined,
				});
			}
			this.frameRaf = window.requestAnimationFrame(tick);
		};
		this.frameRaf = window.requestAnimationFrame(tick);
	}

	/** 长任务探针：>50ms 的任务会把输入与绘制一起卡住，是「主线程忙」的直接证据。 */
	private startLongTaskProbe(): void {
		try {
			if (typeof PerformanceObserver === 'undefined') return;
			const obs = new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) {
					if (this.jankRecords >= MAX_JANK_RECORDS) continue;
					this.jankRecords++;
					this.push({
						i: this.seq++,
						t: Math.round(entry.startTime - this.t0),
						e: 'longtask',
						d: Math.round(entry.duration),
						st: this.probe?.() ?? undefined,
					});
				}
			});
			obs.observe({ entryTypes: ['longtask'] });
			this.longTaskObserver = obs;
		} catch {
			this.longTaskObserver = null;
		}
	}

	private stopProbes(): void {
		if (this.frameRaf !== null) {
			window.cancelAnimationFrame(this.frameRaf);
			this.frameRaf = null;
		}
		if (this.longTaskObserver) {
			try {
				this.longTaskObserver.disconnect();
			} catch {
				/* 忽略 */
			}
			this.longTaskObserver = null;
		}
	}

	/** 停止并落盘，返回事件数与文件路径（供 Notice 展示）。 */
	async stop(reason = '手动停止'): Promise<{ count: number; path: string }> {
		if (this.timer !== null) {
			window.clearInterval(this.timer);
			this.timer = null;
		}
		this.stopProbes();
		for (const [type, h] of this.handlers) {
			window.removeEventListener(type, h, { capture: true } as EventListenerOptions);
		}
		this.handlers = [];
		if (this.records.length > 0 && this.records[this.records.length - 1].e !== 'diagnostic-stop') {
			this.push({ i: this.seq++, t: Math.round(performance.now() - this.t0), e: 'diagnostic-stop', m: reason });
		}
		await this.flush(true);
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

	/**
	 * 落盘。
	 * @param forceMd 忽略节流、立刻写 Markdown 副本（停止诊断时用，保证回传文件是最新的）。
	 */
	private async flush(forceMd = false): Promise<void> {
		if (!this.dirty) return;
		this.dirty = false;
		this.flushes++;
		// ⚠️ 逐条换行，而不是 JSON.stringify(整个对象)。
		// 两者都是合法 JSON，但单行版本会让 Obsidian 打开/索引该笔记时卡死
		//（实测：1MB 单行 JSON 让移动端工作区一直「加载中」）。换行后每行一条
		// 记录，语法高亮与逐行渲染都不会一口气吞下整份文件。
		const lines: string[] = [];
		for (const r of this.records) lines.push(JSON.stringify(r));
		const events = `[\n${lines.join(',\n')}\n]`;
		const json = `{"meta":${JSON.stringify(this.meta)},"events":${events}}`;
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
		// 每次写都要索引刷新 +（若正开着）整份重渲染，所以按 MD_EVERY_FLUSHES 节流。
		if (!forceMd && this.flushes % MD_EVERY_FLUSHES !== 0) return;
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
