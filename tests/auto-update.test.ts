import { describe, it, expect } from 'vitest';
import { siblingCssUrl } from '../src/ui/auto-update';

describe('siblingCssUrl', () => {
  it('maps the index.js URL to its index.css sibling', () => {
    expect(siblingCssUrl('https://x/sites/s/SiteAssets/pmd/assets/index.js')).toBe(
      'https://x/sites/s/SiteAssets/pmd/assets/index.css',
    );
  });

  it('preserves a query string (the loader cache key)', () => {
    expect(siblingCssUrl('https://x/assets/index.js?v=abc')).toBe(
      'https://x/assets/index.css?v=abc',
    );
  });

  it('preserves a fragment', () => {
    expect(siblingCssUrl('https://x/assets/index.js#m')).toBe('https://x/assets/index.css#m');
  });
});
