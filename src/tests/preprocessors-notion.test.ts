import { describe, it, expect } from 'vitest';
import {
  autoPreprocess,
  looksLikeNotion,
  stripNotionMarkdown,
} from '../memory/core/preprocessors.js';

describe('preprocessors / Notion', () => {
  it('detects toggle markers as Notion', () => {
    expect(looksLikeNotion('Hello\n▸ Toggle title\nMore')).toBe(true);
  });

  it('detects checkboxes as Notion', () => {
    expect(looksLikeNotion('Tasks\n- [ ] Todo one\n- [x] Done')).toBe(true);
  });

  it('detects wikilinks as Notion', () => {
    expect(looksLikeNotion('See [[Sales Q3]]\nfor details')).toBe(true);
  });

  it('does NOT flag plain markdown as Notion', () => {
    expect(looksLikeNotion('# Heading\n\nSome paragraph text.\n\n- bullet\n- bullet')).toBe(false);
  });

  it('strips toggle arrows but keeps text', () => {
    const r = stripNotionMarkdown('Intro\n▸ Sales Q3 plan\nbody\n▾ Engineering\nbody2');
    expect(r.cleaned).toContain('Sales Q3 plan');
    expect(r.cleaned).toContain('Engineering');
    expect(r.cleaned).not.toContain('▸');
    expect(r.cleaned).not.toContain('▾');
    expect(r.appliedSteps).toContain('strip-toggle-arrows');
  });

  it('strips callout "> " quotes line by line', () => {
    const r = stripNotionMarkdown('Title\n\n> Important: ship by Friday\n> Owner: Alice\n\nBody');
    expect(r.cleaned).toContain('Important: ship by Friday');
    expect(r.cleaned).toContain('Owner: Alice');
    expect(r.cleaned).not.toMatch(/^>/m);
    expect(r.appliedSteps).toContain('strip-callout-quotes');
  });

  it('strips checkboxes but keeps task text', () => {
    const r = stripNotionMarkdown('Tasks\n- [ ] Draft proposal\n- [x] Send email');
    expect(r.cleaned).toContain('Draft proposal');
    expect(r.cleaned).toContain('Send email');
    expect(r.cleaned).not.toMatch(/\[[ xX]\]/);
    expect(r.appliedSteps).toContain('strip-checkboxes');
  });

  it('extracts wikilink text', () => {
    const r = stripNotionMarkdown('See [[Sales Q3]]\nand [[Engineering|eng]] team');
    expect(r.cleaned).toContain('Sales Q3');
    expect(r.cleaned).toContain('Engineering');
    expect(r.cleaned).not.toContain('[[');
    expect(r.appliedSteps).toContain('extract-wikilink-text');
  });

  it('strips leading YAML frontmatter', () => {
    const r = stripNotionMarkdown(
      '---\nstatus: draft\nowner: Alice\n---\n\n# Real content\n\nbody',
    );
    expect(r.cleaned).not.toContain('status: draft');
    expect(r.cleaned).toContain('# Real content');
    expect(r.appliedSteps).toContain('strip-yaml-frontmatter');
  });

  it('strips leading Properties block (FR)', () => {
    const r = stripNotionMarkdown(
      '**Propriétés**\nStatut: en cours\nResponsable: Alice\n\n# Réel\n\nbody',
    );
    expect(r.cleaned).not.toContain('Statut: en cours');
    expect(r.cleaned).toContain('# Réel');
    expect(r.appliedSteps).toContain('strip-properties-block');
  });

  it('is idempotent — running twice gives the same result', () => {
    const raw = 'Title\n▸ Toggle\n> Callout\n- [ ] Todo\n[[Wiki]]';
    const once = stripNotionMarkdown(raw).cleaned;
    const twice = stripNotionMarkdown(once).cleaned;
    expect(twice).toBe(once);
  });

  it('collapses runs of blank lines created by stripping', () => {
    const r = stripNotionMarkdown('A\n\n\n\nB');
    expect(r.cleaned).toBe('A\n\nB');
  });

  it('autoPreprocess returns original when no Notion markers', () => {
    const plain = '# Heading\n\nJust some prose with no special markers.';
    const r = autoPreprocess(plain);
    expect(r.cleaned).toBe(plain);
    expect(r.appliedSteps).toEqual([]);
  });

  it('autoPreprocess strips when Notion detected', () => {
    const r = autoPreprocess('# Title\n▸ Toggle text\nbody');
    expect(r.cleaned).not.toContain('▸');
    expect(r.appliedSteps.length).toBeGreaterThan(0);
  });
});
