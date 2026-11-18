// 搜索历史（Folia searchHistory.ts 的最小版）：按源分别存最近
// 关键词，纯本地 localStorage，与登录态无关；搜完即忘的问题
// 就靠它补。去重（大小写不敏感）、最新在前、每源上限 10 条。

import type { SourceId } from './types';

const HISTORY_LIMIT = 10;

function storageKey(sourceId: SourceId): string {
    return `zx.search.history.${sourceId}.v1`;
}

export function loadSearchHistory(sourceId: SourceId): string[] {
    try {
        const raw = localStorage.getItem(storageKey(sourceId));
        if (!raw) {
            return [];
        }
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, HISTORY_LIMIT);
    } catch {
        return [];
    }
}

export function recordSearchHistory(sourceId: SourceId, query: string): void {
    const keyword = query.trim();
    if (!keyword) {
        return;
    }
    try {
        const lowered = keyword.toLowerCase();
        const next = [
            keyword,
            ...loadSearchHistory(sourceId).filter((item) => item.toLowerCase() !== lowered)
        ].slice(0, HISTORY_LIMIT);
        localStorage.setItem(storageKey(sourceId), JSON.stringify(next));
    } catch {
        // 存不下只影响下次打开的历史，不中断搜索。
    }
}
