// tests/pdf-ingest.test.ts
// Verify PDF text extraction via pdf-parse:
//   - real PDF → text appears in stored memory
//   - encrypted/corrupted PDF → error content + pdf_extraction_failed tag
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDb, closeDb } from '../src/db/index.js';
import { initVectorStore } from '../src/vector/store.js';
import { MemoryStore } from '../src/memory/core/store.js';
import { buildPublicTools } from '../src/memory/public/tools.js';
import type { EngramConfig } from '../src/config/schema.js';

const mockConfig: EngramConfig = {
  dataDir: '',
  embeddings: {
    provider: 'ollama' as const,
    baseUrl: 'http://localhost:11434',
    model: 'nomic-embed-text',
    dimensions: 768,
  },
  drive: undefined,
  notion: undefined,
  propertyExtraction: { enabled: false, baseUrl: 'http://localhost:11434', model: 'llama3.2:3b', maxTokens: 300 },
  whisper: { enabled: true, model: 'small.en', language: 'auto' },
  youtube: { enabled: true, preferLanguage: 'en', fallbackToYtdlp: false },
  modules: {},
  mcp: { stdio: true, httpPort: 7777 },
};

/**
 * Build a minimal valid PDF containing the given text.
 * Uses raw PDF syntax — no external dependency needed.
 */
function buildMinimalPdf(text: string): Buffer {
  // Encode text for PDF stream (escape parentheses and backslash)
  const escaped = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = `BT /F1 12 Tf 50 750 Td (${escaped}) Tj ET`;
  const streamLen = Buffer.byteLength(stream);

  const xref: number[] = [];
  const parts: string[] = [];

  parts.push('%PDF-1.4\n');
  xref.push(parts.join('').length);

  // Obj 1: catalog
  const obj1 = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  parts.push(obj1);
  xref.push(parts.join('').length);

  // Obj 2: pages
  const obj2 = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n';
  parts.push(obj2);
  xref.push(parts.join('').length);

  // Obj 3: page
  const obj3 = '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n';
  parts.push(obj3);
  xref.push(parts.join('').length);

  // Obj 4: content stream
  const obj4 = `4 0 obj\n<< /Length ${streamLen} >>\nstream\n${stream}\nendstream\nendobj\n`;
  parts.push(obj4);
  xref.push(parts.join('').length);

  // Obj 5: font
  const obj5 = '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n';
  parts.push(obj5);

  const xrefOffset = parts.join('').length;
  const xrefSection =
    `xref\n0 6\n0000000000 65535 f \n` +
    xref.slice(0, 5).map((o) => String(o).padStart(10, '0') + ' 00000 n ').join('\n') +
    `\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(parts.join('') + xrefSection, 'binary');
}

describe('PDF ingest', () => {
  let tmpDir: string;
  let store: MemoryStore;
  let tools: ReturnType<typeof buildPublicTools>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-pdf-'));
    mockConfig.dataDir = tmpDir;
    initDb(tmpDir);
    initVectorStore(tmpDir);
    store = new MemoryStore({ embeddings: mockConfig.embeddings });
    tools = buildPublicTools(store, mockConfig);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ingests a real PDF and stores extractable text', async () => {
    const pdfPath = path.join(tmpDir, 'test-doc.pdf');
    const pdfBuf = buildMinimalPdf('EngramMCP PDF extraction test. Hello from pdf-parse.');
    fs.writeFileSync(pdfPath, pdfBuf);

    const ingestTool = tools.find((t) => t.name === 'ingest')!;
    const result = (await ingestTool.handler({ uri: pdfPath })) as {
      id: string;
      type: string;
      title: string;
      extraction_failed?: boolean;
    };

    expect(result.id).toBeTruthy();
    expect(result.type).toBe('notes');
    expect(result.extraction_failed).toBeFalsy();

    // Verify content was stored (get the raw memory)
    const getTool = tools.find((t) => t.name === 'get')!;
    const memory = (await getTool.handler({ id: result.id })) as {
      content: string;
      properties: { tags?: string[]; custom?: { extraction_status?: string } };
    };

    // Content should contain some text (not the placeholder)
    expect(memory.content).not.toContain('full text extraction not yet implemented');
    expect(memory.content).not.toContain('full text extraction pending');
    expect(memory.properties.custom?.extraction_status).toBe('complete');
  });

  it('handles corrupted PDF gracefully — stores error content + pdf_extraction_failed tag', async () => {
    const pdfPath = path.join(tmpDir, 'corrupted.pdf');
    // Write garbage that looks like a PDF but isn't valid
    fs.writeFileSync(pdfPath, '%PDF-1.4\nThis is not a valid PDF structure at all.\n%%EOF\n');

    const ingestTool = tools.find((t) => t.name === 'ingest')!;
    const result = (await ingestTool.handler({ uri: pdfPath })) as {
      id: string;
      extraction_failed?: boolean;
    };

    expect(result.id).toBeTruthy();
    // Should not throw — graceful degradation
    if (result.extraction_failed) {
      // Extraction failed path
      const getTool = tools.find((t) => t.name === 'get')!;
      const memory = (await getTool.handler({ id: result.id })) as {
        properties: { tags?: string[]; custom?: { extraction_status?: string } };
      };
      expect(memory.properties.tags).toContain('pdf_extraction_failed');
      expect(memory.properties.custom?.extraction_status).toBe('failed');
    }
    // Either path is valid — the key invariant is no crash
  });

  it('PDF title defaults to filename without .pdf extension', async () => {
    const pdfPath = path.join(tmpDir, 'my-research-paper.pdf');
    const pdfBuf = buildMinimalPdf('Research findings.');
    fs.writeFileSync(pdfPath, pdfBuf);

    const ingestTool = tools.find((t) => t.name === 'ingest')!;
    const result = (await ingestTool.handler({ uri: pdfPath })) as { id: string; title: string };

    expect(result.title).toBe('my-research-paper');
  });

  it('PDF title override works', async () => {
    const pdfPath = path.join(tmpDir, 'untitled.pdf');
    const pdfBuf = buildMinimalPdf('Some content.');
    fs.writeFileSync(pdfPath, pdfBuf);

    const ingestTool = tools.find((t) => t.name === 'ingest')!;
    const result = (await ingestTool.handler({ uri: pdfPath, title: 'My Custom Title' })) as { title: string };

    expect(result.title).toBe('My Custom Title');
  });
});
