import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Tool } from '../types/index.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const PDF_EXTENSIONS = new Set(['.pdf']);

export function createVisionTools(cwd: string): Tool[] {
  return [
    {
      name: 'read_image',
      description: 'Read an image file and return its base64 content for vision analysis',
      parameters: {
        path: {
          type: 'string',
          description: 'Path to the image file',
          required: true,
        },
      },
      async execute(args) {
        const filePath = resolve(cwd, args.path as string);
        const ext = '.' + filePath.split('.').pop()?.toLowerCase();

        if (!IMAGE_EXTENSIONS.has(ext)) {
          return `Unsupported image format: ${ext}. Supported: ${Array.from(IMAGE_EXTENSIONS).join(', ')}`;
        }

        try {
          const buffer = await readFile(filePath);
          const base64 = buffer.toString('base64');
          const mimeType = getMimeType(ext);

          return JSON.stringify({
            type: 'image',
            mimeType,
            base64: base64.slice(0, 100) + '...[truncated]',
            size: buffer.length,
            note: 'Image loaded. Use this data with a vision-capable model.',
          });
        } catch (err) {
          return `Error reading image: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'read_pdf',
      description: 'Read a PDF file and extract its text content',
      parameters: {
        path: {
          type: 'string',
          description: 'Path to the PDF file',
          required: true,
        },
      },
      async execute(args) {
        const filePath = resolve(cwd, args.path as string);
        const ext = '.' + filePath.split('.').pop()?.toLowerCase();

        if (!PDF_EXTENSIONS.has(ext)) {
          return 'Not a PDF file. Use read_file for text files.';
        }

        try {
          // Read raw PDF and extract readable text (basic extraction)
          const buffer = await readFile(filePath);
          const text = extractPdfText(buffer);

          if (!text.trim()) {
            return 'PDF appears to contain no extractable text (may be image-based).';
          }

          return text.slice(0, 50000) + (text.length > 50000 ? '\n\n[...truncated]' : '');
        } catch (err) {
          return `Error reading PDF: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  ];
}

function getMimeType(ext: string): string {
  const mimeMap: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

function extractPdfText(buffer: Buffer): string {
  // Basic PDF text extraction - finds text between BT/ET markers
  const content = buffer.toString('latin1');
  const textParts: string[] = [];

  // Extract text from Tj and TJ operators
  const tjRegex = /\(([^)]+)\)\s*Tj/g;
  let match;
  while ((match = tjRegex.exec(content)) !== null) {
    textParts.push(match[1]);
  }

  const tjsRegex = /\[([^\]]+)\]\s*TJ/g;
  while ((match = tjsRegex.exec(content)) !== null) {
    const inner = match[1];
    const strRegex = /\(([^)]+)\)/g;
    let innerMatch;
    while ((innerMatch = strRegex.exec(inner)) !== null) {
      textParts.push(innerMatch[1]);
    }
  }

  return textParts.join(' ').replace(/\\[rn]/g, '\n');
}
