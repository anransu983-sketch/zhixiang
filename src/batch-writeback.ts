// 批量词图写回（0.1.106）：只写 sidecar，不动原音频文件。
// 对每首本地歌：已有内嵌/sidecar 歌词的跳过（记“已有”）；无词的走
// 联网补源，命中才写——歌词写同目录同名 .lrc（UTF-8），封面写同名
// .jpg；目标已存在时原生跳过不覆盖。写之前须授予所有文件访问权限，
// 没开时直接抛错、不写。单首失败不中断整批。

import {
    checkAllFilesAccess,
    downloadCoverImage,
    getLocalCoverFromNetease,
    getLocalEmbeddedLyrics,
    getLocalPath,
    localSource,
    writeSidecar
} from './sources/local';
import { fetchLocalLyrics } from './lyrics';
import type { LyricLine } from './lyrics';

export interface BatchWritebackProgress {
    done: number;
    total: number;
    ok: number;
    skipped: number;
    noMatch: number;
    failed: number;
}

// LyricLine[] 拼回 LRC：有时间轴的行写 [mm:ss.xx] 前缀，纯文本行
// （timeMs 为无穷大）直接写文本。
function linesToLrc(lines: LyricLine[]): string {
    return lines
        .map((line) => {
            const ms = line.timeMs;
            if (!Number.isFinite(ms) || ms < 0) {
                return line.text;
            }
            const totalCs = Math.floor(ms / 10);
            const mm = String(Math.floor(totalCs / 6000)).padStart(2, '0');
            const ss = String(Math.floor(totalCs / 100) % 60).padStart(2, '0');
            const xx = String(totalCs % 100).padStart(2, '0');
            return `[${mm}:${ss}.${xx}]${line.text}`;
        })
        .join('\n');
}

export async function runBatchWriteback(
    onProgress?: (progress: BatchWritebackProgress) => void
): Promise<BatchWritebackProgress> {
    if (!(await checkAllFilesAccess())) {
        throw new Error('请先授予所有文件访问权限，再开始写回');
    }
    const tracks = await localSource.search('');
    const progress: BatchWritebackProgress = {
        done: 0,
        total: tracks.length,
        ok: 0,
        skipped: 0,
        noMatch: 0,
        failed: 0
    };
    const report = (): void => {
        onProgress?.({ ...progress });
    };
    for (const track of tracks) {
        try {
            const path = getLocalPath(track);
            if (!path) {
                // 扫描缓存里没有路径：跳过，不重扫。
                progress.skipped += 1;
            } else {
                const embedded = await getLocalEmbeddedLyrics(track);
                if (embedded) {
                    // 已有内嵌/sidecar 歌词：跳过，不覆盖。
                    progress.skipped += 1;
                } else {
                    const matched = await fetchLocalLyrics(track);
                    if (!matched || matched.lines.length === 0) {
                        progress.noMatch += 1;
                    } else {
                        const lyrics = linesToLrc(matched.lines);
                        // 封面失败不拦歌词写回：拿不到就只写词。
                        let coverDataUrl: string | undefined;
                        try {
                            const coverUrl = await getLocalCoverFromNetease(track);
                            if (coverUrl) {
                                coverDataUrl =
                                    (await downloadCoverImage(coverUrl)) ?? undefined;
                            }
                        } catch {
                            coverDataUrl = undefined;
                        }
                        const result = await writeSidecar({
                            path,
                            lyrics,
                            coverDataUrl
                        });
                        if (result.lyricWritten || result.coverWritten) {
                            progress.ok += 1;
                        } else if (result.skipped) {
                            progress.skipped += 1;
                        } else {
                            progress.failed += 1;
                        }
                    }
                }
            }
        } catch {
            progress.failed += 1;
        }
        progress.done += 1;
        report();
    }
    return { ...progress };
}
