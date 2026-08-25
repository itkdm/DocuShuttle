import { DocumentKernelError } from "../../domain/types";

export const MAX_REPLACEMENT_IMAGE_BYTES = 20 * 1024 * 1024;

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}
function ascii(bytes: Uint8Array, start: number, value: string): boolean {
  return [...value].every((character, index) => bytes[start + index] === character.charCodeAt(0));
}

export function assertSupportedImage(bytes: Uint8Array, contentType: string | undefined): void {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_REPLACEMENT_IMAGE_BYTES) {
    throw new DocumentKernelError(
      "IMAGE_SIZE_UNSUPPORTED",
      "Replacement image is empty or exceeds the V1 image size limit.",
    );
  }

  const valid =
    contentType === "image/png"
      ? startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      : contentType === "image/jpeg"
        ? startsWith(bytes, [0xff, 0xd8, 0xff])
        : contentType === "image/gif"
          ? ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a")
          : contentType === "image/bmp"
            ? ascii(bytes, 0, "BM")
            : contentType === "image/tiff"
              ? startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])
              : false;

  if (!valid) {
    throw new DocumentKernelError(
      "IMAGE_SIGNATURE_MISMATCH",
      "Replacement bytes do not match a supported existing image content type.",
    );
  }
}
