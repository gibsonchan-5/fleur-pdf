/**
 * AI 提示词预设
 *
 * 设计要点：
 * - 预设只定义「角色定位」（body），不含字数约束。
 * - 字数约束由调用场景决定，动态追加：
 *   · 侧边栏批注 → 需要精炼，基准 250 字（原文过长时放宽）
 *   · 右键询问AI → 对话场景，不设字数限制
 * - 用户在设置界面不选时走 default，行为与旧版一致。
 */

export type PromptPresetKey =
  | 'default'
  | 'encyclopedia'
  | 'academic'
  | 'english'
  | 'classical'
  | 'custom';

export interface PromptPreset {
  key: PromptPresetKey;
  label: string;
  /** 设置项里展示的一句话定位说明 */
  desc: string;
  /** 角色定位与要求，不含字数约束（字数由调用场景追加） */
  body: string;
  /**
   * 「询问AI」场景下追加在用户消息末尾的引导语，
   * 让对话入口也能体现该模式的侧重点；custom 为空表示不做引导。
   */
  askHint: string;
}

export const PROMPT_PRESETS: PromptPreset[] = [
  {
    key: 'default',
    label: '默认',
    desc: '文献批注：释义、要点、深层含义',
    body:
      '你是一位专业的文献阅读助手。请根据用户选中的文本，给出简明扼要的解读，包括：关键词释义、核心要点、深层含义。表述应简洁有力，适合用作阅读笔记。请用中文回答。',
    askHint: '请解释这段内容的含义，包括关键词释义、背景要点和深层逻辑。',
  },
  {
    key: 'encyclopedia',
    label: '通识百科助手',
    desc: '讲解文中知识点：是什么、从何来、为何重要',
    body: [
      '你是一位学识渊博的通识百科顾问。用户会选中一段文本，请你：',
      '1. 识别其中值得解释的知识点——关键名词、概念、人物、事件、现象或专有名词；',
      '2. 像撰写百科词条那样补充解释：它是什么、源起何处、为什么重要、与哪些常识相关联；',
      '3. 若该段只是普通叙述、没有需要专门解释的知识点，就退而提炼这段话的事实要点。',
      '要求：说法准确，通俗好懂，不堆砌术语，不臆测；可适当补充原文之外的背景常识，但不要离题。请用中文回答。',
    ].join('\n'),
    askHint: '请讲解这段内容涉及的知识点，说清它是什么、从何而来、为什么重要。',
  },
  {
    key: 'academic',
    label: '学术文献阅读助手',
    desc: '拆解论证结构，含方法论评价与可追问之处',
    body: [
      '你是一位严谨的学术论文阅读助手，擅长拆解论证结构。请针对用户选中的文本：',
      '1. 判定它在全文论证中的角色——是研究问题、研究方法、数据来源、实证结果、结论主张、研究局限，还是与既有文献的对话；',
      '2. 概括其核心论点；若涉及关键概念或理论构念，点出它的操作化定义与度量方式；',
      '3. 给出一两句简短的方法论评价或可追问之处，例如样本代表性、因果识别策略、内生性处理、变量度量误差、与同类文献的分歧。',
      '要求：术语保留学科惯用写法，除非必要不做通俗化改写；明确区分"作者主张"与"你的评价"。请用中文回答。',
    ].join('\n'),
    askHint: '请说明这段内容在全文论证中扮演的角色，并指出值得追问之处。',
  },
  {
    key: 'english',
    label: '英语阅读助手',
    desc: '译文 + 词汇短语精讲 + 句法拆解',
    body: [
      '你是一位英语阅读与语言学习助手。请针对用户选中的英文文本：',
      '0. 先判断选中内容的长度：若只是单个单词或短语，就直接针对该单词或短语本身讲解——音标、词性、核心释义、常见搭配与一两个例句，并简要说明词源或易混词（如适用）；不要抱怨没有上下文，也不要索要完整句子。',
      '1. 若是句子或段落，先给出忠实流畅的中文译文；',
      '2. 挑出其中的高频词、难词、短语动词、习语或固定搭配，标注音标并给出贴合此处语境的释义（一词多义时只取本句义项）；',
      '3. 若有值得留意的句法现象——倒装、虚拟语气、嵌套从句、分词作状语、省略或插入——用一句话拆解其结构。',
      '要求：讲解用中文，词条、例句与术语保留英文原文；译文要自然，不要逐字硬译。',
    ].join('\n'),
    askHint: '请讲解这段英文，给出译文、重点词汇与句法结构；若选中的只是单词或短语，则直接讲解该词或短语本身。',
  },
  {
    key: 'classical',
    label: '古汉语阅读助手',
    desc: '文言串讲 + 训诂注释 + 典章典故',
    body: [
      '你是一位精通文字、音韵、训诂与典章制度的文言阅读助手。请针对用户选中的文言文本：',
      '1. 给出紧贴原文的现代汉语串讲，逐句对应，不随意发挥；',
      '2. 逐条解释关键字词：重点实词、虚词用法，以及特殊语言现象——通假字、古今字、词类活用、使动与意动、宾语前置、定语后置、状语后置、省略与倒装；',
      '3. 注明涉及的人名、地名、职官、典故、名物制度等文化背景；',
      '4. 若存在常见误读或重要异文，简要提示。',
      '要求：用中文回答，释义须有训诂依据，不望文生训；串讲与注释分开列出，眉目清楚。',
    ].join('\n'),
    askHint: '请串讲这段文言，并解释关键字词与其中涉及的典故、制度。',
  },
  {
    key: 'custom',
    label: '自定义',
    desc: '使用下方文本框里你自己写的提示词',
    body: '',
    askHint: '',
  },
];

/** 按 key 取预设；key 无效时返回 undefined */
export function getPromptPreset(key: string): PromptPreset | undefined {
  return PROMPT_PRESETS.find((p) => p.key === key);
}

// ── 字数限制 ──

/** 侧边栏批注的基准字数上限 */
export const ANNOTATION_BASE_LIMIT = 250;
/** 原文过长时放宽到的最高上限，避免批注失控 */
export const ANNOTATION_MAX_LIMIT = 600;

/**
 * 侧边栏批注的字数上限。
 * 原文不长时保持 250 字；一旦原文超出基准，超出部分的 80% 计入放宽额度，
 * 这样原文越长、批注可以写得越充分，但始终要求压缩，最高 600 字封顶。
 * 例：100 字 → 250；300 字 → 290；500 字 → 450；1000 字 → 600（封顶）。
 */
export function resolveAnnotationLimit(sourceTextLength: number): number {
  if (!sourceTextLength || sourceTextLength <= ANNOTATION_BASE_LIMIT) {
    return ANNOTATION_BASE_LIMIT;
  }
  const extra = sourceTextLength - ANNOTATION_BASE_LIMIT;
  const limit = ANNOTATION_BASE_LIMIT + Math.ceil(extra * 0.8);
  return Math.min(limit, ANNOTATION_MAX_LIMIT);
}

export interface ResolveOptions {
  /** 是否追加字数约束。侧边栏批注为 true；询问AI 等对话场景为 false */
  applyLimit?: boolean;
  /** 选中原文的长度，用于「原文过长则放宽」的例外判断 */
  sourceTextLength?: number;
}

/** 自定义提示词里是否已经在讲字数（有就不重复追加，免得和用户的意图打架） */
const USER_LIMIT_PATTERN = /\d+\s*字/;

/**
 * 解析出本次请求真正要用的系统提示词。
 *
 * @param presetKey    设置里选的模式
 * @param customPrompt 自定义模式下的用户文本
 * @param opts         applyLimit=true 时按场景追加字数约束
 */
export function resolveSystemPrompt(
  presetKey: string,
  customPrompt: string,
  opts: ResolveOptions = {}
): string {
  const preset = getPromptPreset(presetKey);
  let base: string;
  let isCustom = false;

  if (preset?.key === 'custom') {
    const trimmed = customPrompt?.trim();
    if (trimmed) {
      base = trimmed;
      isCustom = true;
    } else {
      base = PROMPT_PRESETS[0].body; // 自定义留空 → 回落默认
    }
  } else {
    base = preset?.body || PROMPT_PRESETS[0].body;
  }

  if (!opts.applyLimit) return base;

  // 用户自己写的提示词里已经提到字数，就不再画蛇添足
  if (isCustom && USER_LIMIT_PATTERN.test(base)) return base;

  const srcLen = opts.sourceTextLength ?? 0;
  const limit = resolveAnnotationLimit(srcLen);

  // 上限真的被放宽了才用「放宽」的措辞，否则就是常规约束
  if (limit > ANNOTATION_BASE_LIMIT) {
    return `${base}\n\n注意：本次选中的原文较长（约 ${srcLen} 字），字数限制相应放宽到 ${limit} 字以内；仍需精炼，不要逐句复述原文。`;
  }
  return `${base}\n\n要求：字数控制在 ${limit} 字以内。`;
}

/**
 * 「询问AI」场景下追加到用户消息末尾的引导语。
 * 自定义模式返回空串——用户自己的提示词已经说明了要什么。
 */
export function resolveAskHint(presetKey: string): string {
  const preset = getPromptPreset(presetKey);
  return preset?.askHint ?? '';
}

/** 设置界面预览：角色定位 + 侧边栏批注场景下的默认字数约束 */
export function getPresetPreview(preset: PromptPreset): string {
  return `${preset.body}\n\n要求：字数控制在 ${ANNOTATION_BASE_LIMIT} 字以内。`;
}
