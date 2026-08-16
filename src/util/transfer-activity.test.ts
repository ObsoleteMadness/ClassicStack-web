import { describe, it, expect } from 'vitest';
import { transferActivity } from './transfer-activity';

describe('transferActivity', () => {
  it('tracks bytes, rate, and finish for a file job', () => {
    transferActivity.clearFinished();
    const id = transferActivity.start({ name: 'ReadMe', kind: 'file', bytesTotal: 1000 });
    transferActivity.addBytes(id, 400);
    const job = transferActivity.list().find((j) => j.id === id)!;
    expect(job.bytesDone).toBe(400);
    expect(job.status).toBe('running');
    transferActivity.finish(id);
    const finished = transferActivity.list().find((j) => j.id === id)!;
    expect(finished.status).toBe('done');
    expect(finished.bytesDone).toBe(400);
    transferActivity.clearFinished();
    expect(transferActivity.list().some((j) => j.id === id)).toBe(false);
  });

  it('keeps a folder job on the folder icon even if setIcon is called', () => {
    const id = transferActivity.start({
      name: 'Docs',
      kind: 'folder',
      bytesTotal: 10,
    });
    transferActivity.setIcon(id, '/icons/TEXT16.png');
    expect(transferActivity.list().find((j) => j.id === id)?.iconSrc).toBe('');
    transferActivity.finish(id);
    transferActivity.clearFinished();
  });

  it('nests an expand subtask under its parent job', () => {
    const parent = transferActivity.start({ name: 'Read Me.bin.hqx', kind: 'file', bytesTotal: 80 });
    const child = transferActivity.start({
      name: 'Read Me',
      kind: 'file',
      bytesTotal: 18,
      parentId: parent,
      detail: 'Expanding',
    });
    const jobs = transferActivity.list();
    expect(jobs.find((j) => j.id === child)?.parentId).toBe(parent);
    expect(jobs.find((j) => j.id === child)?.detail).toBe('Expanding');
    transferActivity.finish(child);
    transferActivity.finish(parent);
    transferActivity.clearFinished();
  });

  it('aggregates running root jobs and ignores nested expand tasks', () => {
    const parent = transferActivity.start({ name: 'Pack', kind: 'folder', bytesTotal: 100 });
    transferActivity.addBytes(parent, 40);
    const child = transferActivity.start({
      name: 'inner',
      kind: 'file',
      bytesTotal: 50,
      parentId: parent,
    });
    transferActivity.addBytes(child, 50);
    const agg = transferActivity.aggregateProgress();
    expect(agg.running).toBe(true);
    expect(agg.indeterminate).toBe(false);
    expect(agg.pct).toBe(40);
    transferActivity.finish(child);
    transferActivity.finish(parent);
    expect(transferActivity.aggregateProgress().running).toBe(false);
    transferActivity.clearFinished();
  });

  it('resets a parent job so extraction progress replaces archive-read bytes', () => {
    const parent = transferActivity.start({ name: 'Pack.sit', kind: 'file', bytesTotal: 80 });
    transferActivity.addBytes(parent, 80);
    transferActivity.setBytes(parent, 0, 200, 'Expanding');
    const job = transferActivity.list().find((j) => j.id === parent)!;
    expect(job.bytesDone).toBe(0);
    expect(job.bytesTotal).toBe(200);
    expect(job.detail).toBe('Expanding');
    expect(job.rate).toBe(0);
    transferActivity.addBytes(parent, 50);
    expect(transferActivity.aggregateProgress().pct).toBe(25);
    transferActivity.finish(parent);
    transferActivity.clearFinished();
  });

  it('queues nested extract jobs and begins them later', () => {
    const parent = transferActivity.start({ name: 'Pack.sit', kind: 'file', bytesTotal: 80 });
    const [a, b] = transferActivity.startMany([
      { name: 'A', kind: 'file', bytesTotal: 4, parentId: parent, queued: true },
      { name: 'Folder/B', kind: 'file', bytesTotal: 5, parentId: parent, queued: true },
    ]);
    const jobs = transferActivity.list();
    expect(jobs.filter((j) => j.parentId === parent).map((j) => j.status)).toEqual(['queued', 'queued']);
    expect(jobs.find((j) => j.id === a)?.detail).toBe('Queued');
    expect(transferActivity.hasRunning()).toBe(true);
    transferActivity.begin(a!, 'Expanding');
    expect(transferActivity.list().find((j) => j.id === a)?.status).toBe('running');
    expect(transferActivity.list().find((j) => j.id === b)?.status).toBe('queued');
    transferActivity.fail(parent, 'stopped');
    transferActivity.failQueued(parent, 'stopped');
    expect(transferActivity.list().find((j) => j.id === b)?.status).toBe('error');
    transferActivity.finish(a!);
    transferActivity.clearFinished();
    expect(transferActivity.list().some((j) => j.id === parent)).toBe(false);
  });
});
