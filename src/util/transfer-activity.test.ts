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

  it('updates a running job caption without resetting bytes', () => {
    const id = transferActivity.start({ name: 'Pack.sit', kind: 'file', bytesTotal: 80 });
    transferActivity.addBytes(id, 20);
    transferActivity.setDetail(id, 'Reading archive');
    const job = transferActivity.list().find((j) => j.id === id)!;
    expect(job.detail).toBe('Reading archive');
    expect(job.bytesDone).toBe(20);
    transferActivity.finish(id);
    transferActivity.clearFinished();
  });

  it('tracks searching item counts without filling the progress bar', () => {
    const id = transferActivity.start({ name: 'Docs', kind: 'folder', bytesTotal: 0 });
    transferActivity.setFound(id, 3, 1500);
    const job = transferActivity.list().find((j) => j.id === id)!;
    expect(job.detail).toBe('Searching');
    expect(job.itemsDone).toBe(3);
    expect(job.bytesTotal).toBe(1500);
    expect(job.bytesDone).toBe(0);
    expect(transferActivity.aggregateProgress()).toEqual({
      pct: 0,
      running: true,
      indeterminate: true,
    });
    transferActivity.setBytes(id, 0, 1500, '');
    transferActivity.addBytes(id, 500);
    const downloading = transferActivity.aggregateProgress();
    expect(downloading.indeterminate).toBe(false);
    expect(downloading.pct).toBe(33);
    transferActivity.finish(id);
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

  it('cancels a queued job without starting it', () => {
    const id = transferActivity.start({ name: 'Later', kind: 'file', bytesTotal: 8, queued: true });
    transferActivity.cancel(id);
    const job = transferActivity.list().find((j) => j.id === id)!;
    expect(job.status).toBe('cancelled');
    expect(transferActivity.begin(id)).toBe(false);
    expect(transferActivity.hasRunning()).toBe(false);
    transferActivity.finish(id);
    expect(job.status).toBe('cancelled');
    transferActivity.clearFinished();
  });

  it('cancels a running parent and its queued children', () => {
    const parent = transferActivity.start({ name: 'Pack.sit', kind: 'file', bytesTotal: 80 });
    const [a, b] = transferActivity.startMany([
      { name: 'A', kind: 'file', bytesTotal: 4, parentId: parent, queued: true },
      { name: 'B', kind: 'file', bytesTotal: 5, parentId: parent, queued: true },
    ]);
    transferActivity.begin(a!, 'Expanding');
    transferActivity.cancel(parent);
    expect(transferActivity.list().find((j) => j.id === parent)?.status).toBe('cancelled');
    expect(transferActivity.list().find((j) => j.id === a)?.status).toBe('cancelled');
    expect(transferActivity.list().find((j) => j.id === b)?.status).toBe('cancelled');
    expect(transferActivity.signal(a!)?.aborted).toBe(true);
    transferActivity.clearFinished();
  });

  it('deletes a watched dest file when a cancelled write settles', async () => {
    const removed: number[] = [];
    const dest = {
      async lookup() {
        return { id: 42, isDir: false };
      },
      async remove(id: number) {
        removed.push(id);
      },
    };
    const id = transferActivity.start({ name: 'ReadMe', kind: 'file', bytesTotal: 100 });
    transferActivity.watchPartial(id, dest, 2, 'ReadMe');
    transferActivity.cancel(id);
    await transferActivity.settle(id, transferActivity.signal(id)!.reason ?? new DOMException('Aborted', 'AbortError'));
    expect(removed).toEqual([42]);
    expect(transferActivity.list().find((j) => j.id === id)?.status).toBe('cancelled');
    transferActivity.clearFinished();
  });

  it('lists dest names being written into a folder for Finder overlay', () => {
    const dest = {
      async lookup() {
        return undefined;
      },
      async remove() {},
    };
    const other = {
      async lookup() {
        return undefined;
      },
      async remove() {},
    };
    const file = transferActivity.start({ name: 'ReadMe', kind: 'file', bytesTotal: 100 });
    transferActivity.setDest(file, dest, 2, 'ReadMe copy');
    transferActivity.addBytes(file, 40);
    const folder = transferActivity.start({ name: 'Docs', kind: 'folder', bytesTotal: 200 });
    transferActivity.setDest(folder, dest, 2, 'Docs');
    transferActivity.watchPartial(folder, dest, 9, 'inner');
    expect(transferActivity.writesIn(dest, 2)).toEqual([
      { jobId: file, name: 'ReadMe copy', kind: 'file', pct: 40, indeterminate: false },
      { jobId: folder, name: 'Docs', kind: 'folder', pct: 0, indeterminate: false },
    ]);
    expect(transferActivity.writesIn(dest, 9)).toEqual([
      { jobId: folder, name: 'inner', kind: 'file', pct: 0, indeterminate: false },
    ]);
    expect(transferActivity.writesIn(other, 2)).toEqual([]);
    transferActivity.finish(file);
    transferActivity.finish(folder);
    expect(transferActivity.writesIn(dest, 2)).toEqual([]);
    transferActivity.clearFinished();
  });

  it('overlays several extracted dest names from one expand job', () => {
    const dest = {
      async lookup() {
        return undefined;
      },
      async remove() {},
    };
    const id = transferActivity.start({ name: 'Pack.sit', kind: 'file', bytesTotal: 200 });
    transferActivity.setDest(id, dest, 2, 'Pack.sit');
    transferActivity.clearDest(id);
    transferActivity.addDest(id, dest, 2, 'Utilities', 'folder');
    transferActivity.addBytes(id, 50);
    const child = transferActivity.start({
      name: 'ReadMe',
      kind: 'file',
      bytesTotal: 40,
      queued: true,
    });
    transferActivity.setDest(child, dest, 2, 'ReadMe', 'file');
    expect(transferActivity.writesIn(dest, 2)).toEqual([
      { jobId: id, name: 'Utilities', kind: 'folder', pct: 25, indeterminate: false },
      { jobId: child, name: 'ReadMe', kind: 'file', pct: 0, indeterminate: false },
    ]);
    transferActivity.finish(child);
    transferActivity.finish(id);
    transferActivity.clearFinished();
  });

  it('drops Finder dest overlays when queued extract children fail', () => {
    const dest = {
      async lookup() {
        return undefined;
      },
      async remove() {},
    };
    const parent = transferActivity.start({ name: 'Pack.sit', kind: 'file', bytesTotal: 80 });
    const child = transferActivity.start({
      name: 'ReadMe',
      kind: 'file',
      bytesTotal: 40,
      parentId: parent,
      queued: true,
    });
    transferActivity.setDest(child, dest, 2, 'ReadMe', 'file');
    expect(transferActivity.writesIn(dest, 2).map((w) => w.name)).toEqual(['ReadMe']);
    transferActivity.fail(parent, 'stopped');
    transferActivity.failQueued(parent, 'stopped');
    expect(transferActivity.writesIn(dest, 2)).toEqual([]);
    transferActivity.clearFinished();
  });

  it('runs queued copy jobs one at a time and begins them in order', async () => {
    const dest = {
      async lookup() {
        return undefined;
      },
      async remove() {},
    };
    const first = transferActivity.start({ name: 'A', kind: 'file', bytesTotal: 10 });
    transferActivity.setDest(first, dest, 2, 'A');
    const second = transferActivity.start({ name: 'B', kind: 'file', bytesTotal: 10, queued: true });
    transferActivity.setDest(second, dest, 2, 'B');
    expect(transferActivity.busyOn(dest)).toBe(true);
    expect(transferActivity.list().find((j) => j.id === second)?.status).toBe('queued');
    const order: string[] = [];
    let releaseFirst!: () => void;
    const a = transferActivity.withCopySlot(first, () =>
      new Promise<void>((resolve) => {
        order.push('A');
        releaseFirst = resolve;
      }),
    );
    const b = transferActivity.withCopySlot(second, async () => {
      order.push('B');
    });
    await Promise.resolve();
    expect(order).toEqual(['A']);
    expect(transferActivity.list().find((j) => j.id === second)?.status).toBe('queued');
    releaseFirst();
    await Promise.all([a, b]);
    expect(order).toEqual(['A', 'B']);
    expect(transferActivity.list().find((j) => j.id === second)?.status).toBe('running');
    transferActivity.finish(first);
    transferActivity.finish(second);
    transferActivity.clearFinished();
  });

  it('reenters withCopySlot for the same job', async () => {
    const id = transferActivity.start({ name: 'Pack', kind: 'file', bytesTotal: 8 });
    await transferActivity.withCopySlot(id, async () => {
      await transferActivity.withCopySlot(id, async () => {
        transferActivity.addBytes(id, 1);
      });
    });
    expect(transferActivity.list().find((j) => j.id === id)?.bytesDone).toBe(1);
    transferActivity.finish(id);
    transferActivity.clearFinished();
  });

  it('does not delete a dest folder registered as the partial', async () => {
    const removed: number[] = [];
    const dest = {
      async lookup() {
        return { id: 7, isDir: true };
      },
      async remove(id: number) {
        removed.push(id);
      },
    };
    const id = transferActivity.start({ name: 'Docs', kind: 'folder', bytesTotal: 10 });
    transferActivity.watchPartial(id, dest, 2, 'Docs');
    transferActivity.cancel(id);
    await transferActivity.discardPartial(id);
    expect(removed).toEqual([]);
    transferActivity.clearFinished();
  });

  it('keeps a folder dest overlay when the in-flight file moves into a nested folder', () => {
    const dest = {
      async lookup() {
        return undefined;
      },
      async remove() {},
    };
    const id = transferActivity.start({ name: 'Docs', kind: 'folder', bytesTotal: 200 });
    transferActivity.setDest(id, dest, 2, 'Docs', 'folder');
    transferActivity.setWriteFile(id, dest, 9, 'inner');
    expect(transferActivity.writesIn(dest, 2)).toEqual([
      { jobId: id, name: 'Docs', kind: 'folder', pct: 0, indeterminate: false },
    ]);
    expect(transferActivity.writesIn(dest, 9)).toEqual([
      { jobId: id, name: 'inner', kind: 'file', pct: 0, indeterminate: false },
    ]);
    transferActivity.setWriteFile(id, dest, 9, 'other');
    expect(transferActivity.writesIn(dest, 9).map((w) => w.name)).toEqual(['other']);
    transferActivity.finish(id);
    transferActivity.clearFinished();
  });
});
