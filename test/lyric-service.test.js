const assert = require('assert');
const test = require('node:test');

test('parses LRC timestamps, offset, metadata, and repeated timestamps', async () => {
    const { parseLrc, findLineIndex, mergeTranslation } = await import('../src/public/services/lyric-parser.mjs');
    const lines = parseLrc('[ar:歌手]\r\n[offset:-500]\r\n[00:01.20][00:02.000]第一句\n[00:03]第二句');
    assert.deepStrictEqual(lines.map(line => ({ timeMs: line.timeMs, text: line.text })), [
        { timeMs: 700, text: '第一句' },
        { timeMs: 1500, text: '第一句' },
        { timeMs: 2500, text: '第二句' }
    ]);
    assert.strictEqual(findLineIndex(lines, 0), -1);
    assert.strictEqual(findLineIndex(lines, 800), 0);
    assert.strictEqual(findLineIndex(lines, 2600), 2);
    assert.strictEqual(mergeTranslation(lines, '[00:00.70]translation')[0].translation, 'translation');
});

test('keeps translation-only lyrics renderable and removes dead end-time branch', async () => {
    const { normalizeLyrics, findLineIndex } = await import('../src/public/services/lyric-parser.mjs');
    const result = normalizeLyrics('', '[00:01.000]只有译文', { songId: 0 });
    assert.equal(result.noLyrics, false);
    assert.equal(result.lines.length, 1);
    assert.equal(result.lines[0].translation, '只有译文');
    assert.equal(result.songId, '0');
    assert.equal(findLineIndex(result.lines, 1000), 0);
});

test('keeps lyric content as data for safe textContent rendering', async () => {
    const { parseLrc } = await import('../src/public/services/lyric-parser.mjs');
    assert.strictEqual(parseLrc('[00:01.000]<b>safe text</b>')[0].text, '<b>safe text</b>');
});
