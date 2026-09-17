import musicServer from './musicServers/music-server.js?v=20260917-1';
import { findLineIndex, mergeTranslation, normalizeLyrics, parseLrc } from './lyric-parser.mjs';

const lyricCache = new Map();
const lyricInflight = new Map();
let lyricCacheGeneration = 0;
const PARSER_VERSION = 1;
const VALID_TTL = 24 * 60 * 60 * 1000;
const EMPTY_TTL = 60 * 60 * 1000;

function abortError(signal) {
    if (signal?.reason instanceof Error) return signal.reason;
    const error = new Error('歌词请求已取消');
    error.name = 'AbortError';
    return error;
}

function waitForConsumer(request, signal) {
    if (!signal) return request;
    if (signal.aborted) return Promise.reject(abortError(signal));
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            cleanup();
            reject(abortError(signal));
        };
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
        request.then(value => {
            cleanup();
            resolve(value);
        }, error => {
            cleanup();
            reject(error);
        });
    });
}

class LyricService {
    key(song) {
        return song?.sid == null ? '' : `${song.platform || 'wy'}:${song.sid}:parser-${PARSER_VERSION}`;
    }

    async load(song, { signal } = {}) {
        if (!song?.sid || song.platform !== 'wy') {
            return { status: 'unsupported', lines: [], noLyrics: false };
        }
        const key = this.key(song);
        const cached = lyricCache.get(key);
        if (cached && Date.now() - cached.fetchedAt < cached.ttl) {
            return {
                ...cached.value,
                lines: Array.isArray(cached.value.lines) ? cached.value.lines.map(line => ({ ...line })) : []
            };
        }
        let request = lyricInflight.get(key);
        if (!request) {
            const requestGeneration = lyricCacheGeneration;
            request = (async () => {
                const value = await musicServer.getServer('wy').getLyrics(song.sid);
                const normalized = value?.instrumental
                    ? { ...value, lines: [], status: 'instrumental', parserVersion: PARSER_VERSION }
                    : value?.noLyrics || !value?.lines?.length
                        ? { ...value, lines: [], status: 'empty', parserVersion: PARSER_VERSION }
                        : { ...value, status: 'ready', parserVersion: PARSER_VERSION };
                if (requestGeneration === lyricCacheGeneration) {
                    lyricCache.set(key, {
                        fetchedAt: Date.now(),
                        ttl: normalized.status === 'ready' ? VALID_TTL : EMPTY_TTL,
                        value: normalized
                    });
                }
                return normalized;
            })();
            lyricInflight.set(key, request);
            request.then(() => {
                if (lyricInflight.get(key) === request) lyricInflight.delete(key);
            }, () => {
                if (lyricInflight.get(key) === request) lyricInflight.delete(key);
            });
        }
        try {
            const value = await waitForConsumer(request, signal);
            return { ...value, lines: Array.isArray(value.lines) ? value.lines.map(line => ({ ...line })) : [] };
        } catch (error) {
            if (error?.name === 'AbortError' || error?.code === 'ERR_CANCELED') throw error;
            return { status: 'error', lines: [], error };
        }
    }

    parseLrc(text) { return parseLrc(text); }
    mergeTranslation(original, translation, toleranceMs = 250) {
        return mergeTranslation(original, translation, toleranceMs);
    }
    findLineIndex(lines, timeMs) { return findLineIndex(lines, timeMs); }
    clearMemoryCache() {
        lyricCacheGeneration += 1;
        lyricCache.clear();
        lyricInflight.clear();
    }
}

export { LyricService, parseLrc, mergeTranslation, findLineIndex, normalizeLyrics };
export default new LyricService();
