import { DocumentKernelError } from "../../domain/types";

export const PACKAGE_LIMITS = Object.freeze({
  maxInputBytes: 64 * 1024 * 1024,
  maxEntries: 4_096,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalUncompressedBytes: 256 * 1024 * 1024,
  maxCompressionRatio: 200,
});

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const MAX_EOCD_SEARCH = 65_557;

function failure(code: string, message: string): never {
  throw new DocumentKernelError(code, message);
}

function readUint16(view: DataView, offset: number): number {
  if (offset < 0 || offset + 2 > view.byteLength) failure("ZIP_DIRECTORY_INVALID", "ZIP directory is truncated.");
  return view.getUint16(offset, true);
}

function readUint32(view: DataView, offset: number): number {
  if (offset < 0 || offset + 4 > view.byteLength) failure("ZIP_DIRECTORY_INVALID", "ZIP directory is truncated.");
  return view.getUint32(offset, true);
}

function findEocd(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - MAX_EOCD_SEARCH);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (readUint32(view, offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  return failure("ZIP_DIRECTORY_INVALID", "ZIP end-of-central-directory record was not found.");
}

function decodeEntryName(bytes: Uint8Array, utf8: boolean): string {
  if (!utf8 && bytes.some((byte) => byte >= 0x80)) {
    return failure(
      "ZIP_ENTRY_ENCODING_UNSUPPORTED",
      "Non-ASCII ZIP entry names must use the UTF-8 filename flag.",
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return failure("ZIP_ENTRY_ENCODING_UNSUPPORTED", "ZIP entry name is not valid UTF-8.");
  }
}

function canonicalEntryName(name: string): string {
  if (
    name.length === 0 ||
    name.startsWith("/") ||
    name.includes("\\") ||
    /^[a-zA-Z]:/.test(name) ||
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    return failure("ZIP_ENTRY_PATH_UNSAFE", `ZIP entry has an unsafe package path: ${name || "<empty>"}.`);
  }

  const directory = name.endsWith("/");
  const rawSegments = name.split("/");
  if (directory) rawSegments.pop();
  if (rawSegments.length === 0 || rawSegments.some((segment) => segment.length === 0)) {
    return failure("ZIP_ENTRY_PATH_UNSAFE", `ZIP entry has an invalid package path: ${name}.`);
  }
  const segments = rawSegments.map((segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return failure("ZIP_ENTRY_PATH_UNSAFE", `ZIP entry contains invalid percent encoding: ${name}.`);
    }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
      return failure("ZIP_ENTRY_PATH_UNSAFE", `ZIP entry escapes its package path: ${name}.`);
    }
    return decoded;
  });
  return segments.join("/").toLowerCase();
}

export interface PackageDirectoryEntry {
  readonly name: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
}

/** Inspect the central directory before JSZip starts CRC decompression. */
export function preflightZipPackage(bytes: Uint8Array): readonly PackageDirectoryEntry[] {
  if (bytes.byteLength > PACKAGE_LIMITS.maxInputBytes) {
    failure("ZIP_INPUT_TOO_LARGE", "DOCX exceeds the compressed package size limit.");
  }
  if (bytes.byteLength < 22) failure("ZIP_DIRECTORY_INVALID", "DOCX is too small to be a ZIP package.");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view);
  const disk = readUint16(view, eocd + 4);
  const centralDisk = readUint16(view, eocd + 6);
  const entriesOnDisk = readUint16(view, eocd + 8);
  const entryCount = readUint16(view, eocd + 10);
  const centralSize = readUint32(view, eocd + 12);
  const centralOffset = readUint32(view, eocd + 16);
  const commentLength = readUint16(view, eocd + 20);
  if (eocd + 22 + commentLength !== bytes.byteLength) {
    failure("ZIP_DIRECTORY_INVALID", "ZIP contains trailing or truncated end-record data.");
  }
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    failure("ZIP_MULTIDISK_UNSUPPORTED", "Multi-disk ZIP packages are not supported.");
  }
  if (
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    failure("ZIP64_UNSUPPORTED", "ZIP64 packages are not supported by the V1 kernel.");
  }
  if (entryCount > PACKAGE_LIMITS.maxEntries) {
    failure("ZIP_TOO_MANY_ENTRIES", "DOCX exceeds the package entry count limit.");
  }
  if (centralOffset + centralSize > eocd) {
    failure("ZIP_DIRECTORY_INVALID", "ZIP central directory points outside the package.");
  }

  const names = new Set<string>();
  const entries: PackageDirectoryEntry[] = [];
  let totalUncompressed = 0;
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (readUint32(view, cursor) !== CENTRAL_DIRECTORY_ENTRY) {
      failure("ZIP_DIRECTORY_INVALID", "ZIP central directory entry signature is invalid.");
    }
    const flags = readUint16(view, cursor + 8);
    const compressedSize = readUint32(view, cursor + 20);
    const uncompressedSize = readUint32(view, cursor + 24);
    const nameLength = readUint16(view, cursor + 28);
    const extraLength = readUint16(view, cursor + 30);
    const entryCommentLength = readUint16(view, cursor + 32);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      failure("ZIP64_UNSUPPORTED", "ZIP64 package entries are not supported by the V1 kernel.");
    }
    const nameStart = cursor + 46;
    const next = nameStart + nameLength + extraLength + entryCommentLength;
    if (next > centralOffset + centralSize || next > view.byteLength) {
      failure("ZIP_DIRECTORY_INVALID", "ZIP central directory entry is truncated.");
    }
    const name = decodeEntryName(bytes.subarray(nameStart, nameStart + nameLength), (flags & 0x800) !== 0);
    const canonical = canonicalEntryName(name);
    if (names.has(canonical)) {
      failure("ZIP_ENTRY_PATH_COLLISION", `ZIP contains colliding package paths: ${name}.`);
    }
    names.add(canonical);

    if (uncompressedSize > PACKAGE_LIMITS.maxEntryBytes) {
      failure("ZIP_ENTRY_TOO_LARGE", `ZIP entry exceeds the uncompressed size limit: ${name}.`);
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > PACKAGE_LIMITS.maxTotalUncompressedBytes) {
      failure("ZIP_EXPANSION_TOO_LARGE", "DOCX exceeds the total uncompressed size limit.");
    }
    if (
      uncompressedSize > 0 &&
      (compressedSize === 0 || uncompressedSize / compressedSize > PACKAGE_LIMITS.maxCompressionRatio)
    ) {
      failure("ZIP_COMPRESSION_RATIO_EXCEEDED", `ZIP entry has an unsafe compression ratio: ${name}.`);
    }
    entries.push({ name, compressedSize, uncompressedSize });
    cursor = next;
  }
  if (cursor !== centralOffset + centralSize) {
    failure("ZIP_DIRECTORY_INVALID", "ZIP central directory size does not match its entries.");
  }
  return entries;
}

export function assertLoadedEntryPath(originalName: string | undefined, safeName: string): void {
  if (originalName !== undefined && originalName !== safeName) {
    failure("ZIP_ENTRY_PATH_REWRITTEN", `JSZip rewrote an unsafe package path: ${originalName}.`);
  }
}
