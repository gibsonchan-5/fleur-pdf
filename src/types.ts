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
}
