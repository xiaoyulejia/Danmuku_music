const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const router = require('../src/routers/bili-router');

async function createServer() {
    const app = express();
    app.use(express.json());
    app.use('/api', router);
    const server = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    return { server, base: `http://127.0.0.1:${server.address().port}/api` };
}

function cleanupRoom(roomId) {
    const cacheDir = path.join(__dirname, '..', 'cache', 'order-sync');
    for (const prefix of ['state', 'commands']) {
        fs.rmSync(path.join(cacheDir, `${prefix}-${roomId}.json${prefix === 'commands' ? 'l' : ''}`), { force: true });
    }
}

test('sync-state normalizes incoming queue and playback data', async () => {
    const roomId = `typecheck-${Date.now()}-state`;
    const { server, base } = await createServer();
    try {
        const response = await fetch(`${base}/live/sync-state`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                room_id: roomId,
                state: {
                    queue: [{ uid: 7, uname: 'tester', song: { sid: 42, name: 'A'.repeat(400), artist: 'B', duration: 'bad' } }, null],
                    playback: { songKey: 'wy:42', positionMs: 5000, durationMs: 1000, paused: false },
                    volume: 150
                }
            })
        });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.code, 0);
        assert.equal(body.data.queue.length, 1);
        assert.equal(body.data.queue[0].song.sname.length, 300);
        assert.equal(body.data.queue[0].song.duration, 0);
        assert.equal(body.data.volume, 100);
        assert.equal(body.data.playback.positionMs, 1000);

        const read = await fetch(`${base}/live/sync-state?roomid=${roomId}`);
        const snapshot = await read.json();
        assert.equal(snapshot.data.stateRevision, body.data.stateRevision);
        assert.equal(snapshot.data.queue.length, 1);
    } finally {
        await new Promise(resolve => server.close(resolve));
        cleanupRoom(roomId);
    }
});

test('sync-command rejects untrusted origins and deduplicates command ids', async () => {
    const roomId = `typecheck-${Date.now()}-command`;
    const { server, base } = await createServer();
    try {
        const payload = { room_id: roomId, command: { id: 'duplicate-id', command: 'volume', value: 25 } };
        const forbidden = await fetch(`${base}/live/sync-command`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
            body: JSON.stringify(payload)
        });
        assert.equal(forbidden.status, 403);

        const first = await fetch(`${base}/live/sync-command`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload)
        });
        assert.equal(first.status, 200);
        const firstBody = await first.json();
        assert.equal(firstBody.data.volume, 25);

        const second = await fetch(`${base}/live/sync-command`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...payload, command: { ...payload.command, value: 80 } })
        });
        assert.equal(second.status, 200);
        const secondBody = await second.json();
        assert.equal(secondBody.result.duplicate, true);
        assert.equal(secondBody.data.volume, 25);

        const commands = await fetch(`${base}/live/sync-commands?room_id=${roomId}&after=0&since=0`);
        const commandBody = await commands.json();
        assert.equal(commandBody.data.length, 1);
    } finally {
        await new Promise(resolve => server.close(resolve));
        cleanupRoom(roomId);
    }
});

test('sync-state cannot overwrite a concurrent danmu addOrder', async () => {
    const roomId = `typecheck-${Date.now()}-danmu-race`;
    const { server, base } = await createServer();
    try {
        const headers = { 'content-type': 'application/json' };
        const addOrder = fetch(`${base}/live/sync-command`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                room_id: roomId,
                command: {
                    id: 'danmu-race-order',
                    command: 'addOrder',
                    value: {
                        uid: 123,
                        uname: '弹幕用户',
                        song: { platform: 'wy', sid: 'danmu-song', sname: '弹幕歌曲', sartist: '歌手', duration: 120 }
                    }
                }
            })
        });
        const publishState = fetch(`${base}/live/sync-state`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                room_id: roomId,
                state: { queue: [], status: '等待点歌', volume: 50, updatedAt: Date.now() }
            })
        });
        const [commandResponse, stateResponse] = await Promise.all([addOrder, publishState]);
        assert.equal(commandResponse.status, 200);
        assert.equal(stateResponse.status, 200);

        const snapshot = await fetch(`${base}/live/sync-state?room_id=${roomId}`).then(response => response.json());
        assert.equal(snapshot.data.queue.length, 1);
        assert.equal(snapshot.data.queue[0].song.sid, 'danmu-song');
    } finally {
        await new Promise(resolve => server.close(resolve));
        cleanupRoom(roomId);
    }
});

test('sync-state normalizes invalid idle indexes and can advance the idle queue', async () => {
    const roomId = `typecheck-${Date.now()}-idle-index`;
    const { server, base } = await createServer();
    try {
        const response = await fetch(`${base}/live/sync-state`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                room_id: roomId,
                state: {
                    queue: [],
                    idleSongList: [{ platform: 'wy', sid: 'idle-1', sname: '空闲歌曲', sartist: '歌手', duration: 120 }],
                    idleIndex: 'not-a-number'
                }
            })
        });
        const body = await response.json();
        assert.equal(response.status, 200);
        assert.equal(body.data.idleIndex, -1);

        const next = await fetch(`${base}/live/sync-command`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                room_id: roomId,
                command: { id: 'idle-next', command: 'next' }
            })
        });
        const nextBody = await next.json();
        assert.equal(next.status, 200);
        assert.equal(nextBody.data.currentSong.sid, 'idle-1');
    } finally {
        await new Promise(resolve => server.close(resolve));
        cleanupRoom(roomId);
    }
});

test('sync-command treats platform as part of the duplicate song key', async () => {
    const roomId = `typecheck-${Date.now()}-platform-duplicate`;
    const { server, base } = await createServer();
    try {
        const add = (id, platform) => fetch(`${base}/live/sync-command`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                room_id: roomId,
                command: {
                    id,
                    command: 'addOrder',
                    value: { uid: 1, uname: 'tester', song: { platform, sid: 'same-id', sname: platform, sartist: '歌手', duration: 120 } }
                }
            })
        });
        const first = await add('wy-order', 'wy');
        const second = await add('qq-order', 'qq');
        assert.equal((await first.json()).result.accepted, true);
        assert.equal((await second.json()).result.accepted, true);
    } finally {
        await new Promise(resolve => server.close(resolve));
        cleanupRoom(roomId);
    }
});

test('sync-credentials CORS preflight allows DELETE', async () => {
    const roomId = `typecheck-${Date.now()}-cors-delete`;
    const { server, base } = await createServer();
    try {
        const response = await fetch(`${base}/live/sync-credentials`, {
            method: 'OPTIONS',
            headers: {
                origin: 'http://127.0.0.1:4173',
                'access-control-request-method': 'DELETE'
            }
        });
        assert.equal(response.status, 204);
        assert.match(response.headers.get('access-control-allow-methods') || '', /DELETE/);
    } finally {
        await new Promise(resolve => server.close(resolve));
        cleanupRoom(roomId);
    }
});

test('queue manager manual orders bypass per-user cap but keep canonical metadata', async () => {
    const roomId = `typecheck-${Date.now()}-manual`;
    const { server, base } = await createServer();
    try {
        const add = async (sid, name) => fetch(`${base}/live/sync-command`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                room_id: roomId,
                command: {
                    id: `manual-${sid}`,
                    command: 'addOrder',
                    value: {
                        uid: -1,
                        uname: '队列管理',
                        source: 'manual',
                        song: { platform: 'wy', sid, sname: name, sartist: '测试歌手', duration: 120 }
                    }
                }
            })
        });
        const first = await add('manual-1', '第一首');
        const second = await add('manual-2', '第二首');
        assert.equal(first.status, 200);
        assert.equal(second.status, 200);
        const firstBody = await first.json();
        const secondBody = await second.json();
        assert.equal(firstBody.result.accepted, true);
        assert.equal(secondBody.result.accepted, true);
        assert.equal(secondBody.data.queue.filter(item => item.source === 'manual').length, 2);
        assert.equal(secondBody.data.queue[1].uname, '队列管理');
    } finally {
        await new Promise(resolve => server.close(resolve));
        cleanupRoom(roomId);
    }
});
