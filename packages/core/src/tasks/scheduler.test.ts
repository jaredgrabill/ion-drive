import { describe, expect, it } from 'vitest';
import { TaskScheduler } from './scheduler.js';

describe('TaskScheduler.validatePattern', () => {
  it('accepts a valid cron expression', () => {
    expect(TaskScheduler.validatePattern('*/5 * * * *')).toBeNull();
    expect(TaskScheduler.validatePattern('0 0 * * *')).toBeNull();
  });

  it('accepts a valid expression with a timezone', () => {
    expect(TaskScheduler.validatePattern('0 9 * * 1', 'America/New_York')).toBeNull();
  });

  it('rejects a malformed cron expression', () => {
    expect(TaskScheduler.validatePattern('not a cron')).not.toBeNull();
  });

  it('rejects an out-of-range field', () => {
    expect(TaskScheduler.validatePattern('99 * * * *')).not.toBeNull();
  });
});
