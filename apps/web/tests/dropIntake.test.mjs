import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BULK_DROP_MAX_INDIVIDUAL_TABS,
  analyzeDropIntake,
  classifyExtension,
  entriesFromDroppedPaths,
  formatFileSizeShort
} from '../src/utils/dropIntake.ts';

function makeFileEntry(name, opts = {}) {
  const dir = opts.parentDir ?? 'C:\\Corpus\\Session1';
  const path = opts.path === undefined ? `${dir}\\${name}` : opts.path;
  return {
    id: opts.id ?? `entry_${name}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    isDir: false,
    size: opts.size ?? 1024,
    path,
    parentDir: path ? dir : null,
    file: opts.file ?? null
  };
}

function makeDirEntry(name, path = `C:\\Corpus\\${name}`) {
  return {
    id: `dir_${name}`,
    name,
    isDir: true,
    size: 0,
    path,
    parentDir: 'C:\\Corpus'
  };
}

test('dropIntake: extension classification ignores dotfiles and unsupported extensions', () => {
  assert.equal(classifyExtension('001.TextGrid'), 'doc');
  assert.equal(classifyExtension('demo.Collection'), 'doc');
  assert.equal(classifyExtension('sample.WAV'), 'audio');
  assert.equal(classifyExtension('clip.m4a'), 'audio');
  assert.equal(classifyExtension('report.pdf'), 'unsupported');
  assert.equal(classifyExtension('script.praat'), 'unsupported');
  assert.equal(classifyExtension('.DS_Store'), 'unsupported');
  assert.equal(classifyExtension('Thumbs.db'), 'unsupported');
});

test('dropIntake: single folder, single audio, and single paired TextGrid+wav pass directly', () => {
  // 1. 单个文件夹直通
  const singleDir = analyzeDropIntake([makeDirEntry('WordListA')]);
  assert.equal(singleDir.decision, 'direct');
  assert.equal(singleDir.directories.length, 1);
  assert.equal(singleDir.estimatedNewTabs, 1);

  // 2. 单个音频直通（挂载当前页，不新增标签）
  const singleAudio = analyzeDropIntake([makeFileEntry('001.wav', { size: 48000 })]);
  assert.equal(singleAudio.decision, 'direct');
  assert.equal(singleAudio.standaloneAudioCount, 1);
  assert.equal(singleAudio.estimatedNewTabs, 0);

  // 3. 1 对同名 TextGrid + wav 自动配对合入 1 个标签页直通
  const singlePair = analyzeDropIntake([
    makeFileEntry('001_ba.TextGrid'),
    makeFileEntry('001_ba.WAV', { size: 64000 })
  ]);
  assert.equal(singlePair.decision, 'direct');
  assert.equal(singlePair.pairedCount, 1);
  assert.equal(singlePair.standaloneDocCount, 0);
  assert.equal(singlePair.standaloneAudioCount, 0);
  assert.equal(singlePair.estimatedNewTabs, 1);
  assert.equal(singlePair.openUnits[0].kind, 'paired');
});

test('dropIntake: 4 new docs pass directly, 5 new docs trigger confirmation', () => {
  const fourDocs = analyzeDropIntake([
    makeFileEntry('a.TextGrid'),
    makeFileEntry('b.TextGrid'),
    makeFileEntry('c.TextGrid'),
    makeFileEntry('d.TextGrid')
  ]);
  assert.equal(fourDocs.decision, 'direct');
  assert.equal(fourDocs.estimatedNewTabs, 4);

  const fiveDocs = analyzeDropIntake([
    makeFileEntry('a.TextGrid'),
    makeFileEntry('b.TextGrid'),
    makeFileEntry('c.TextGrid'),
    makeFileEntry('d.TextGrid'),
    makeFileEntry('e.TextGrid')
  ]);
  assert.equal(fiveDocs.decision, 'confirm');
  assert.equal(fiveDocs.estimatedNewTabs, 5);
  assert.ok(fiveDocs.corpusRecommendation);
  assert.equal(fiveDocs.corpusRecommendation.mode, 'tauri-dir');
  assert.equal(fiveDocs.corpusRecommendation.folderName, 'Session1');
});

test('dropIntake: multiple standalone audios trigger confirmation and recommend corpus mode', () => {
  const multiAudio = analyzeDropIntake([
    makeFileEntry('001.wav'),
    makeFileEntry('002.wav'),
    makeFileEntry('003.wav')
  ]);
  assert.equal(multiAudio.decision, 'confirm');
  assert.equal(multiAudio.standaloneAudioCount, 3);
  assert.equal(multiAudio.estimatedNewTabs, 3);
  assert.ok(multiAudio.corpusRecommendation);
  assert.equal(multiAudio.corpusRecommendation.mode, 'tauri-dir');
  assert.equal(multiAudio.corpusRecommendation.itemCount, 3);
});

test('dropIntake: web paired batch recommends web-files corpus mode', () => {
  const fakeFile = (name) => ({ name, size: 1200, lastModified: 1000 });
  const entries = [];
  for (let i = 1; i <= 6; i++) {
    const tg = fakeFile(`00${i}.TextGrid`);
    const wav = fakeFile(`00${i}.wav`);
    entries.push(makeFileEntry(tg.name, { path: null, file: tg }));
    entries.push(makeFileEntry(wav.name, { path: null, file: wav }));
  }
  const plan = analyzeDropIntake(entries);
  assert.equal(plan.decision, 'confirm');
  assert.equal(plan.pairedCount, 6);
  assert.equal(plan.estimatedNewTabs, 6);
  assert.ok(plan.corpusRecommendation);
  assert.equal(plan.corpusRecommendation.mode, 'web-files');
  assert.equal(plan.corpusRecommendation.files.length, 12);
  assert.equal(plan.corpusRecommendation.itemCount, 6);
});

test('dropIntake: deduplicates already-open files and switches directly when all are open', () => {
  const openMap = new Map([
    ['c:/corpus/session1/001.textgrid', 'tab_1'],
    ['c:/corpus/session1/002.textgrid', 'tab_2']
  ]);
  const matcher = {
    findOpenFileTabId: (p) => openMap.get(p.replace(/\\/g, '/').toLowerCase()) ?? null
  };

  const allOpen = analyzeDropIntake(
    [makeFileEntry('001.TextGrid'), makeFileEntry('002.TextGrid')],
    matcher
  );
  assert.equal(allOpen.decision, 'switch-existing');
  assert.equal(allOpen.alreadyOpen.length, 2);
  assert.equal(allOpen.estimatedNewTabs, 0);

  // 混入 2 个已打开 + 3 个新文件 => 预计新增 3 个标签页，直接放行
  const mixed = analyzeDropIntake(
    [
      makeFileEntry('001.TextGrid'),
      makeFileEntry('002.TextGrid'),
      makeFileEntry('003.TextGrid'),
      makeFileEntry('004.TextGrid'),
      makeFileEntry('005.TextGrid')
    ],
    matcher
  );
  assert.equal(mixed.decision, 'direct');
  assert.equal(mixed.alreadyOpen.length, 2);
  assert.equal(mixed.estimatedNewTabs, 3);
});

test('dropIntake: unsupported files only return empty; total raw > 8 with valid triggers confirm', () => {
  const onlyJunk = analyzeDropIntake([
    makeFileEntry('a.pdf'),
    makeFileEntry('b.jpg'),
    makeFileEntry('c.docx')
  ]);
  assert.equal(onlyJunk.decision, 'empty');
  assert.equal(onlyJunk.unsupported.length, 3);

  const manyMixed = analyzeDropIntake([
    makeFileEntry('valid.TextGrid'),
    ...Array.from({ length: 8 }, (_, idx) => makeFileEntry(`photo_${idx}.jpg`))
  ]);
  assert.equal(manyMixed.totalRawCount, 9);
  assert.equal(manyMixed.unsupported.length, 8);
  assert.equal(manyMixed.decision, 'confirm');
});

test('dropIntake: multiple directories trigger confirmation and 20-tab hard cap is flagged', () => {
  const twoDirs = analyzeDropIntake([makeDirEntry('DirA'), makeDirEntry('DirB')]);
  assert.equal(twoDirs.decision, 'confirm');
  assert.equal(twoDirs.directories.length, 2);
  assert.equal(twoDirs.corpusRecommendation, null);

  const manyFiles = analyzeDropIntake(
    Array.from({ length: 26 }, (_, i) => makeFileEntry(`item_${String(i + 1).padStart(2, '0')}.TextGrid`))
  );
  assert.equal(manyFiles.decision, 'confirm');
  assert.equal(manyFiles.selectableNewCount, 26);
  assert.equal(manyFiles.exceedsIndividualCap, true);
  assert.equal(BULK_DROP_MAX_INDIVIDUAL_TABS, 20);
});

test('dropIntake: entriesFromDroppedPaths filters missing paths and deduplicates case-insensitively', () => {
  const entries = entriesFromDroppedPaths([
    {
      path: 'C:\\Data\\001.TextGrid',
      name: '001.TextGrid',
      parentDir: 'C:\\Data',
      isDir: false,
      size: 512,
      exists: true
    },
    {
      path: 'c:/data/001.textgrid',
      name: '001.textgrid',
      parentDir: 'c:/data',
      isDir: false,
      size: 512,
      exists: true
    },
    {
      path: 'C:\\Data\\missing.TextGrid',
      name: 'missing.TextGrid',
      parentDir: 'C:\\Data',
      isDir: false,
      size: 0,
      exists: false
    }
  ]);
  assert.equal(entries.length, 1);
  assert.equal(formatFileSizeShort(512), '512 B');
  assert.equal(formatFileSizeShort(1536), '1.5 KB');
});
