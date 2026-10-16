// 类型定义
export interface Annotation {
  id: string;
  type: 'highlight' | 'underline' | 'comment';
  page: number;
  endPage?: number; // 跨页标注的结束页码
  text: string;
  comment?: string;
  color?: string;
  underlineStyle?: 'solid' | 'wavy';
  createdAt: number;
  /**
   * 最近一次内容修改时刻（编辑批注时更新；新建=createdAt）。
   * 跨设备同步的编辑冲突按此时间后写者胜；历史数据可能没有（缺省视为本端胜）。
   */
  updatedAt?: number;
  /**
   * 选区起点在该页内的相对位置（相对 .page 元素左上角，单位 px）。
   * 用于「按行文顺序」排序；历史数据可能没有，排序时会退化为按时间。
   */
  pos?: { top: number; left: number };
}

export interface AIResult {
  id: string;
  text: string;
  question: string;
  answer: string;
  createdAt: number;
}

export interface PDFAnnotationData {
  fileId: string;
  annotations: Annotation[];
  aiResults?: AIResult[];
  /**
   * 删除墓碑：标注/AI 结果 id → 删除时刻 ms。
   * 以前只存会话内存（deletedAnnIds），跨设备同步开启后持久化到本文件，
   * 并随同步副本（FleurPDF/data/annotations/）走 —— 否则 A 端删除会被 B 端旧数据复活。
   */
  tombstones?: Record<string, number>;
}
