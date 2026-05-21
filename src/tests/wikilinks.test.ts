import { describe, it, expect } from 'vitest';
import { extractWikilinks } from '../memory/core/wikilinks.js';

describe('extractWikilinks', () => {
  it('extracts plain links', () => {
    expect(extractWikilinks('See [[ProjectX]] and [[Notes]].')).toEqual(['ProjectX', 'Notes']);
  });

  it('strips alias and section', () => {
    expect(extractWikilinks('See [[Target|alias]] and [[Other#section|alias2]]')).toEqual([
      'Target',
      'Other',
    ]);
  });

  it('dedups', () => {
    expect(extractWikilinks('[[A]] [[A]] [[B]]')).toEqual(['A', 'B']);
  });

  it('returns [] when no links', () => {
    expect(extractWikilinks('plain text')).toEqual([]);
  });
});
