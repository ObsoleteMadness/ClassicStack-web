import { describe, expect, it } from 'vitest';
import { formatRemainingTime } from './format-bytes';

describe('formatRemainingTime', () => {
  it('uses seconds under a minute', () => {
    expect(formatRemainingTime(1)).toBe('1 second');
    expect(formatRemainingTime(38)).toBe('38 seconds');
  });

  it('combines minutes and seconds', () => {
    expect(formatRemainingTime(60)).toBe('1 minute');
    expect(formatRemainingTime(3 * 60 + 38)).toBe('3 minutes, 38 seconds');
  });

  it('uses hours without leftover seconds', () => {
    expect(formatRemainingTime(3600)).toBe('1 hour');
    expect(formatRemainingTime(2 * 3600 + 5 * 60 + 9)).toBe('2 hours, 5 minutes');
  });
});
