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
