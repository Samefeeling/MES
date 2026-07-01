import { describe, it, expect } from 'vitest';
import { bustedReloadUrl } from '../src/ui/auto-update';

describe('bustedReloadUrl', () => {
  it('adds a _v cache-buster and preserves the hash route', () => {
    expect(
      bustedReloadUrl(
        { pathname: '/sites/x/SiteAssets/pmd/index.html', search: '', hash: '#/trace' },
        'abc123',
      ),
    ).toBe('/sites/x/SiteAssets/pmd/index.html?_v=abc123#/trace');
  });

  it('replaces an existing _v while keeping other query params', () => {
    expect(
      bustedReloadUrl(
        { pathname: '/p/index.html', search: '?_v=old&env=prod', hash: '#/op/550T' },
        'new',
      ),
    ).toBe('/p/index.html?_v=new&env=prod#/op/550T');
  });

  it('works with no hash', () => {
    expect(bustedReloadUrl({ pathname: '/i.html', search: '', hash: '' }, 'z')).toBe(
      '/i.html?_v=z',
    );
  });
});
