import { expect, test } from 'vitest';
import { canUseTier } from './types';

test('Go unlocks free-tier models only', () => {
  expect(canUseTier('go', 'free')).toBe(true);
  expect(canUseTier('go', 'plus')).toBe(false);
  expect(canUseTier('go', 'pro')).toBe(false);
});

test('Pro unlocks every model tier', () => {
  expect(canUseTier('pro', 'plus')).toBe(true);
  expect(canUseTier('pro', 'pro')).toBe(true);
  expect(canUseTier('plus', 'pro')).toBe(false);
});
