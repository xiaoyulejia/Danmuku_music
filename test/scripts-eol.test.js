const assert = require('assert');
const test = require('node:test');
const fs = require('fs');
const path = require('path');

test('Windows launcher and cleanup scripts use CRLF line endings', () => {
    const files = [
        '启动点歌台.bat',
        '清理点歌台进程.bat'
    ];
    for (const file of files) {
        const bytes = fs.readFileSync(path.join(__dirname, '..', file));
        for (let index = 0; index < bytes.length; index += 1) {
            if (bytes[index] === 0x0a) assert.strictEqual(bytes[index - 1], 0x0d, `${file} contains a bare LF`);
        }
    }
});
