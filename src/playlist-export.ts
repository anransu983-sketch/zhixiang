// 自建歌单 JSON 导出／导入（第 5 项，全新写）：把全部自建歌单打成
// 一个 JSON 存到系统下载目录，换机／清数据后选文件恢复，不再丢单。
//
// 格式 v1（自定，不与 Folia 的文件格式兼容）：
//   { format:'zhixiang-playlists', version:1, exportedAt,
//     playlists:[{ name, createdAt,
//                  tracks:[{ id, title, artist, album?, durationMs?,
//                            coverUrl?, source, format? }] }] }
//   只认本机能播的四源（local／netease／ytm／bilibili）；streamUrl
//   绝不进文件，播放时现取现用（与 playlists.ts 的存储口径一致）。
//
// 导入先解析校验、逐条标出问题再确认，确认前什么都不写：
//   - 格式／版本不符、JSON 读不懂、文件里没有歌单 → 整包拒绝；
//   - 单条缺 id／缺标题／缺歌手／来源缺失或不支持 → 逐条列出原因，
//     该条跳过，其余可导入的照常进，不静默丢；
//   - 同单内同 source:id 重复 → 逐条列出“与本单第 N 首重复”，只留首条；
//   - 歌单名缺失或曲目清单缺失 → 整单跳过并列出原因；
//   - 写入时走 addTrackToPlaylist，按 playlists.ts 的 trackKey
//     （source:id）去重；重名歌单不覆盖，新建时加“（导入）”后缀。

import { addTrackToPlaylist, createPlaylist, loadPlaylists, trackKey } from './playlists';
import type { Playlist } from './playlists';
import type { SourceId, Track } from './types';
import { saveFileToDownloads } from './sources/local';

export const PLAYLIST_EXPORT_FORMAT = 'zhixiang-playlists';
export const PLAYLIST_EXPORT_VERSION = 1;

const PLAYABLE_SOURCES: ReadonlySet<string> = new Set(['local', 'netease', 'ytm', 'bilibili']);

const SOURCE_LABELS: Record<SourceId, string> = {
    local: '本地',
    netease: '网易云',
    ytm: 'YTM',
    bilibili: 'B站'
};

export function playlistSourceLabel(source: SourceId): string {
    return SOURCE_LABELS[source] ?? source;
}

/** 预览里逐条列出的问题：所属歌单＋曲名＋原因。 */
export interface PlaylistImportIssue {
    playlistName: string;
    title: string;
    reason: string;
}

/** 预览里一个待新建的歌单：文件原名、实际新建名、可导入曲目。 */
export interface PlaylistImportTarget {
    sourceName: string;
    targetName: string;
    tracks: Track[];
}

/** 导入预览：解析完、确认前给用户看的全部信息，确认前不落盘。 */
export interface PlaylistImportPreview {
    filePlaylists: number;
    totalTracks: number;
    validTracks: number;
    sourceCounts: Record<SourceId, number>;
    targets: PlaylistImportTarget[];
    invalid: PlaylistImportIssue[];
    duplicates: PlaylistImportIssue[];
    skippedPlaylists: Array<{ name: string; reason: string }>;
}

function bytesToBase64(bytes: Uint8Array): string {
    // 与 lyrics-backup.ts 同款分块拼法：btoa 一次吃不下大字符串。
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

function exportTrack(track: Track): Record<string, unknown> {
    const entry: Record<string, unknown> = {
        id: track.id,
        title: track.title,
        artist: track.artist,
        source: track.source
    };
    if (track.album !== undefined) {
        entry.album = track.album;
    }
    if (track.durationMs !== undefined) {
        entry.durationMs = track.durationMs;
    }
    if (track.coverUrl !== undefined) {
        entry.coverUrl = track.coverUrl;
    }
    if (track.format !== undefined) {
        entry.format = track.format;
    }
    return entry;
}

export function buildPlaylistExportJson(lists: Playlist[]): string {
    return JSON.stringify(
        {
            format: PLAYLIST_EXPORT_FORMAT,
            version: PLAYLIST_EXPORT_VERSION,
            exportedAt: new Date().toISOString(),
            playlists: lists.map((list) => ({
                name: list.name,
                createdAt: list.createdAt,
                tracks: list.tracks.map(exportTrack)
            }))
        },
        null,
        2
    );
}

// 导出全部自建歌单到下载目录，返回文件名与歌单／曲目数；没有歌单时抛中文原因。
export async function exportPlaylistsToDownloads(): Promise<{
    filename: string;
    playlists: number;
    tracks: number;
}> {
    const lists = loadPlaylists();
    if (lists.length === 0) {
        throw new Error('还没有自建歌单，先建一个再导出');
    }
    const bytes = new TextEncoder().encode(buildPlaylistExportJson(lists));
    const now = new Date();
    const stamp =
        `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}` +
        `-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    const filename = `zhixiang-playlists-${stamp}.json`;
    try {
        const result = await saveFileToDownloads(filename, bytesToBase64(bytes));
        return {
            filename: result.filename || filename,
            playlists: lists.length,
            tracks: lists.reduce((sum, list) => sum + list.tracks.length, 0)
        };
    } catch (error) {
        // 原生 reject 的 message 已是可展示的中文原因，原样上抛。
        throw error instanceof Error ? error : new Error('导出失败，请稍后再试');
    }
}

// ---- 导入校验：单条曲目只认“字段齐＋来源可播”，缺什么就报什么 ----

function displayTitle(raw: Record<string, unknown>): string {
    if (typeof raw.title === 'string' && raw.title.trim().length > 0) {
        return raw.title;
    }
    if (typeof raw.id === 'string' && raw.id.length > 0) {
        return `id ${raw.id}`;
    }
    return '（无名）';
}

function cleanImportTrack(
    raw: unknown,
    playlistName: string
): { track: Track } | { issue: PlaylistImportIssue } {
    if (typeof raw !== 'object' || raw === null) {
        return {
            issue: { playlistName, title: '（无名）', reason: '这条记录读不懂' }
        };
    }
    const item = raw as Record<string, unknown>;
    const title = displayTitle(item);
    if (typeof item.id !== 'string') {
        return { issue: { playlistName, title, reason: '缺少 id' } };
    }
    if (item.id.length === 0) {
        return { issue: { playlistName, title, reason: 'id 为空' } };
    }
    if (typeof item.title !== 'string' || item.title.trim().length === 0) {
        return { issue: { playlistName, title, reason: '缺少标题' } };
    }
    if (typeof item.artist !== 'string') {
        return { issue: { playlistName, title, reason: '缺少歌手' } };
    }
    if (typeof item.source !== 'string' || item.source.length === 0) {
        return { issue: { playlistName, title, reason: '来源缺失' } };
    }
    if (!PLAYABLE_SOURCES.has(item.source)) {
        return {
            issue: { playlistName, title, reason: `来源不支持「${item.source}」` }
        };
    }
    const track: Track = {
        id: item.id,
        title: item.title,
        artist: item.artist,
        source: item.source as SourceId
    };
    if (typeof item.album === 'string') {
        track.album = item.album;
    }
    if (typeof item.durationMs === 'number') {
        track.durationMs = item.durationMs;
    }
    if (typeof item.coverUrl === 'string') {
        track.coverUrl = item.coverUrl;
    }
    if (typeof item.format === 'string') {
        track.format = item.format;
    }
    return { track };
}

function resolveTargetName(name: string, taken: Set<string>): string {
    if (!taken.has(name)) {
        return name;
    }
    const renamed = `${name}（导入）`;
    if (!taken.has(renamed)) {
        return renamed;
    }
    let index = 2;
    while (taken.has(`${renamed} ${index}`)) {
        index += 1;
    }
    return `${renamed} ${index}`;
}

// 读入用户选的导出文件并校验，返回预览（先不落盘，确认后才写）。
export async function parsePlaylistExportFile(file: File): Promise<PlaylistImportPreview> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(await file.text());
    } catch {
        throw new Error('这个文件不是有效的 JSON，换个芷湘导出的歌单文件再试');
    }
    if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('不是芷湘的歌单导出文件（格式不符）');
    }
    const record = parsed as Record<string, unknown>;
    if (record.format !== PLAYLIST_EXPORT_FORMAT || record.version !== PLAYLIST_EXPORT_VERSION) {
        throw new Error('不是芷湘的歌单导出文件（格式或版本不符）');
    }
    if (!Array.isArray(record.playlists)) {
        throw new Error('文件里没有歌单清单，换个芷湘导出的歌单文件再试');
    }
    if (record.playlists.length === 0) {
        throw new Error('文件里没有歌单');
    }
    const taken = new Set(loadPlaylists().map((list) => list.name));
    const preview: PlaylistImportPreview = {
        filePlaylists: record.playlists.length,
        totalTracks: 0,
        validTracks: 0,
        sourceCounts: { local: 0, netease: 0, ytm: 0, bilibili: 0 },
        targets: [],
        invalid: [],
        duplicates: [],
        skippedPlaylists: []
    };
    for (const rawList of record.playlists as unknown[]) {
        if (typeof rawList !== 'object' || rawList === null) {
            preview.skippedPlaylists.push({ name: '（无名）', reason: '这条歌单记录读不懂，整单跳过' });
            continue;
        }
        const entry = rawList as Record<string, unknown>;
        const name = typeof entry.name === 'string' ? entry.name.trim() : '';
        if (name.length === 0) {
            preview.skippedPlaylists.push({ name: '（无名）', reason: '歌单名缺失，整单跳过' });
            continue;
        }
        if (!Array.isArray(entry.tracks)) {
            preview.skippedPlaylists.push({ name, reason: '曲目清单缺失，整单跳过' });
            continue;
        }
        const tracks: Track[] = [];
        const seen = new Map<string, number>();
        for (const rawTrack of entry.tracks as unknown[]) {
            preview.totalTracks += 1;
            const cleaned = cleanImportTrack(rawTrack, name);
            if ('issue' in cleaned) {
                preview.invalid.push(cleaned.issue);
                continue;
            }
            const track = cleaned.track;
            const key = trackKey(track);
            const firstIndex = seen.get(key);
            if (firstIndex !== undefined) {
                preview.duplicates.push({
                    playlistName: name,
                    title: track.title,
                    reason: `与本单第 ${firstIndex + 1} 首重复（${key}），只留首条`
                });
                continue;
            }
            seen.set(key, tracks.length);
            tracks.push(track);
            preview.validTracks += 1;
            preview.sourceCounts[track.source] += 1;
        }
        const targetName = resolveTargetName(name, taken);
        taken.add(targetName);
        preview.targets.push({ sourceName: name, targetName, tracks });
    }
    if (preview.targets.length === 0) {
        throw new Error('文件里的歌单都读不懂，没有可导入的歌单');
    }
    return preview;
}

// 执行导入：按预览里的目标名新建歌单，逐首经 addTrackToPlaylist
// 写入（trackKey 去重，已在里面的再记一笔 exists，不重复写）。
export function applyPlaylistImport(preview: PlaylistImportPreview): {
    created: number;
    added: number;
    exists: number;
} {
    let created = 0;
    let added = 0;
    let exists = 0;
    for (const target of preview.targets) {
        const playlist = createPlaylist(target.targetName);
        created += 1;
        for (const track of target.tracks) {
            const result = addTrackToPlaylist(playlist.id, track);
            if (result === 'added') {
                added += 1;
            } else if (result === 'exists') {
                exists += 1;
            }
        }
    }
    return { created, added, exists };
}
