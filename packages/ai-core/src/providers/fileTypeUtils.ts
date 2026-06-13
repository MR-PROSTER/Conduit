const MIME_BY_EXTENSION: Record<string, string> = {
  ".aac": "audio/aac",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".html": "text/html",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".md": "text/markdown",
  ".mjs": "text/javascript",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ts": "text/typescript",
  ".txt": "text/plain",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".xml": "application/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml"
};

export function getMimeTypeFromFileName(fileName: string): string {
  const lower = fileName.toLowerCase();
  const match = Object.keys(MIME_BY_EXTENSION).find((extension) => lower.endsWith(extension));
  return match ? MIME_BY_EXTENSION[match] : "application/octet-stream";
}

export function hasVisionMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}
