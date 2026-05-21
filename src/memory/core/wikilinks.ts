/**
 * Extract Obsidian-style wikilinks from text.
 *
 * Supports:
 *   [[target]]
 *   [[target|alias]]
 *   [[target#section]]
 *   [[target#section|alias]]
 *
 * Returns target portion (no alias, no section), deduplicated.
 */
export function extractWikilinks(content: string): string[] {
  const matches = content.match(/\[\[([^\]]+)\]\]/g);
  if (!matches) return [];
  const targets = matches.map((m) => {
    const inner = m.slice(2, -2);
    // strip alias after |
    const noAlias = inner.split('|')[0];
    // strip section after #
    return noAlias.split('#')[0].trim();
  });
  return Array.from(new Set(targets)).filter((t) => t.length > 0);
}
