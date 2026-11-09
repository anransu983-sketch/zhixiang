// 音源与曲目的共享类型：各音源实现与播放层都以此为准。

export type SourceId = 'local' | 'netease' | 'ytm' | 'bilibili';

export interface Track {
    id: string;
    title: string;
    artist: string;
    album?: string;
    durationMs?: number;
    coverUrl?: string;
    source: SourceId;
    // 音质角标用：本地按文件扩展名（如 FLAC），YTM 按取链元数据；
    // 未知时留空，角标隐藏，不猜。
    format?: string;
    streamUrl?: string;
    // B 站拆歌分段曲专用：原视频流内的起止偏移（毫秒）。只有按简介
    // 时间戳拆出来的分段曲才有值，播放层据此做相对时间与到点推进；
    // 普通曲一律 undefined，行为不变。
    segmentStartMs?: number;
    segmentEndMs?: number;
    // B 站拆歌的隐含片头段（首段迟开时归一化补的「片头（未标注）」）：
    // 播放/列表当普通分段，但不是一首歌——bili-segment-match 入口见
    // 此标记直接跳过，绝不搜网易云、绝不按网易云 id 取词。
    segmentImplicit?: boolean;
}

// 海报墙上的一张海报：封面 + 可播曲目列表，点海报即播整个列表。
export interface Poster {
    id: string;
    title: string;
    subtitle?: string;
    coverUrl?: string;
    source: SourceId;
    tracks: Track[];
}

export interface AudioSource {
    id: SourceId;
    label: string;
    search(query: string): Promise<Track[]>;
    resolveStream(track: Track): Promise<string>;
}
