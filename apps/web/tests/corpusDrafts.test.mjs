import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CorpusDraftManager,
  hasExternalFileConflict,
  mergeItemWithDraft
} from '../src/corpus/draftManager.ts';
import {
  buildWebCorpusRootKey,
  computeCorpusDirFingerprint,
  getRecoveryStorageStats,
  probeRecoveryStorage,
  shouldSkipRecovery
} from '../src/corpus/recoveryStore.ts';
import {
  commitToTimeline,
  createHistoryTimeline,
  isTimelineDirty,
  produceTgMutation,
  setTimelineCursor
} from '../src/store/historyModel.ts';

function makeSampleTg(text = 'a') {
  return {
    name: '001_ba.TextGrid',
    xmin: 0,
    xmax: 1.0,
    tiers: [
      {
        kind: 'intervalTier',
        name: '字词',
        xmin: 0,
        xmax: 1.0,
        intervals: [{ xmin: 0, xmax: 1.0, text }],
        points: []
      }
    ]
  };
}

test('draftManager: multi-item staging, isolation across projects, merge view, and cleanup', () => {
  const manager = new CorpusDraftManager();
  const tgA = makeSampleTg('pa');
  const tgB = makeSampleTg('ta');
  const tgOther = makeSampleTg('ka');

  manager.setDraft('proj_1', {
    itemId: '001_ba',
    tgRelPath: '001_ba.TextGrid',
    tg: tgA,
    format: 'longText',
    baseFingerprint: { size: 120, modifiedMs: 1000 },
    hadDiskTextGrid: true,
    ipaPreview: 'pa',
    statusOverride: 'done',
    noteOverride: '已复核',
    updatedAt: 1001
  });
  manager.setDraft('proj_1', {
    itemId: '002_da',
    tgRelPath: '002_da.TextGrid',
    tg: tgB,
    format: 'shortText',
    baseFingerprint: null,
    hadDiskTextGrid: false,
    ipaPreview: 'ta',
    updatedAt: 1002
  });
  manager.setDraft('proj_2', {
    itemId: '003_ga',
    tgRelPath: '003_ga.TextGrid',
    tg: tgOther,
    format: 'longText',
    baseFingerprint: null,
    hadDiskTextGrid: false,
    ipaPreview: 'ka',
    updatedAt: 1003
  });

  assert.equal(manager.getDirtyCount('proj_1'), 2);
  assert.equal(manager.getDirtyCount('proj_2'), 1);
  assert.deepEqual(manager.getUnsavedItemIds('proj_1'), ['001_ba', '002_da']);
  assert.equal(manager.isProjectDirty('proj_1'), true);
  assert.equal(manager.getDraft('proj_1', '001_ba')?.tg, tgA);

  // Merge view applies draft preview/status/note without mutating base record
  const baseItem = {
    id: '001_ba',
    audioRelPath: '001_ba.wav',
    tgRelPath: '001_ba.TextGrid',
    hasTextGrid: true,
    status: 'todo',
    duration: 1.0,
    label: '001_ba',
    ipaPreview: '',
    note: '',
    updatedAt: 500
  };
  const merged = mergeItemWithDraft(baseItem, manager.getDraft('proj_1', '001_ba'));
  assert.equal(merged.status, 'done');
  assert.equal(merged.ipaPreview, 'pa');
  assert.equal(merged.note, '已复核');
  assert.equal(merged.updatedAt, 1001);
  assert.equal(baseItem.status, 'todo');

  // Race protection: keep newer draft if user edited during async save
  const tgA2 = makeSampleTg('pa2');
  manager.setDraft('proj_1', {
    ...manager.getDraft('proj_1', '001_ba'),
    tg: tgA2,
    updatedAt: 2000
  });
  assert.equal(manager.clearDraftIfUnchanged('proj_1', '001_ba', tgA), false);
  assert.equal(manager.hasDraft('proj_1', '001_ba'), true);
  assert.equal(manager.clearDraftIfUnchanged('proj_1', '001_ba', tgA2, 2000), true);
  assert.equal(manager.hasDraft('proj_1', '001_ba'), false);
  assert.equal(manager.getDirtyCount('proj_1'), 1);

  manager.clearProject('proj_1');
  assert.equal(manager.getDirtyCount('proj_1'), 0);
  assert.equal(manager.isProjectDirty('proj_1'), false);
  assert.equal(manager.getDirtyCount('proj_2'), 1);
});

test('draftManager: undo back to history baseline clears staged draft automatically', () => {
  const manager = new CorpusDraftManager();
  const baseTg = makeSampleTg('原文本');
  let timeline = createHistoryTimeline('open', baseTg.name, {
    tg: baseTg,
    selection: null,
    hiddenTierIndices: [],
    playRange: null
  });
  assert.equal(isTimelineDirty(timeline), false);

  // User edits text -> timeline becomes dirty -> staged in draftManager
  const mutated = produceTgMutation(baseTg, (_draft, ctx) => {
    const tier = ctx.editTier(0);
    tier.intervals[0] = { ...tier.intervals[0], text: '新文本' };
  });
  timeline = commitToTimeline(
    timeline,
    {
      type: 'edit-interval-text',
      title: '编辑区间文本',
      icon: 'text'
    },
    {
      tg: mutated.nextTg,
      selection: null,
      hiddenTierIndices: [],
      playRange: null
    }
  );
  assert.equal(isTimelineDirty(timeline), true);

  const stillDirtyAfterEdit = manager.syncDraftWithDirtyState('proj_undo', '001_ba', {
    isTgDirty: isTimelineDirty(timeline),
    hasMetaOverride: false,
    draft: {
      itemId: '001_ba',
      tgRelPath: '001_ba.TextGrid',
      tg: mutated.nextTg,
      format: 'longText',
      baseFingerprint: { size: 100, modifiedMs: 5000 },
      hadDiskTextGrid: true,
      ipaPreview: '新文本',
      updatedAt: 5010
    }
  });
  assert.equal(stillDirtyAfterEdit, true);
  assert.equal(manager.getDirtyCount('proj_undo'), 1);

  // User presses Ctrl+Z back to baseline -> timeline clean -> draft auto-cleared
  timeline = setTimelineCursor(timeline, -1);
  assert.equal(isTimelineDirty(timeline), false);

  const stillDirtyAfterUndo = manager.syncDraftWithDirtyState('proj_undo', '001_ba', {
    isTgDirty: isTimelineDirty(timeline),
    hasMetaOverride: false
  });
  assert.equal(stillDirtyAfterUndo, false);
  assert.equal(manager.hasDraft('proj_undo', '001_ba'), false);
  assert.equal(manager.getDirtyCount('proj_undo'), 0);

  // If status/note metadata was still overridden despite TextGrid undo, draft remains staged
  manager.setDraft('proj_undo', {
    itemId: '001_ba',
    tgRelPath: '001_ba.TextGrid',
    tg: baseTg,
    format: 'longText',
    baseFingerprint: { size: 100, modifiedMs: 5000 },
    hadDiskTextGrid: true,
    ipaPreview: '原文本',
    statusOverride: 'doubt',
    updatedAt: 5020
  });
  const keptForMeta = manager.syncDraftWithDirtyState('proj_undo', '001_ba', {
    isTgDirty: false,
    hasMetaOverride: true
  });
  assert.equal(keptForMeta, true);
  assert.equal(manager.getDirtyCount('proj_undo'), 1);
});

test('recoveryStore: FNV-1a directory fingerprint prevents same-name folder collisions', () => {
  const hashA = computeCorpusDirFingerprint('词表', ['001_ba.wav', '002_pa.wav', '001_ba.TextGrid']);
  const hashAReordered = computeCorpusDirFingerprint('词表', [
    '001_BA.TEXTGRID',
    '002_pa.WAV',
    '001_ba.wav',
    '001_ba.wav'
  ]);
  const hashB = computeCorpusDirFingerprint('词表', ['101_ma.wav', '102_na.wav']);
  const hashOtherDir = computeCorpusDirFingerprint('词表二', [
    '001_ba.wav',
    '002_pa.wav',
    '001_ba.TextGrid'
  ]);

  assert.match(hashA, /^[0-9a-f]{8}$/);
  assert.equal(hashA, hashAReordered);
  assert.notEqual(hashA, hashB);
  assert.notEqual(hashA, hashOtherDir);

  const fsaKeyA = buildWebCorpusRootKey('web-fsa', '词表', ['001_ba.wav', '002_pa.wav']);
  const fsaKeyB = buildWebCorpusRootKey('web-fsa', '词表', ['101_ma.wav', '102_na.wav']);
  const fallbackKeyA = buildWebCorpusRootKey('web-fallback', '词表', ['001_ba.wav', '002_pa.wav']);

  assert.ok(fsaKeyA.startsWith('web-fsa:词表:'));
  assert.ok(fallbackKeyA.startsWith('web-fallback:词表:'));
  assert.notEqual(fsaKeyA, fsaKeyB);
  assert.notEqual(fsaKeyA, fallbackKeyA);
});

test('hasExternalFileConflict: detects external edits, creation, and deletion accurately', () => {
  const base = { size: 512, modifiedMs: 1700000000000 };

  // Unchanged file
  assert.equal(
    hasExternalFileConflict(base, { exists: true, size: 512, modifiedMs: 1700000000000 }),
    false
  );
  // Size changed externally
  assert.equal(
    hasExternalFileConflict(base, { exists: true, size: 640, modifiedMs: 1700000000000 }),
    true
  );
  // Modified timestamp changed externally
  assert.equal(
    hasExternalFileConflict(base, { exists: true, size: 512, modifiedMs: 1700000005000 }),
    true
  );
  // Existed at load, deleted externally
  assert.equal(
    hasExternalFileConflict(base, { exists: false, size: 0, modifiedMs: 0 }),
    true
  );
  // Did not exist at load, still absent
  assert.equal(
    hasExternalFileConflict(null, { exists: false, size: 0, modifiedMs: 0 }, false),
    false
  );
  // Did not exist at load, externally created by another tool
  assert.equal(
    hasExternalFileConflict(null, { exists: true, size: 256, modifiedMs: 1700000001000 }, false),
    true
  );
  // Null base without explicit flag still flags externally created file
  assert.equal(
    hasExternalFileConflict(null, { exists: true, size: 256, modifiedMs: 1700000001000 }),
    true
  );
  // Stat unavailable
  assert.equal(hasExternalFileConflict(base, null), false);
});

test('recoveryStore: degrades silently when IndexedDB is unavailable and skips sample projects', async () => {
  assert.equal(shouldSkipRecovery('sample:dialect-demo'), true);
  assert.equal(shouldSkipRecovery('tauri:c:/corpus/demo'), false);

  const probe = await probeRecoveryStorage(true);
  assert.equal(probe.available, false);
  assert.equal(probe.degraded, true);

  const stats = await getRecoveryStorageStats();
  assert.equal(stats.degraded, true);
  assert.equal(stats.totalBytes, 0);
  assert.equal(stats.draftCount, 0);
  assert.equal(stats.snapshotCount, 0);
});
