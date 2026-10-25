// 音源注册表：后续块在这里追加新音源，首页与播放层只认这张表。
import { localSource } from './local';
import { neteaseSource } from './netease';
import { ytmSource } from './ytm';
import type { AudioSource, SourceId } from '../types';

export const SOURCES: AudioSource[] = [localSource, neteaseSource, ytmSource];

export function getSource(id: SourceId): AudioSource | undefined {
    return SOURCES.find((source) => source.id === id);
}
