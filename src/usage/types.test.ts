import { expect, test } from 'bun:test';
import { isMaxTeamPlan } from './types';

test('identifies monthly and yearly Max team plans', () => {
  expect(isMaxTeamPlan('max_team_monthly')).toBe(true);
  expect(isMaxTeamPlan('max_team_yearly')).toBe(true);
  expect(isMaxTeamPlan('max_monthly')).toBe(false);
  expect(isMaxTeamPlan(null)).toBe(false);
});
