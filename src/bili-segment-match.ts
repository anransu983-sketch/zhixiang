// B站拆歌分段曲的网易云同名版本匹配：
// 拆歌段顶的是整个视频的合集封面，歌词补源又要按标题＋歌手匹配、
// 分段曲的歌手是 UP 主名对不上，基本拿不到词。这里按段标题去网易云
// 搜候选，只用一条硬门——候选时长与段长之差 ≤3 秒（用户定的口径：
// 除时长外不加别的硬门，标题相关性由搜索本身保证）——命中后给
// playback 换本歌自己的封面、给 lyrics 按网易云 id 直取词。
// 只服务分段 Track（id 形如 bilibili:<bvid>@<startSec>、带
// segmentStartMs）；整条视频与其它三源永远不进这里。
import { neteaseSource } from './sources/netease';
import type { Track } from './types';

export interface BiliSegmentMatch {
    neteaseId: string;
    coverUrl: string;
    durationMs: number;
}

export function isBiliSegmentTrack(track: Track): boolean {
    return (
        track.source === 'bilibili' &&
        track.segmentStartMs !== undefined &&
        track.id.includes('@')
    );
}

// 缓存键：从 track.id 剥掉 'bilibili:' 前缀，剩 <bvid>@<startSec>。
function segmentKeyOf(track: Track): string {
    const prefix = 'bilibili:';
    return track.id.startsWith(prefix) ? track.id.slice(prefix.length) : track.id;
}

// 段长：优先 Track.durationMs（拆歌构造时已按相邻起点/总时长算好），
// 缺失才用 segmentEndMs−segmentStartMs 兜底；两者都没有回 null，
// 没有段长就没法过时长硬门，本次不匹配也不写缓存。
function segmentDurationMs(track: Track): number | null {
    if (track.durationMs && track.durationMs > 0) {
        return track.durationMs;
    }
    if (track.segmentStartMs !== undefined && track.segmentEndMs !== undefined) {
        const span = track.segmentEndMs - track.segmentStartMs;
        return span > 0 ? span : null;
    }
    return null;
}

// 标题门：太泛的短名宁缺毋错（用户原话：像「红」「100」这种不搜）。
// trim 后长度 <2（单字标题也在此列），或不含任何文字（纯数字/纯符号，
// 如「100」「！！」）→ 不搜直接回 null。
export function isSearchableSegmentTitle(title: string): boolean {
    const trimmed = title.trim();
    if (trimmed.length < 2) {
        return false;
    }
    return /\p{L}/u.test(trimmed);
}

// 候选硬过滤（纯函数，供自测）：时长差 ≤3000ms 才过线，过线者取误差
// 最小；并列时严格小于才换，保住搜索序第一。
export function pickBiliSegmentCandidate(
    candidates: Track[],
    segDurationMs: number
): { track: Track; diffMs: number } | null {
    let best: Track | null = null;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
        if (!candidate.durationMs || candidate.durationMs <= 0) {
            continue;
        }
        const diff = Math.abs(candidate.durationMs - segDurationMs);
        if (diff <= 3000 && diff < bestDiff) {
            best = candidate;
            bestDiff = diff;
        }
    }
    return best ? { track: best, diffMs: bestDiff } : null;
}

// 匹配缓存（仿 lyrics.ts 的 LocalLyricCache 写法：整表 JSON、条目带
// at）：命中长期有效；未命中只记 at、7 天过期重搜（仿
// LOCAL_LYRIC_CACHE_TTL_MS）；上限 200 条按 at 淘汰最旧。
interface SegmentMatchCacheEntry {
    at: number;
    hit?: BiliSegmentMatch;
}

const SEGMENT_MATCH_CACHE_KEY = 'zx_bili_seg_match_v1';
const SEGMENT_MATCH_MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SEGMENT_MATCH_CACHE_MAX = 200;

function loadSegmentMatchCache(): Record<string, SegmentMatchCacheEntry> {
    try {
        const raw = localStorage.getItem(SEGMENT_MATCH_CACHE_KEY);
        const parsed = raw ? (JSON.parse(raw) as unknown) : null;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, SegmentMatchCacheEntry>;
        }
    } catch {
        // 存档损坏时当空缓存。
    }
    return {};
}

function saveSegmentMatchCache(cache: Record<string, SegmentMatchCacheEntry>): void {
    try {
        const keys = Object.keys(cache);
        if (keys.length > SEGMENT_MATCH_CACHE_MAX) {
            keys.sort((a, b) => (cache[a]?.at ?? 0) - (cache[b]?.at ?? 0));
            for (const key of keys.slice(0, keys.length - SEGMENT_MATCH_CACHE_MAX)) {
                delete cache[key];
            }
        }
        localStorage.setItem(SEGMENT_MATCH_CACHE_KEY, JSON.stringify(cache));
    } catch {
        // 写不进就当次有效。
    }
}

// 并发去重：封面（playback）与歌词（lyrics）两路会同时调同一段，
// 在途 Promise 表保证同 key 只搜一次。
const inflightMatches = new Map<string, Promise<BiliSegmentMatch | null>>();

export function resolveBiliSegmentMatch(track: Track): Promise<BiliSegmentMatch | null> {
    // 隐含片头段守卫：归一化补出的「片头（未标注）」不是一首歌，绝不
    // 进网易云匹配（标记由 bilibili.ts 归一化打、经 home.ts 的 Track
    // 构造传到这里）。封面（playback）与歌词（lyrics）两路都经本入
    // 口，一处守卫全覆盖；隐含段歌词照常走 B 站 CC 字幕链，那条链
    // 按 bvid 取词、不经这里，不受影响。
    if (track.segmentImplicit) {
        console.log(`[Bili] 拆歌匹配 ${segmentKeyOf(track)} 跳过（隐含片头段不匹配）`);
        return Promise.resolve(null);
    }
    if (!isBiliSegmentTrack(track)) {
        return Promise.resolve(null);
    }
    const key = segmentKeyOf(track);
    if (!isSearchableSegmentTitle(track.title)) {
        console.log(`[Bili] 拆歌匹配 ${key} 跳过（标题太泛，不搜）`);
        return Promise.resolve(null);
    }
    const cache = loadSegmentMatchCache();
    const cached = cache[key];
    if (cached?.hit) {
        return Promise.resolve(cached.hit);
    }
    if (cached && Date.now() - cached.at < SEGMENT_MATCH_MISS_TTL_MS) {
        return Promise.resolve(null);
    }
    const inflight = inflightMatches.get(key);
    if (inflight) {
        return inflight;
    }
    const promise = searchBiliSegmentMatch(track, key).finally(() => {
        inflightMatches.delete(key);
    });
    inflightMatches.set(key, promise);
    return promise;
}

async function searchBiliSegmentMatch(
    track: Track,
    key: string
): Promise<BiliSegmentMatch | null> {
    const segDuration = segmentDurationMs(track);
    if (segDuration === null) {
        console.log(`[Bili] 拆歌匹配 ${key} 跳过（段长未知，过不了时长门）`);
        return null;
    }
    let candidates: Track[];
    try {
        candidates = await neteaseSource.search(track.title.trim());
    } catch {
        // 搜索抛错多半是网络问题：回 null 且不写 miss 缓存，别毒化缓存。
        console.log(`[Bili] 拆歌匹配 ${key} 搜索失败（不缓存）`);
        return null;
    }
    const picked = pickBiliSegmentCandidate(candidates, segDuration);
    const prefix = 'netease:';
    if (picked && picked.track.id.startsWith(prefix) && picked.track.id.length > prefix.length) {
        const match: BiliSegmentMatch = {
            neteaseId: picked.track.id.slice(prefix.length),
            coverUrl: picked.track.coverUrl ?? '',
            durationMs: picked.track.durationMs ?? 0
        };
        const cache = loadSegmentMatchCache();
        cache[key] = { at: Date.now(), hit: match };
        saveSegmentMatchCache(cache);
        console.log(
            `[Bili] 拆歌匹配 ${key} 命中网易云 ${match.neteaseId}（时长差 ${(picked.diffMs / 1000).toFixed(1)}s）`
        );
        return match;
    }
    const cache = loadSegmentMatchCache();
    cache[key] = { at: Date.now() };
    saveSegmentMatchCache(cache);
    console.log(`[Bili] 拆歌匹配 ${key} 未命中（候选 ${candidates.length} 条）`);
    return null;
}
