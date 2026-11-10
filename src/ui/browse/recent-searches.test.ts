import { beforeEach, describe, expect, it } from 'vitest';
import { clearRecentSearches, loadRecentSearches, recordSearch } from './recent-searches';

beforeEach(() => localStorage.clear());

describe('recent searches', () => {
  it('records newest first and dedupes case-insensitively', () => {
    recordSearch('abba');
    recordSearch('Queen');
    expect(recordSearch('  ABBA ')).toEqual(['ABBA', 'Queen']);
    expect(loadRecentSearches()).toEqual(['ABBA', 'Queen']);
  });

  it('caps the list at 8 and ignores blanks', () => {
    for (let i = 0; i < 12; i++) recordSearch(`term ${i}`);
    recordSearch('   ');
    const list = loadRecentSearches();
    expect(list).toHaveLength(8);
    expect(list[0]).toBe('term 11');
  });

  it('clears and survives corrupt storage', () => {
    recordSearch('x');
    clearRecentSearches();
    expect(loadRecentSearches()).toEqual([]);
    localStorage.setItem('rayla.recentSearches', '{bad');
    expect(loadRecentSearches()).toEqual([]);
    localStorage.setItem('rayla.recentSearches', '{"a":1}');
    expect(loadRecentSearches()).toEqual([]);
  });
});
