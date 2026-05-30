// Content preprocessors that run before chunking/embedding.
//
// Background: bge-m3 (and to some extent other multilingual embedders) gets
// distracted by structural Notion markers that don't carry retrieval-
// relevant signal: ▸/▾ toggles, "- [ ]" checkboxes, "> " callouts, "[[Page]]"
// wikilinks, "@mention", and the YAML/properties block at the top of a page.
// Stress test §R15 documented a -13 pts r@1 regression on test_notion_page
// when swapping nomic → bge-m3, while other types improved by +20-30 pts.
//
// Stripping these markers before embedding (but NOT before storage) recovers
// the entity signal: "Sales Q3 plan" stays "Sales Q3 plan" instead of being
// diluted by surrounding structure tokens.

export interface PreprocessorResult {
  /** Text to feed to chunker + embedder. */
  cleaned: string;
  /** Diagnostic — non-empty when something was stripped. */
  appliedSteps: string[];
}

const NOTION_FINGERPRINT = /(?:\n[▸▾]\s)|(?:\n>\s)|(?:\n- \[[ x]\])|(?:\[\[[^\]]+\]\])/;

export function looksLikeNotion(content: string): boolean {
  return NOTION_FINGERPRINT.test(content);
}

/**
 * Strip Notion structural markers while preserving the textual content
 * around them. Idempotent (calling twice yields the same result).
 *
 *  - "▸ Toggle title" → "Toggle title"
 *  - "▾ Open toggle"  → "Open toggle"
 *  - "> Callout text" → "Callout text"
 *  - "- [ ] Todo"     → "Todo"
 *  - "- [x] Done"     → "Done"
 *  - "[[Page name]]"  → "Page name"
 *  - leading YAML properties block (--- ... ---) → removed
 *  - leading "**Properties**" / "**Propriétés**" header block → removed
 */
export function stripNotionMarkdown(content: string): PreprocessorResult {
  const steps: string[] = [];
  let s = content;

  // 1. Leading YAML frontmatter (--- ... ---)
  const fm = /^---\n[\s\S]*?\n---\n+/;
  if (fm.test(s)) {
    s = s.replace(fm, '');
    steps.push('strip-yaml-frontmatter');
  }

  // 2. Leading "**Properties**" / "**Propriétés**" block — everything up to the
  //    first blank line after the marker.
  const propsBlock = /^(?:\*\*Propri[ée]t[ée]s?\*\*|\*\*Properties\*\*)[\s\S]*?\n\n+/;
  if (propsBlock.test(s)) {
    s = s.replace(propsBlock, '');
    steps.push('strip-properties-block');
  }

  // 3. Toggle markers — keep the text after the arrow.
  if (/[▸▾]\s/.test(s)) {
    s = s.replace(/[▸▾]\s+/g, '');
    steps.push('strip-toggle-arrows');
  }

  // 4. Callout marker — keep the text after the ">".
  //    Run line-by-line so we don't eat blockquotes mid-content.
  if (/^>\s/m.test(s)) {
    s = s.replace(/^>\s+/gm, '');
    steps.push('strip-callout-quotes');
  }

  // 5. Checkboxes — keep the text after the bracket.
  if (/^- \[[ xX]\]\s/m.test(s)) {
    s = s.replace(/^- \[[ xX]\]\s+/gm, '');
    steps.push('strip-checkboxes');
  }

  // 6. Wikilinks — extract the page name (text after the pipe, or full
  //    content of [[...]] if no pipe).
  if (/\[\[[^\]]+\]\]/.test(s)) {
    s = s.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1');
    steps.push('extract-wikilink-text');
  }

  // 7. Mentions — keep the display name.
  if (/@\[[^\]]+\]/.test(s)) {
    s = s.replace(/@\[([^\]]+)\]\([^)]+\)/g, '$1');
    s = s.replace(/@\[([^\]]+)\]/g, '$1');
    steps.push('strip-mentions');
  }

  // Collapse runs of blank lines created by the above.
  s = s.replace(/\n{3,}/g, '\n\n').trim();

  return { cleaned: s, appliedSteps: steps };
}

/**
 * Auto-detect + apply known preprocessors. Returns the original content +
 * empty steps array when nothing matches.
 */
export function autoPreprocess(content: string): PreprocessorResult {
  if (looksLikeNotion(content)) {
    return stripNotionMarkdown(content);
  }
  return { cleaned: content, appliedSteps: [] };
}
