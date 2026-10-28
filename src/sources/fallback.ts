// 网易云失败兜底（0.1.105，思路借鉴 NeriPlayer 的
// PlayerManagerNeteaseAutoSourceSwitch）：网易云曲目起不来时，用歌名＋
// 歌手去 B 站搜，按歌名/歌手/时长打分，够分就播 B 站版；不够分不硬播
// （错版比没声糟）。兜底只在播放层 tryPlayFrom 里触发，本模块不碰队列。

import { bilibiliSource} from './bilibili';
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
// 歌名单对 50 分不够（须歌手或时长佐证，防同名翻唱）。
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
console.log(`[Playback] B 站兜底无够分候选：${track.title}（最高 ${bestScore} 分）`);
return null;
}
