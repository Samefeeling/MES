import { describe, it, expect } from 'vitest';
import { siblingCssUrl, shouldAutoReload } from '../src/ui/auto-update';

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

describe('shouldAutoReload (once-per-build loop breaker)', () => {
  it('reloads the first time a new build is seen', () => {
    expect(shouldAutoReload('build-B', '')).toBe(true);
  });

  it('does NOT reload again for a build already reloaded toward', () => {
    // Stale SharePoint keeps serving the old bundle: without this guard the
    // page would reload → still old → detect new → reload … forever.
    expect(shouldAutoReload('build-B', 'build-B')).toBe(false);
  });

  it('reloads again once a different, newer build appears', () => {
    expect(shouldAutoReload('build-C', 'build-B')).toBe(true);
  });

  it('never reloads when there is no pending build', () => {
    expect(shouldAutoReload(null, '')).toBe(false);
    expect(shouldAutoReload(null, 'build-B')).toBe(false);
  });
});
