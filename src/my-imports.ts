// 私藏（0.1.87，原我的导入）：本地自定义库。
//
// 本地页默认是全量扫描（铃声、DCIM、Telegram 音频都会进来），私藏是
// 在全量之外另建的分组：用户从扫描结果里勾选歌曲导进来，只显示自己挑的。
// 删除只删芷湘这里的记录（id 集合），手机里的文件不动，随时能重新导入找回。
// 只存 MediaStore 曲目 id，不存文件路径：展示与播放时按 id 对当次扫描结果
// 做解析，文件不在扫描里时该条自动跳过（不自动清库，避免一次扫描失败误删）。

const STORAGE_KEY = 'zx.my_imports.v1';

export function loadMyImportIds(): string[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return [];
        }
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }
        const seen = new Set<string>();
        const ids: string[] = [];
        for (const item of parsed) {
            if (typeof item === 'string' && item.length > 0 && !seen.has(item)) {
                seen.add(item);
                ids.push(item);
            }
        }
        return ids;
    } catch {
        return [];
    }
}

export function saveMyImportIds(ids: string[]): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
    } catch {
        // 存储不可用时只影响下次打开的默认值，不中断当前操作。
    }
}

export function addMyImportIds(ids: string[]): string[] {
    const merged = [...loadMyImportIds()];
    for (const id of ids) {
        if (!merged.includes(id)) {
            merged.push(id);
        }
    }
    saveMyImportIds(merged);
    return merged;
}

export function removeMyImportId(id: string): string[] {
    const kept = loadMyImportIds().filter((item) => item !== id);
    saveMyImportIds(kept);
    return kept;
}
