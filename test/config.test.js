const assert = require('assert');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolvePort, loadRuntimeConfig } = require('../src/config');
const { LocalStore, mergeSettings } = require('../src/services/local-store');

test('uses default port when values are missing', () => {
    assert.strictEqual(resolvePort(undefined), 8000);
});

test('accepts a YAML-configured port', () => {
    assert.strictEqual(resolvePort('9123'), 9123);
});

test('runtime config gives DAMUKU_PORT precedence over YAML', () => {
    const previous = process.env.DAMUKU_PORT;
    process.env.DAMUKU_PORT = '19001';
    try {
        assert.strictEqual(loadRuntimeConfig(process.cwd()).port, 19001);
    } finally {
        if (previous === undefined) delete process.env.DAMUKU_PORT;
        else process.env.DAMUKU_PORT = previous;
    }
});

test('loads product and build versions from the shared version config', () => {
    const configured = require('../config/version');
    const runtime = loadRuntimeConfig(process.cwd());
    assert.strictEqual(runtime.productVersion, configured.productVersion);
    assert.strictEqual(runtime.buildId, configured.buildId);
});

test('rejects invalid ports before listen()', () => {
    for (const value of [0, 65536, 'abc', 1.5]) {
        assert.throws(() => resolvePort(value), /1-65535/);
    }
});

test('local store keeps validated settings and credentials separate', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'damuku-store-'));
    try {
        const store = new LocalStore(tempRoot);
        const saved = store.updateSettings('room-1', {
            order: { globalMaxOrder: 2, overLimitSkip: 30 },
            login: { platform: 'wy', songListId: 'list-1' }
        });
        assert.strictEqual(saved.ok, true);
        assert.strictEqual(store.getSettings('room-1').order.globalMaxOrder, 2);
        assert.strictEqual(store.getSettings('room-1').login.songListId, 'list-1');
        assert.strictEqual(store.saveNeteaseCookie('MUSIC_U=secret'), true);
        assert.strictEqual(store.hasNeteaseCookie(), true);
        assert.strictEqual(fs.existsSync(store.credentialPath()), true);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('multi-scene auto settings default safely and clamp the heartbeat threshold', () => {
    const defaults = mergeSettings().display;
    assert.strictEqual(defaults.multiSceneHandoffEnabled, false);
    assert.strictEqual(defaults.multiSceneAutoSwitchEnabled, false);
    assert.strictEqual(defaults.multiSceneHeartbeatThresholdMs, 5000);
    const clamped = mergeSettings({ display: {
        multiSceneHandoffEnabled: true,
        multiSceneAutoSwitchEnabled: true,
        multiSceneHeartbeatThresholdMs: 99999
    } }).display;
    assert.strictEqual(clamped.multiSceneAutoSwitchEnabled, true);
    assert.strictEqual(clamped.multiSceneHeartbeatThresholdMs, 8000);
    const disabled = mergeSettings({ display: {
        multiSceneHandoffEnabled: false,
        multiSceneAutoSwitchEnabled: true
    } }).display;
    assert.strictEqual(disabled.multiSceneAutoSwitchEnabled, false);
});

test('display appearance settings are validated and clamped', () => {
    const display = mergeSettings({ display: {
        overlayBackgroundColor: '#123456',
        playerTitleColor: 'invalid',
        playerTitleSize: 999,
        playerArtistSize: 1,
        queueTextSize: 24,
        queueHeaderSize: 100
    } }).display;
    assert.strictEqual(display.overlayBackgroundColor, '#123456');
    assert.strictEqual(display.playerTitleColor, '#ffffff');
    assert.strictEqual(display.playerTitleSize, 48);
    assert.strictEqual(display.playerArtistSize, 10);
    assert.strictEqual(display.queueTextSize, 24);
    assert.strictEqual(display.queueHeaderSize, 24);
});

test('queue compact mode defaults off and persists as a boolean', () => {
    assert.strictEqual(mergeSettings().display.queueCompactMode, false);
    assert.strictEqual(mergeSettings({ display: { queueCompactMode: 1 } }).display.queueCompactMode, true);
    assert.strictEqual(mergeSettings({ display: { queueCompactMode: 0 } }).display.queueCompactMode, false);
});

test('lyrics font family accepts system names and rejects unsafe values', () => {
    const defaults = mergeSettings().display;
    assert.strictEqual(defaults.lyricsFontFamily, 'Inter');
    assert.strictEqual(defaults.lyricsFontFamilyLatin, 'Inter');
    assert.strictEqual(defaults.lyricsFontFamilyCjk, 'Microsoft YaHei');
    assert.strictEqual(mergeSettings({ display: { lyricsFontFamily: 'Microsoft YaHei' } }).display.lyricsFontFamily, 'Microsoft YaHei');
    assert.strictEqual(mergeSettings({ display: { lyricsFontFamily: 'Arial; color:red' } }).display.lyricsFontFamily, 'Inter');
    assert.strictEqual(mergeSettings({ display: { lyricsFontFamilyLatin: 'Arial' } }).display.lyricsFontFamilyLatin, 'Arial');
    assert.strictEqual(mergeSettings({ display: { lyricsFontFamilyCjk: 'SimHei' } }).display.lyricsFontFamilyCjk, 'SimHei');
    assert.strictEqual(mergeSettings({ display: { lyricsFontFamilyCjk: 'SimHei; color:red' } }).display.lyricsFontFamilyCjk, 'Microsoft YaHei');
});
