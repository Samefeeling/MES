import { afterEach, describe, expect, it } from 'vitest';
import { _resetIpadDetectionForTests, isIpadDevice } from '../src/core/device';

interface NavStub {
  userAgent?: string;
  maxTouchPoints?: number;
}

function stubNavigator(n: NavStub | undefined): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: n,
    configurable: true,
  });
}

describe('isIpadDevice', () => {
  afterEach(() => {
    _resetIpadDetectionForTests();
    stubNavigator(undefined);
  });

  it('matches a classic iPad UA', () => {
    stubNavigator({
      userAgent:
        'Mozilla/5.0 (iPad; CPU OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
      maxTouchPoints: 5,
    });
    expect(isIpadDevice()).toBe(true);
  });

  it('matches an iPhone UA (rare but valid for the floor app)', () => {
    stubNavigator({
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15',
      maxTouchPoints: 5,
    });
    expect(isIpadDevice()).toBe(true);
  });

  it('detects iPadOS desktop-mode disguise (Macintosh UA + touch points > 1)', () => {
    stubNavigator({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
      maxTouchPoints: 5,
    });
    expect(isIpadDevice()).toBe(true);
  });

  it('rejects a real Mac (Macintosh UA, no touch)', () => {
    stubNavigator({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
      maxTouchPoints: 0,
    });
    expect(isIpadDevice()).toBe(false);
  });

  it('rejects a Windows PC', () => {
    stubNavigator({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      maxTouchPoints: 0,
    });
    expect(isIpadDevice()).toBe(false);
  });

  it('rejects an Android phone (touch, but not iPad)', () => {
    stubNavigator({
      userAgent:
        'Mozilla/5.0 (Linux; Android 13; SM-G998B) AppleWebKit/537.36',
      maxTouchPoints: 5,
    });
    expect(isIpadDevice()).toBe(false);
  });
});
