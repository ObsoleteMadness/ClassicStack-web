import { describe, expect, it } from 'vitest';
import { jobRemainingTime, transferListHtml } from './transfer-list';
import { TRANSFER_DETAIL_SEARCHING, type TransferJob } from '../util/transfer-activity';

function job(partial: Partial<TransferJob>): TransferJob {
  return {
    id: 't1',
    name: 'Pack.sit',
    kind: 'file',
    bytesDone: 0,
    bytesTotal: 0,
    itemsDone: 0,
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

describe('searching zip download', () => {
  it('shows Searching with item count and listed size', () => {
    const html = transferListHtml([
      job({
        name: 'Docs',
        kind: 'folder',
        detail: TRANSFER_DETAIL_SEARCHING,
        itemsDone: 12,
        bytesTotal: 500,
      }),
    ]);
    expect(html).toContain('file-transfer--searching');
    expect(html).toContain('Searching');
    expect(html).toContain('12 items');
    expect(html).toContain('500 bytes');
    expect(html).not.toContain('0 bytes of');
  });

  it('shows item count alone before any size is known', () => {
    const html = transferListHtml([
      job({
        name: 'Docs',
        kind: 'folder',
        detail: TRANSFER_DETAIL_SEARCHING,
        itemsDone: 1,
        bytesTotal: 0,
      }),
    ]);
    expect(html).toContain('1 item');
    expect(html).not.toContain('0 bytes');
  });
});
