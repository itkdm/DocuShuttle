const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const MAX_DOCX_BYTES = 20 * 1024 * 1024;

export class DocxFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocxFileError";
  }
}

export interface DocxCandidate {
  name: string;
  type: string;
  size: number;
  signature: Uint8Array;
}

export function validateDocxCandidate(candidate: DocxCandidate): void {
  if (!candidate.name.toLowerCase().endsWith(".docx")) {
    throw new DocxFileError("仅支持 .docx 文件，旧版 .doc 暂不支持。");
  }
  if (candidate.size === 0) throw new DocxFileError("文件为空，请重新选择有效的 Word 文档。");
  if (candidate.size > MAX_DOCX_BYTES) throw new DocxFileError("文件超过 20 MB，请压缩图片后重试。");
  if (candidate.type && candidate.type !== DOCX_MIME && candidate.type !== "application/octet-stream") {
    throw new DocxFileError("文件类型与 .docx 不匹配，请确认文件未被错误改名。");
  }
  const [first, second] = candidate.signature;
  if (first !== 0x50 || second !== 0x4b) {
    throw new DocxFileError("文件不是有效的 DOCX 压缩包，可能已损坏或只是修改了扩展名。");
  }
}

export async function readDocxFile(file: File): Promise<ArrayBuffer> {
  const bytes = await file.arrayBuffer();
  validateDocxCandidate({
    name: file.name,
    type: file.type,
    size: file.size,
    signature: new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength)),
  });
  return bytes;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function downloadLocalDocument(file: File): void {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
