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
