// 抬笔容错的「归并判定」（纯函数模块）。
//
// ⚠️ 本文件不碰 DOM、不 import obsidian —— 因此可以脱离真机，把 esbuild 临时
// 打成 ESM 后用合成事件序列直接跑探针（纯函数模块，无副作用，随时可测）。
// 改动判定规则请同时补探针用例。
//
// 要解决的问题（两条顽疾被绑死在同一件事上）：
//   笔抬起后重新落下时，引擎必须决定「这算同一条笔画，还是新的一条」。
//   1.7.2 之前只有 pointercancel 通道（掌压黑窗，16px 内连线续写）；1.7.5 为治
//   小米平板固件的瞬时 up+hover+down（实测 24-30ms、落点可达 68px）加了 pointerup
//   通道，窗口 150ms、近端 96px。但「归并 = 把上一个落点和新落点连起来画」，
//   于是近端阈值一放宽，用户有意的第二笔就被一根 96px 内的牵丝线接了上去
//   ——「写成了连笔」。反过来收紧阈值，断触立刻回来。
//
// 解耦办法：**归并语义**（同一条笔画：橡皮整条擦、撤销一步退、同步按一条合）与
// **是否落墨那段**（笔画数据里的 gaps 断点）分成两件事。于是判定即使拿不准，
// 也可以选择「归并但不连线」，既不出牵丝线，也不把一条笔画拆成两条。
//
// 三条判据的物理依据（都是现场可测的量，不依赖任何样本拟合）：
//   ① 抬笔前的末端速度：伪抬笔是「运动中被固件报丢」，笔尖还在走，速度高；
//      有意的收笔一定是先减速停住再抬手，末端速度≈0。这是最强的一条。
//   ② 方向连续性：新落点在原运动方向的延长线上 → 连续；急转 → 换笔。
//   ③ 是否离开感应区：真抬笔通常把笔抬出接近高度，会有 pointerout；
//      固件抖一下不会。设备不发这些事件时本条自然失效，由 ①② 兜住。
//
// 1.7.10 补第 ④ 条（真机 1.7.9 采集后）：①② 都默认「笔在快速运动中」，而小米平板上
// 慢写实测的末端速度只有 0.01~0.25px/ms、pointerout 连短促的固件抖动也会发（32 次窗口内
// 归并里 19 次带 out），于是 ① 几乎永不触发、③ 又把一半正常续写判成有意提笔 ——
// 结果全落在 gap（归并不落墨）上，用户看到的就是「偶发断触」。④ 不看速度、不看感应区，
// 只看「新落点是否在抬笔前那一笔的延长线上、且跳距很短」：这是唯一与书写快慢无关、
// 又能把「同一笔被报丢」和「换一笔」分开的判据。
//
// 1.7.11 补第 ⑤ 条（真机 1.7.10 采集后）：④ 的「延长线」前提对慢写不成立——汉字笔画
// 之间本来就要换方向（实测幽灵重落转角 77~173°）。但同一批数据里 68 次抬笔重落的
// dt 分布双峰干净：固件幽灵重落全部 ≤168ms、有意提笔全部 ≥233ms。⑤ 因此以「宽限窗
// 里采到了悬停轨迹」为主证据（笔全程没离开 digitizer 视野，固件只是把接触签报丢了、
// 顺手重编了 pointerId 并紧跟 up 发 out），dt 窗口卡在双峰空档 220ms，落墨画真实
// 悬停轨迹。引擎侧配套改动见 overlay-engine.ts 的宽限采样注释。
//
// 安全性说明：判「桥接（bridge）」才落墨，判「断点（gap）」只是把这条笔画继续
// 分组而不画那段，最坏表现等同于 1.7.6（笔画断开）而不是新增一类瑕疵；而掌压
// 拒止 / 手指滚动那条通道完全不经过本模块。

/** 归并判定结果。 */
export type GraceMergeAction =
	/** 认定笔未真正离开纸面：把窗口内的悬停轨迹与新落点一起接进同一条笔画（连续落墨）。 */
	| 'bridge'
	/** 认定很可能是一次有意的提笔，但证据不足以拆成两条：继续同一条笔画，**这段不落墨**。 */
	| 'gap'
	/** 认定是有意的新笔画：旧笔画就地提交，新落点开一条新笔画。 */
	| 'commit';

/** 归并判定调参（设置页可改，引擎侧统一兜底取值范围）。 */
export interface GraceMergeTuning {
	/** 总开关。false = 完全回到 1.7.6 的近端连线行为（真机若出现断触可一键退回）。 */
	enabled: boolean;
	/** 归并窗口上限（ms）：超过它一律判 commit。 */
	windowMs: number;
	/** 近端距离上限（CSS px）：超过它一律判 commit。 */
	nearPx: number;
	/** 跳距小于此值直接桥接：连线与断开的差别已在笔宽之内，不值得为它冒险。 */
	tinyHopPx: number;
	/** 桥接所需的抬笔前末端速度下限（CSS px/ms）。 */
	bridgeMinSpeed: number;
	/** 判有意提笔所需的末端速度上限（CSS px/ms）：低于它说明笔是先停住再抬的。 */
	stopMaxSpeed: number;
	/** 桥接允许的最大转角（度）：新落点偏离原运动方向超过它就是换一笔。 */
	maxTurnDeg: number;
	/** 判「有意的收笔」所需的最小抬笔时长（ms）：比这更短，速度再低也更像固件抖动。 */
	minRealLiftMs: number;
	/**
	 * 一条笔画最多吸收几次归并（防级联：没有上限时一笔能串起一整行字）。
	 * 1.7.11 从 4 放宽到 8：真机 1.7.10 实测固件能在 850ms 里连丢 5 次接触签，
	 * 旧封顶会在第 5 次重落时留下残余断点；而每条归并通道现在都有物理证据
	 * 门槛（①速度 ④共线 ⑤悬停轨迹），级联风险远低于 1.7.6 的无条件近端连线。
	 */
	maxMerges: number;
	/** 悬停轨迹直度上限：轨迹累计长度超过「跳距×此系数 + 余量」说明笔在窝里绕，不是直着走。 */
	hoverStraighten: number;
	/** 直度判定余量（CSS px）。 */
	hoverStraightSlackPx: number;
	/**
	 * 「直行穿隙」桥接的时间上限（ms）：抬笔后多久内的共线落点仍算同一笔的直行延续。
	 *
	 * 它可以比 `windowMs` 长，因为**出这个长窗之外没有任何新行为**：引擎把 pointerup
	 * 通道的宽限拉到 `max(windowMs, collinearWindowMs)`，但判定函数在 `windowMs` 之外
	 * 只允许走「直行穿隙」这一条落墨分支，其余一律 commit —— 与拉窗之前逐字节一致。
	 * 换句话说放宽的只是「共线短跳」这一种情形的机会，不放宽任何一条已有判据。
	 */
	collinearWindowMs: number;
	/**
	 * 「直行穿隙」桥接的跳距上限（CSS px）。
	 * 这是这条判据的风险上界：万一判错，多画的那段最长就这么长（对比 ① 错判可以画到
	 * `nearPx`=96px）。真机 1.7.9 采集里被它救回的 5 例跳距是 6.1~17px。
	 */
	collinearMaxPx: number;
	/**
	 * 「直行穿隙」允许的最大转角（度）：抬笔前**较长窗口**（引擎取 140ms）的运动方向
	 * 与「最后一个接触点 → 新落点」这条弦的夹角。
	 */
	collinearMaxTurnDeg: number;
	/**
	 * 「悬停续写」桥接的时间上限（ms）：抬笔后多久内，只要宽限窗里**采到了悬停轨迹**
	 * （笔根本没离开感应区，固件只是把接触签报丢了）且落点在近端，就判同一笔并按
	 * 真实悬停轨迹落墨。
	 *
	 * 依据（真机 1.7.10 采集，1.7.11 定值）：68 次抬笔重落里，固件幽灵重落全部落在
	 * 14~168ms（30 次），有意提笔全部 ≥233ms（38 次，中位 434ms）——空档清晰。
	 * 220ms 坐在空档里：比最长的幽灵抬笔留 52ms 余量，距最短的有意提笔仍有 13ms。
	 * 悬停轨迹是比 dt 更硬的物理证据：笔能在空中画出连续轨迹，就说明 digitizer 一直
	 * 看得见它——「离开纸面又回来」的有意提笔在轨迹上必然表现为提笔前后的两段接触，
	 * 中间的悬停段又短又少。没有悬停采样的设备上本判据自动失效（hoverPathPx=0），
	 * 行为与 1.7.10 一致。
	 */
	hoverJoinWindowMs: number;
}

export const DEFAULT_GRACE_TUNING: GraceMergeTuning = {
	enabled: true,
	// 与 1.7.5 一致，先不改窗口与近端距离：那两条阈值现在的风险由 gap 兜住
	// （归并不再必然画线），把它们一起收紧会让断触风险重新叠加。
	windowMs: 150,
	nearPx: 96,
	tinyHopPx: 4,
	bridgeMinSpeed: 0.55,
	stopMaxSpeed: 0.18,
	maxTurnDeg: 60,
	minRealLiftMs: 90,
	maxMerges: 8,
	hoverStraighten: 2.2,
	hoverStraightSlackPx: 24,
	// 真机 1.7.9 采集定的三个数：44.5s 手写里 39 个抬笔落点中，只有 5 个是「共线短跳」
	// （跳距 6.1~17px、抬笔 16~101ms、空中轨迹直），其余 34 个落点处方向都改了 ——
	// 那是汉字笔画之间正常的提笔。所以窗口给到 220ms（覆盖实测最长的那次共线穿隙 154ms
	// 并留余量），跳距只给到 18px（错判的代价上限就是一根 18px 的小尾巴），转角 40°
	// （实测 5 例共 12°~38°，而被排除的 34 例全在 56° 以上，中间有清晰空档）。
	collinearWindowMs: 220,
	collinearMaxPx: 18,
	collinearMaxTurnDeg: 40,
	// 真机 1.7.10 采集定的值：幽灵重落 dt 全部 ≤168ms、有意提笔全部 ≥233ms（见字段注释）。
	hoverJoinWindowMs: 220,
};

/** 一次判定的输入证据（全部是 CSS 像素 / 毫秒，尺度与用户手感一致，不随缩放变）。 */
export interface GraceMergeEvidence {
	/** 抬笔到重新落笔的间隔。 */
	dtMs: number;
	/** 新落点距最后一个原始采样点的距离。 */
	jumpPx: number;
	/** 窗口内悬停轨迹的累计长度；没收到采样记 0。 */
	hoverPathPx: number;
	/** 抬笔前最后一段接触运动的速度；无足够样本记 -1。 */
	endSpeed: number;
	/** 末端运动方向与新落点方向的夹角（0~180）；末端无方向记 -1（未知）。 */
	turnDeg: number;
	/**
	 * 「直行穿隙」用的转角：抬笔前**较长窗口**（140ms）的运动方向与新落点方向的夹角。
	 *
	 * 为什么不复用 `turnDeg`：它只回看 60ms。真机实测单字笔画的接触时长中位数 ~350ms、
	 * 弦长 6~44px，60ms 内的位移只有 1~3px，方向完全被采样抖动支配（同一批数据里
	 * 60ms 与 120ms 窗口能差出 90°）。穿隙判据要的是「这一笔整体往哪儿走」，
	 * 所以必须用更长的窗口重新算一次方向。无足够样本记 -1（未知，判据不成立）。
	 */
	collinearTurnDeg: number;
	/** 窗口内笔是否离开过感应范围（pointerout）。 */
	leftProximity: boolean;
	/** 这条笔画此前已吸收的归并次数。 */
	mergeCount: number;
}

/** 只含数值项的键：clamp 只允许夹数值，enabled 单独走布尔分支。 */
type NumericTuningKey = {
	[K in keyof GraceMergeTuning]: GraceMergeTuning[K] extends number ? K : never;
}[keyof GraceMergeTuning];

/**
 * 把外部（设置页 / data.json）来的零散参数并进来并夹到安全区间。
 *
 * 设置项是用户可编辑的，NaN / 负数 / 极端值不能把容错整个关掉或变成连线机器，
 * 所以范围校验只在这里做一次，判定函数只管读值。
 */
export function normalizeTuning(
	base: GraceMergeTuning,
	patch: Partial<GraceMergeTuning> | null | undefined,
): GraceMergeTuning {
	if (!patch) return base;
	const out: GraceMergeTuning = { ...base };
	const clamp = (key: NumericTuningKey, lo: number, hi: number) => {
		const raw = patch[key];
		if (typeof raw !== 'number' || !Number.isFinite(raw)) return;
		out[key] = Math.min(hi, Math.max(lo, raw));
	};
	if (typeof patch.enabled === 'boolean') out.enabled = patch.enabled;
	clamp('windowMs', 40, 400);
	clamp('nearPx', 12, 200);
	clamp('tinyHopPx', 0, 24);
	clamp('bridgeMinSpeed', 0.05, 4);
	clamp('stopMaxSpeed', 0, 1.2);
	clamp('maxTurnDeg', 5, 170);
	clamp('minRealLiftMs', 20, 300);
	clamp('maxMerges', 0, 16);
	clamp('hoverStraighten', 1, 8);
	clamp('hoverStraightSlackPx', 0, 120);
	clamp('collinearWindowMs', 150, 400);
	clamp('collinearMaxPx', 4, 40);
	clamp('collinearMaxTurnDeg', 10, 90);
	clamp('hoverJoinWindowMs', 100, 400);
	// 长窗不得短于归并窗：否则引擎按 max() 拉长了宽限、判定却永远进不到穿隙分支
	if (out.collinearWindowMs < out.windowMs) out.collinearWindowMs = out.windowMs;
	// 同理：悬停续写窗短于归并窗没有意义（短窗情形 windowMs 分支本来就覆盖）
	if (out.hoverJoinWindowMs < out.windowMs) out.hoverJoinWindowMs = out.windowMs;
	// 速度阈值失序（停速 ≥ 桥速）会让两条规则互相打架，按半程修正
	if (out.stopMaxSpeed >= out.bridgeMinSpeed) {
		out.stopMaxSpeed = Math.round(out.bridgeMinSpeed * 0.35 * 1000) / 1000;
	}
	return out;
}

/** 折线路径累计长度（CSS px）。少于两点返回 0。 */
export function pathLengthPx(pts: Array<{ x: number; y: number }>): number {
	let sum = 0;
	for (let i = 1; i < pts.length; i++) {
		sum += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
	}
	return sum;
}

/** 两向量夹角（度，0~180）。任一向量为零长度返回 -1（未知）。 */
export function angleBetweenDeg(ax: number, ay: number, bx: number, by: number): number {
	const la = Math.hypot(ax, ay);
	const lb = Math.hypot(bx, by);
	if (!(la > 0) || !(lb > 0)) return -1;
	const c = (ax * bx + ay * by) / (la * lb);
	// 浮点积可能略出 [-1,1]，acos 会因此变 NaN
	return (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI;
}

/**
 * 由最近若干采样点求末端运动特征：速度（px/ms）与方向。
 *
 * 只看最后 `spanMs` 毫秒内的样本 —— 再往前的点是这一笔中段的速度，
 * 与「抬笔前是否已经停住」无关。样本不足（<2 个点或时间跨度 <8ms）判不出速度，
 * 返回 endSpeed = -1，由判定按「未知」处理。
 */
export function terminalMotion(
	pts: Array<{ x: number; y: number; at: number }>,
	spanMs = 60,
): { endSpeed: number; dirX: number; dirY: number } {
	if (pts.length < 2) return { endSpeed: -1, dirX: 0, dirY: 0 };
	const last = pts[pts.length - 1];
	const from = last.at - spanMs;
	let anchor = pts[0];
	for (const p of pts) {
		if (p.at >= from) {
			anchor = p;
			break;
		}
	}
	const dt = last.at - anchor.at;
	if (!(dt >= 8)) return { endSpeed: -1, dirX: 0, dirY: 0 };
	const dx = last.x - anchor.x;
	const dy = last.y - anchor.y;
	return { endSpeed: Math.hypot(dx, dy) / dt, dirX: dx, dirY: dy };
}

/**
 * 判一次归并落笔该怎么处理。规则按证据强度排序，先出先停。
 */
export function classifyGraceMerge(
	ev: GraceMergeEvidence,
	t: GraceMergeTuning = DEFAULT_GRACE_TUNING,
): GraceMergeAction {
	// 关掉新判定：等价 1.7.6 —— 窗口内近端一律连线续写。
	if (!t.enabled) return ev.jumpPx <= t.nearPx ? 'bridge' : 'commit';

	// 归并次数封顶：两条通道都不再吸收（放在最前，长窗分支同样受它约束）。
	if (ev.mergeCount >= t.maxMerges) return 'commit';

	// ④ 直行穿隙：笔是**一路直行穿过来的** —— 跳距很短（≤collinearMaxPx）、空中轨迹直、
	//    且新落点就在抬笔前这一笔的延长线上（140ms 窗口方向与落点弦夹角 ≤collinearMaxTurnDeg）。
	//    与 ① 的分工：① 靠「运动中掉签」的速度证据，快写才用得上；本条不看速度，
	//    慢写（真机实测末端速度 0.01~0.25px/ms，永远够不到 ① 的 0.55 下限）也桥接得到。
	//    为什么敢让它越过 windowMs：有意的第二笔必然在落点处改方向（汉字笔画之间方向都不同，
	//    实测被排除的 34 例转角全 ≥56°，与通过的 5 例 ≤38° 之间有空档），
	//    而错判的代价被跳距上限钉死在一根 ≤18px 的小尾巴上。
	//    悬停轨迹本身要采得到（`hoverPathPx > 0`）：桥接画的是笔的真实空中路径，
	//    没有轨迹就退化成把两端连直的弦，那是 1.7.6 的连笔来源，这里不做。
	const collinearHop =
		ev.jumpPx > t.tinyHopPx &&
		ev.jumpPx <= t.collinearMaxPx &&
		ev.collinearTurnDeg >= 0 &&
		ev.collinearTurnDeg <= t.collinearMaxTurnDeg &&
		ev.hoverPathPx > 0 &&
		ev.hoverPathPx <= ev.jumpPx * t.hoverStraighten + t.hoverStraightSlackPx;
	if (collinearHop && ev.dtMs <= t.collinearWindowMs) return 'bridge';

	// ⑤ 悬停续写（1.7.11，真机 1.7.10 采集定性）：窗口里**采到了悬停轨迹** =
	//    digitizer 全程看得见这支笔，固件只是把接触签报丢了（还顺手重编了 pointerId、
	//    紧跟 up 发了 out）。这样的重落不可能是「提笔-移动-落笔」的有意换笔——
	//    笔从未离开过纸面上方。判据与快慢无关：慢写（实测末端速度 0.01~0.35px/ms）
	//    用不上 ①，方向又改了（汉字笔画间转角 77~173°）用不上 ④，本条全兜住。
	//    落墨画的是**真实悬停轨迹**：那是笔尖在空中实际走过的路，不是替用户画的弦。
	//    轨迹直度沿用 ①④ 的比值上界：轨迹比跳距长得多说明笔在窝里绕，画出来不是
	//    用户预期的那条线，退回 gap（归并语义保住、这段不落墨）。没有悬停采样的
	//    设备（hoverPathPx=0）本条自然失效，其余判据原样兜底。
	const hoverJoin =
		ev.hoverPathPx > 0 &&
		ev.jumpPx <= t.nearPx &&
		ev.hoverPathPx <= ev.jumpPx * t.hoverStraighten + t.hoverStraightSlackPx;
	if (hoverJoin && ev.dtMs <= t.hoverJoinWindowMs) return 'bridge';

	// 出窗（其余判据的窗口）/ 落点过远：新笔画。
	// ⚠️ 走到这里才检查 windowMs —— 长窗之外只可能上面那条判据落墨，其余一律按新笔画处理，
	//    保证「拉长宽限」不改变任何一条既有判据的边界。
	if (!(ev.dtMs <= t.windowMs)) return 'commit';
	if (!(ev.jumpPx <= t.nearPx)) return 'commit';

	// 贴着上一个点落下：连不连线都在笔宽里，按连续处理，别浪费一次判定的风险。
	if (ev.jumpPx <= t.tinyHopPx) return 'bridge';

	const straight =
		ev.hoverPathPx <= ev.jumpPx * t.hoverStraighten + t.hoverStraightSlackPx;

	// ① 强连续：笔在运动中「被抬起」（未离开感应区、末端速度不低、方向没急转、
	//    悬停轨迹大致直着往前）→ 伪抬笔，桥接并把悬停轨迹落墨。
	//    turnDeg < 0 是「末端没方向」（笔几乎没动就抬起）—— 与 ① 的「在运动中」
	//    前提矛盾，但速度已达标的直行书写方向估计噪声大，这里放行交给 straight 判。
	if (
		!ev.leftProximity &&
		ev.endSpeed >= t.bridgeMinSpeed &&
		(ev.turnDeg < 0 || ev.turnDeg <= t.maxTurnDeg) &&
		straight
	) {
		return 'bridge';
	}

	// ③ 笔抬出过感应区，且抬笔时长已达有意提笔的量级：确实换了笔。
	if (ev.leftProximity && ev.dtMs >= t.minRealLiftMs) return 'commit';

	// ① 的反面：抬笔前笔尖已经几乎停住，且抬笔时长够长 —— 有意的收笔。
	if (ev.endSpeed >= 0 && ev.endSpeed <= t.stopMaxSpeed && ev.dtMs >= t.minRealLiftMs) {
		return 'commit';
	}

	// ② 方向急转且时长够长：新的一笔（速度判据缺位时的补充）。
	if (ev.turnDeg > t.maxTurnDeg && ev.dtMs >= t.minRealLiftMs) return 'commit';

	// 拿不准：归并语义保住（不拆笔画、不重排撤销栈），但那段不落墨。
	// 表现最好等于 1.7.6 的「笔断了」，最差也不会画出一根用户没写过的线。
	return 'gap';
}
