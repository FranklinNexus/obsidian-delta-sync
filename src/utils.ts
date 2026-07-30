const encoder = new TextEncoder();

export const MAX_INLINE_TREE_CONTENT_BYTES = 256 * 1024;

export function inlineTreeContent(bytes: Uint8Array): string | null {
  if (bytes.byteLength > MAX_INLINE_TREE_CONTENT_BYTES || bytes.includes(0)) return null;
  try {
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const encoded = encoder.encode(content);
    if (encoded.byteLength !== bytes.byteLength) return null;
    for (let index = 0; index < bytes.byteLength; index += 1) {
      if (encoded[index] !== bytes[index]) return null;
    }
    return content;
  } catch {
    return null;
  }
}

export function needsReleaseAsset(bytes: Uint8Array): boolean {
  return inlineTreeContent(bytes) === null;
}

const RELEASE_ASSET_EXTENSIONS = new Set([
  "7z",
  "avi",
  "bin",
  "bmp",
  "doc",
  "docx",
  "fig",
  "flac",
  "gif",
  "heic",
  "ico",
  "jpeg",
  "jpg",
  "m4a",
  "mat",
  "mkv",
  "mov",
  "mp3",
  "mp4",
  "ogg",
  "pdf",
  "png",
  "ppt",
  "pptx",
  "rar",
  "tif",
  "tiff",
  "wav",
  "webm",
  "webp",
  "xls",
  "xlsx",
  "zip",
]);

export function mayNeedReleaseAsset(path: string, size: number): boolean {
  if (size > MAX_INLINE_TREE_CONTENT_BYTES) return true;
  const extension = path.split(".").at(-1)?.toLowerCase();
  return extension !== undefined && RELEASE_ASSET_EXTENSIONS.has(extension);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/\s/g, "");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
}

export async function gitBlobSha(bytes: Uint8Array): Promise<string> {
  const header = encoder.encode(`blob ${bytes.length}\0`);
  const input = new Uint8Array(header.length + bytes.length);
  input.set(header);
  input.set(bytes, header.length);
  return toHex(await crypto.subtle.digest("SHA-1", input));
}

export function normalizeVaultPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function globMatches(path: string, glob: string): boolean {
  const normalizedGlob = normalizeVaultPath(glob.trim());
  if (!normalizedGlob) return false;
  const marker = "\u0000";
  const source = escapeRegex(normalizedGlob)
    .replaceAll("**", marker)
    .replaceAll("*", "[^/]*")
    .replaceAll(marker, ".*");
  return new RegExp(`^${source}$`, "u").test(normalizeVaultPath(path));
}

const DEFAULT_EXCLUDES = [
  ".obsidian/**",
  ".trash/**",
  ".git/**",
  ".delta-sync-assets.json",
  ".delta-sync-test-marker",
  "**/.DS_Store",
  "**/*.sync-conflict-*.tmp",
];

export function shouldExclude(path: string, userPatterns: string[]): boolean {
  return [...DEFAULT_EXCLUDES, ...userPatterns].some((pattern) => globMatches(path, pattern));
}

export function conflictPath(path: string, source: string, timestamp = new Date()): string {
  const safeSource = source.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "remote";
  const stamp = timestamp.toISOString().replace(/[:.]/g, "-");
  const slash = path.lastIndexOf("/");
  const directory = slash >= 0 ? path.slice(0, slash + 1) : "";
  const filename = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return `${directory}${filename}.sync-conflict-${safeSource}-${stamp}`;
  return `${directory}${filename.slice(0, dot)}.sync-conflict-${safeSource}-${stamp}${filename.slice(dot)}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
