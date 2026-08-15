import { describe, expect, it } from 'vitest';
import { TrafficStats } from './traffic-stats';

describe('TrafficStats', () => {
  it('accumulates in and out separately', () => {
    const t = new TrafficStats();
    t.record(10, 'rx');
    t.record(3, 'tx');
    t.record(7, 'rx');
    const s = t.snapshot();
    expect(s.bytesIn).toBe(17);
    expect(s.bytesOut).toBe(3);
  });

  it('computes bytes/sec over a sample window', () => {
    const t = new TrafficStats();
    t.sample(1000);
    t.record(2000, 'rx');
    t.record(500, 'tx');
    const s = t.sample(2000);
    expect(s.rateIn).toBe(2000);
    expect(s.rateOut).toBe(500);
  });
});
