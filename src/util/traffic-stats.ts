/** Cumulative LocalTalk byte counters and a sampled instantaneous rate. */

export interface TrafficSnapshot {
  bytesIn: number;
  bytesOut: number;
  /** Instantaneous inbound rate (bytes/sec), last sample window. */
  rateIn: number;
  /** Instantaneous outbound rate (bytes/sec), last sample window. */
  rateOut: number;
}

export class TrafficStats {
  private bytesIn = 0;
  private bytesOut = 0;
  private windowIn = 0;
  private windowOut = 0;
  private windowStart = 0;
  private rateIn = 0;
  private rateOut = 0;

  record(byteCount: number, direction: 'rx' | 'tx'): void {
    const n = byteCount >>> 0;
    if (direction === 'rx') {
      this.bytesIn += n;
      this.windowIn += n;
    } else {
      this.bytesOut += n;
      this.windowOut += n;
    }
  }

  /** Close the current sample window and update rates. */
  sample(now = performance.now()): TrafficSnapshot {
    if (!this.windowStart) {
      this.windowStart = now;
      return this.snapshot();
    }
    const dt = (now - this.windowStart) / 1000;
    if (dt >= 0.15) {
      this.rateIn = this.windowIn / dt;
      this.rateOut = this.windowOut / dt;
      this.windowIn = 0;
      this.windowOut = 0;
      this.windowStart = now;
    }
    return this.snapshot();
  }

  snapshot(): TrafficSnapshot {
    return {
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      rateIn: this.rateIn,
      rateOut: this.rateOut,
    };
  }

  reset(): void {
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.windowIn = 0;
    this.windowOut = 0;
    this.windowStart = 0;
    this.rateIn = 0;
    this.rateOut = 0;
  }
}
