// 网易云失败兜底（0.1.105，思路借鉴 NeriPlayer 的
// PlayerManagerNeteaseAutoSourceSwitch）：网易云曲目起不来时，用歌名＋
// 歌手去 B 站搜，按歌名/歌手/时长打分，够分就播 B 站版；不够分不硬播
// （错版比没声糟）。兜底只在播放层 tryPlayFrom 里触发，本模块不碰队列。

import { bilibiliSource} from './bilibili';
import { localSource } from './local';
import type { Track} from '../types';

// 比对用：小写、去空白与常见标点，不动原文字。
function clean(text: string): string {
return text
.toLowerCase()
.replace(
/[\s!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~、。！？；：，．·「」『』《》〈〉（）]/g,
''
);
}

function scoreCandidate(original: Track, candidate: Track): number {
let score = 0;
const oTitle = clean(original.title);
const cTitle = clean(candidate.title);
if (oTitle && cTitle) {
if (oTitle === cTitle) {
score += 50;
} else if (cTitle.includes(oTitle) || oTitle.includes(cTitle)) {
score += 30;
}
}
const oArtist = clean(original.artist);
const cArtist = clean(candidate.artist);
if (oArtist && cArtist && oArtist!== '未知歌手') {
if (oArtist === cArtist) {
score += 30;
} else if (cArtist.includes(oArtist) || oArtist.includes(cArtist)) {
score += 15;
}
}
// B 站候选的 artist 是 UP 主名、几乎永不等于歌手，歌手名实际写在
// 视频标题里（「孙燕姿 - 我不难过」式）。只查 artist 字段时歌手分
// 永远拿不到，最高分恒为歌名包含 30＋时长 20＝50、够不到 60 线，
// 兜底等于没接（2026-11-27 真机日志 10 首全卡 50 分）。歌手名
// 出现在候选标题里同样是佐证：＋20。多歌手按分隔符拆开逐个查。
if (oArtist && oArtist!== '未知歌手' && cTitle) {
const parts = original.artist
.split(/[/、,，&]/)
.map((part) => clean(part))
.filter((part) => part.length >= 2);
if (parts.some((part) => cTitle.includes(part))) {
score += 20;
}
}
if (original.durationMs && candidate.durationMs) {
const diff = Math.abs(original.durationMs - candidate.durationMs) / 1000;
if (diff <= 3) {
score += 20;
} else if (diff <= 10) {
score += 10;
} else if (diff <= 30) {
score += 5;
}
}
return score;
}

// 够分线 60：歌名全对＋时长 10 秒内，或歌名包含＋歌手全对，
// 或歌名包含＋歌手名在标题里＋时长 10 秒内。歌名单对 50 分不够
// （须歌手或时长佐证，防同名翻唱）。
const SCORE_THRESHOLD = 60;

export async function findBilibiliFallback(track: Track): Promise<Track | null> {
let candidates: Track[];
try {
candidates = await bilibiliSource.search(`${track.title} ${track.artist}`);
} catch (error) {
console.log(
`[Playback] B 站兜底搜索失败：${error instanceof Error? error.message: '未知原因'}`
);
return null;
}
let best: Track | null = null;
let bestScore = 0;
for (const candidate of candidates) {
const score = scoreCandidate(track, candidate);
if (score > bestScore) {
bestScore = score;
best = candidate;
}
}
if (best && bestScore >= SCORE_THRESHOLD) {
console.log(
`[Playback] 网易云失败→B 站兜底：${track.title} → ${best.title}（${best.artist}，${bestScore} 分）`
);
return best;
}
// 没够分时把最高候选是谁、时长差多少一并记下：只记分数分不清
// 是候选不对还是评分口径卡死，下次看日志要能直接定性。
const bestDiff =
best && track.durationMs && best.durationMs
? `${Math.abs(track.durationMs - best.durationMs) / 1000}s`
: '未知';
console.log(
`[Playback] B 站兜底无够分候选：${track.title}（最高 ${bestScore} 分` +
(best ? `：${best.title} / ${best.artist} / 时长差 ${bestDiff}` : '：无候选') +
'）'
);
return null;
}

// 本地兜底归一化（借鉴 NeriPlayer 本地音频兜底）：去 feat 尾巴后
// 再走 clean 的小写去标点；歌手取分隔符前的第一位主歌手。
function stripFeat(text: string): string {
return text
.replace(/[（(][^）)]*\b(?:feat\.?|ft\.?|featuring)\b[^）)]*[）)]/gi, '')
.replace(/\s*\b(?:feat\.?|ft\.?|featuring)\b.*$/i, '');
}

function mainArtistNorm(artist: string): string {
const first = stripFeat(artist).split(/[/、,，&;；]|\s+(?:with|和|与)\s+/i)[0] ?? '';
return clean(first);
}

function titleNorm(title: string): string {
return clean(stripFeat(title));
}

// 本地兜底：标题与主歌手归一化后严格相等、且时长差 ≤3 秒才命中
// （错版比没声糟，宁可不兜）；多命中取时长差最小的一首。
export async function findLocalFallback(track: Track): Promise<Track | null> {
if (!track.durationMs || track.durationMs <= 0) {
return null;
}
let all: Track[];
try {
all = await localSource.search('');
} catch {
return null;
}
const wantTitle = titleNorm(track.title);
const wantArtist = mainArtistNorm(track.artist);
if (!wantTitle || !wantArtist || wantArtist === '未知歌手') {
return null;
}
let best: Track | null = null;
let bestDiff = Infinity;
for (const candidate of all) {
if (!candidate.durationMs || candidate.durationMs <= 0) {
continue;
}
const diff = Math.abs(candidate.durationMs - track.durationMs);
if (diff > 3000) {
continue;
}
if (titleNorm(candidate.title) !== wantTitle) {
continue;
}
if (mainArtistNorm(candidate.artist) !== wantArtist) {
continue;
}
if (diff < bestDiff) {
bestDiff = diff;
best = candidate;
}
}
if (best) {
console.log(
`[Playback] 本地兜底：${track.title} → ${best.title}（${best.artist}，时长差 ${(bestDiff / 1000).toFixed(1)}s）`
);
}
return best;
}
