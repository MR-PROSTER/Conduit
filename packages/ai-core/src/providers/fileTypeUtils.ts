/**
 * File type detection utilities for attachment handling.
 *
 * Browsers often assign wrong or generic MIME types to source code files.
 * For example:
 *   - .ts files → 'video/mp2t' (TypeScript misidentified as MPEG-2 transport stream)
 *   - .py, .go, .rs → 'text/plain' or 'application/octet-stream'
 *   - .json → 'application/json'
 *   - .jsx/.tsx → 'text/javascript' or 'application/octet-stream'
 *
 * We use the file extension as the ground truth when the MIME type is ambiguous.
 */

/** Extensions that are always text/code regardless of MIME type */
const TEXT_EXTENSIONS = new Set([
  // TypeScript / JavaScript
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  // Web
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'svg',
  // Data / config
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'env', 'xml',
  // Backend languages
  'py', 'rb', 'php', 'java', 'kt', 'kts', 'scala',
  'go', 'rs', 'c', 'h', 'cpp', 'cc', 'cxx', 'hpp',
  'cs', 'fs', 'fsx', 'swift', 'dart',
  // Shell / scripts
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  // Markup / docs
  'md', 'mdx', 'txt', 'rst', 'adoc', 'tex',
  // Database / query
  'sql', 'graphql', 'gql',
  // Config files
  'dockerfile', 'makefile', 'gitignore', 'prettierrc',
  'eslintrc', 'babelrc', 'editorconfig',
  // Other
  'csv', 'tsv', 'log',
]);

/** Binary extensions — never try to decode these as text */
const BINARY_EXTENSIONS = new Set([
  'docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt',
  'zip', 'tar', 'gz', 'bz2', 'rar', '7z',
  'exe', 'dll', 'so', 'dylib', 'wasm',
  'mp3', 'mp4', 'wav', 'avi', 'mov', 'mkv',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp',
  'ttf', 'woff', 'woff2', 'eot',
  'bin', 'dat', 'db', 'sqlite',
]);

/** Extract file extension (lowercased, no dot) from filename */
export function getExtension(fileName?: string): string {
  if (!fileName) return '';
  const parts = fileName.toLowerCase().split('.');
  return parts.length > 1 ? parts[parts.length - 1]! : '';
}

/** Returns true if this file should be decoded as UTF-8 text */
export function isTextMimeType(mimeType: string, fileName?: string): boolean {
  const ext = getExtension(fileName);

  // Extension takes priority — overrides wrong browser MIME types
  if (ext && TEXT_EXTENSIONS.has(ext)) return true;
  if (ext && BINARY_EXTENSIONS.has(ext)) return false;

  // Fall back to MIME type
  if (mimeType.startsWith('text/')) return true;
  if (mimeType === 'application/json') return true;
  if (mimeType === 'application/javascript') return true;
  if (mimeType === 'application/typescript') return true;
  if (mimeType === 'application/xml') return true;
  if (mimeType === 'application/x-sh') return true;
  if (mimeType === 'application/graphql') return true;
  // video/mp2t is the wrong MIME for .ts files — handled by extension check above

  return false;
}

/** Returns true if this file is a real image (not a misidentified .ts etc.) */
export function isImageMimeType(mimeType: string, fileName?: string): boolean {
  const ext = getExtension(fileName);
  // .ts extension = TypeScript, not a transport stream — never an image
  if (ext === 'ts' || ext === 'tsx') return false;
  return mimeType.startsWith('image/');
}

/** Pick a display icon for the attachment chip based on file type */
export function getFileIcon(mimeType: string, fileName?: string): string {
  const ext = getExtension(fileName);

  if (mimeType === 'application/pdf') return '📄';
  if (isImageMimeType(mimeType, fileName)) return '🖼️';

  // Code files
  if (['ts', 'tsx', 'js', 'jsx', 'mjs'].includes(ext)) return '{ }';
  if (['py'].includes(ext)) return '🐍';
  if (['json', 'jsonc', 'yaml', 'yml', 'toml'].includes(ext)) return '{ }';
  if (['md', 'mdx', 'txt', 'rst'].includes(ext)) return '📝';
  if (['html', 'htm', 'css', 'scss'].includes(ext)) return '🌐';
  if (['sql', 'graphql', 'gql'].includes(ext)) return '🗃️';
  if (['sh', 'bash', 'zsh', 'ps1', 'bat'].includes(ext)) return '⚙️';
  if (['csv', 'tsv'].includes(ext)) return '📊';
  if (['zip', 'tar', 'gz', 'rar', '7z'].includes(ext)) return '🗜️';
  if (['docx', 'doc'].includes(ext)) return '📝';
  if (['xlsx', 'xls'].includes(ext)) return '📊';
  if (mimeType.startsWith('text/')) return '📝';

  return '📎';
}
