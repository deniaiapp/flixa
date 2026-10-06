import { expect, test } from 'bun:test';
import {
  getAvailableReasoningEfforts,
  normalizeReasoningEfforts,
} from './reasoning.js';

test('uses the efforts provided by the backend', () => {
  expect(
    getAvailableReasoningEfforts('openai/gpt-6-luna', ['low', 'medium', 'high', 'xhigh', 'max']),
  ).toEqual([
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
});

test('normalizes provider efforts and hides none and minimal', () => {
  expect(normalizeReasoningEfforts(['none', 'minimal', 'low', 'max'])).toEqual([
    'low',
    'max',
  ]);
});

test('does not expose reasoning options when the provider disables them', () => {
  expect(getAvailableReasoningEfforts('openai/gpt-4.1', false)).toEqual([]);
});
