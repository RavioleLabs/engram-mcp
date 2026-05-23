export interface ChunkOptions {
  maxChars?: number; // soft maximum per chunk; default 1500
  overlapChars?: number; // overlap between chunks; default 100
}

export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const maxChars = options.maxChars ?? 1500;
  const overlap = Math.min(options.overlapChars ?? 100, Math.max(0, maxChars - 1));

  if (text.length <= maxChars) return [text];

  // Split by paragraph first
  const paragraphs = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    if (current.length + para.length + 2 <= maxChars) {
      current = current ? `${current}\n\n${para}` : para;
      continue;
    }

    if (current) {
      chunks.push(current);
      // Carry overlap from end of previous chunk
      const tail = current.slice(-overlap);
      current = tail + '\n\n' + para;
    } else {
      current = para;
    }

    // If a single paragraph exceeds maxChars, split it by sentence
    while (current.length > maxChars) {
      const sentences = current.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [current];
      let buf = '';
      for (const s of sentences) {
        if (buf.length + s.length > maxChars && buf) {
          chunks.push(buf.trim());
          buf = buf.slice(-overlap) + s;
        } else {
          buf += s;
        }
      }
      current = buf.trim();
      if (current.length <= maxChars) break;
      // If we can't split further, force-cut to avoid infinite loop
      chunks.push(current.slice(0, maxChars));
      current = current.slice(maxChars - overlap);
    }
  }

  if (current) chunks.push(current);
  return chunks.map((c) => c.trim()).filter((c) => c.length > 0);
}
