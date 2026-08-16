import { describe, expect, it } from 'vitest';
import { jobRemainingTime } from './transfer-list';
import type { TransferJob } from '../util/transfer-activity';

function job(partial: Partial<TransferJob>): TransferJob {
  return {
    id: 't1',
    name: 'Pack.sit',
    kind: 'file',
    bytesDone: 0,
    bytesTotal: 0,
    rate: 0,
    status: 'running',
    iconSrc: '/icons/FILE16.png',
    ...partial,
  };
}

describe('jobRemainingTime', () => {
  it('estimates from rate and remaining bytes on a running job', () => {
    expect(
      jobRemainingTime(
        job({ bytesDone: 200, bytesTotal: 1000, rate: 400 }),
      ),
    ).toBe('2 seconds');
  });

  it('omits nested-style jobs that have no rate yet', () => {
    expect(jobRemainingTime(job({ bytesDone: 10, bytesTotal: 100, rate: 0 }))).toBeNull();
    expect(jobRemainingTime(job({ status: 'queued', bytesTotal: 100, rate: 50 }))).toBeNull();
  });
});
