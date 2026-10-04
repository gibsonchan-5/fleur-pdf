/**
 * FleurDict 查词桥接：把 FleurDict 的查词管线（有道 / Free Dictionary + 弹窗 +
 * 生词本 + AI 详解）接入 fleur-pdf 的选区工具条。（移植自 fleur-epub 同名模块）
 *
 * 设计约束：
 * - 跨插件调用不 import：运行时从 app.plugins 取 fleurdict 实例，逐能力特性检测
 *   （lookupWordAt 需 FleurDict ≥ 1.5.12），缺能力即降级，绝不抛错。
 * - FleurDict 不在场时用户体验零变化：查词走内置词典弹窗，已有 AI 解释 / 翻译不受影响。
 * - 生词本分流由宿主设置决定：同步开 → 写入 FleurDict 词库（闪卡 / 词高亮 / 欧路同步
 *   全链路复用）；同步关 → 写入 fleur-pdf 自有生词本（plugin data），不碰 FleurDict 数据。
 */

/** 从 fleurdict 实例上探测到的最小能力面（运行时鸭子类型，不 import 其类型） */
export interface FleurDictBridge {
	/** ≥1.5.12：查询并在指定宿主坐标弹出查词窗；返回 false = 未弹出 */
	lookupWordAt: (
		word: string,
		x: number,
		y: number,
		opts?: {
			source?: 'youdao' | 'free-dict' | 'both';
			onAddToWordbook?: () => void;
			onAIDetail?: () => void;
		},
	) => Promise<boolean>;
	/** ≥1.5.12：加入生词本全管线（查释义、刷新高亮、同步欧路） */
	addToWordbook: (word: string, context?: string) => Promise<unknown>;
	/** 词典引擎（独立生词本也要用它查释义；同步关时复用查询、不写它的词库） */
	dictEngine?: {
		query: (word: string, sourceOverride?: 'youdao' | 'free-dict' | 'both') => Promise<Array<{ source: string; entries: unknown[] }>>;
	};
	/** 生词本管理器（缺失时只用本地词库） */
	wordbookManager?: {
		getAllEntries: () => Array<{ word: string; meaning: string; phonetic: string }>;
	};
}

/** 探测 FleurDict 并返回桥接对象；未安装 / 版本过旧返回 null */
export function getFleurDictBridge(app: unknown): FleurDictBridge | null {
	// App.plugins 是内部字段（公开类型未声明），运行时稳定存在
	const fd = (app as { plugins?: { plugins?: Record<string, any> } })?.plugins?.plugins?.['fleurdict'];
	if (!fd || typeof fd.lookupWordAt !== 'function' || typeof fd.addToWordbook !== 'function') return null;
	return fd as FleurDictBridge;
}

/**
 * 判断选中文本是否适合查词（单词 / 短语）：
 * 仅英文字母与常用连字符 / 撇号 / 空格，词数 ≤ 4（超过按句子处理）。
 * 与 FleurDict 的 isPhrase（含空格即短语）兼容——短语同样走查词窗。
 */
export function isDictWord(text: string): boolean {
	const t = text.trim();
	if (!t) return false;
	if (!/^[A-Za-z][A-Za-z''\- ]*$/.test(t)) return false;
	return t.split(/\s+/).length <= 4;
}

/** 查询释义文本（供独立生词本落词时填充），提取逻辑与 FleurDict 内部同构；失败返回空串 */
export async function queryMeaning(bridge: FleurDictBridge, word: string): Promise<{ meaning: string; phonetic: string }> {
	try {
		const results = await bridge.dictEngine?.query(word);
		const entry = results?.[0]?.entries?.[0] as any;
		if (!entry) return { meaning: '', phonetic: '' };
		// meanings[].definitions[].definition，词性前缀 + 全义项（对齐 fleurdict getAllDefinitions）
		const meaning: string = (entry.meanings ?? [])
			.map((m: any) => {
				const defs: string = (m.definitions ?? []).map((d: any) => d.definition).join('；');
				return m.partOfSpeech && defs ? `${m.partOfSpeech} ${defs}` : defs;
			})
			.filter(Boolean)
			.join('；');
		const phonetic: string = entry.phonetics?.find((p: any) => p.text)?.text ?? '';
		return { meaning, phonetic };
	} catch {
		return { meaning: '', phonetic: '' };
	}
}
