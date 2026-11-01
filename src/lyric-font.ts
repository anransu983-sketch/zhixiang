// 歌词自定义字体（借鉴 AM++ 歌词字体的导入事务口径全新写）：
// 用户导入 TTF/OTF 只作用于播放页歌词区，可一键恢复默认。
//
// 持久化分工：字体文件本体几 MB，localStorage 放不下，Blob 存
// IndexedDB（本模块内最小封装，只有 save/load/delete 三个口子）；
// 字体显示名是个小字符串，存 localStorage 即可。
// 导入事务：先校验（扩展名/MIME＋10MB 上限），再 FontFace.load()
// 真加载成功，才替换内存注册并落存——失败给原因、旧字体原样保留，
// 不留半截状态（学 AM++：导入失败不破坏既有可用字体）。
// 注册走 FontFace API 挂 document.fonts，family 名固定
// ZhixiangLyricFont；应用时由播放页把 font-family 只挂到歌词盒，
// 不影响 App 其他文字。

export const LYRIC_FONT_FAMILY = 'ZhixiangLyricFont';
// CSS 侧应用的完整 font-family 值：自定义在前、系统无衬线兜底。
export const LYRIC_FONT_CSS = `'${LYRIC_FONT_FAMILY}', sans-serif`;

const MAX_FONT_BYTES = 10 * 1024 * 1024;
const FONT_NAME_KEY = 'zx.player.lyricFontName';

const DB_NAME = 'zx-lyric-font';
const DB_STORE = 'files';
const FONT_BLOB_KEY = 'current';

// ---- IndexedDB 最小封装（单库单 store，只存当前字体一个 Blob） ----

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(DB_STORE)) {
                request.result.createObjectStore(DB_STORE);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB 打开失败'));
    });
}

function idbRun<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return openDb().then(
        (db) =>
            new Promise<T>((resolve, reject) => {
                const tx = db.transaction(DB_STORE, mode);
                const request = run(tx.objectStore(DB_STORE));
                request.onsuccess = () => {
                    db.close();
                    resolve(request.result);
                };
                request.onerror = () => {
                    db.close();
                    reject(request.error ?? new Error('IndexedDB 读写失败'));
                };
            })
    );
}

export function saveLyricFontBlob(blob: Blob): Promise<void> {
    return idbRun('readwrite', (store) => store.put(blob, FONT_BLOB_KEY)).then(() => undefined);
}

export function loadLyricFontBlob(): Promise<Blob | null> {
    return idbRun<Blob | undefined>('readonly', (store) => store.get(FONT_BLOB_KEY)).then(
        (blob) => blob ?? null,
        () => null // 读不到当没存过字体，不让字体问题挡住播放页。
    );
}

export function deleteLyricFontBlob(): Promise<void> {
    return idbRun('readwrite', (store) => store.delete(FONT_BLOB_KEY)).then(() => undefined);
}

// ---- 字体显示名（localStorage 小字段；空串＝默认字体） ----

export function getLyricFontName(): string {
    try {
        return localStorage.getItem(FONT_NAME_KEY) ?? '';
    } catch {
        return '';
    }
}

function setLyricFontName(name: string): void {
    try {
        if (name) {
            localStorage.setItem(FONT_NAME_KEY, name);
        } else {
            localStorage.removeItem(FONT_NAME_KEY);
        }
    } catch {
        // 存不进只丢显示名，字体本体仍以 IndexedDB 为准。
    }
}

// ---- 注册与导入 ----

// 已注册的 FontFace 引用：替换/恢复时要从 document.fonts 里摘掉旧的，
// 否则同 family 多份并存、生效的是哪份说不准。
let registeredFace: FontFace | null = null;

async function registerFace(blob: Blob): Promise<FontFace> {
    // 走 ArrayBuffer 喂 FontFace：各 WebView 对 Blob 源的支持不一，
    // 字节源是老口径，哪都吃。
    const buffer = await blob.arrayBuffer();
    const face = new FontFace(LYRIC_FONT_FAMILY, buffer);
    const loaded = await face.load();
    if (registeredFace) {
        document.fonts.delete(registeredFace);
    }
    document.fonts.add(loaded);
    registeredFace = loaded;
    return loaded;
}

export type LyricFontImportResult =
    | { ok: true; name: string }
    | { ok: false; error: string };

// 导入一篇字体文件：校验→加载成功→落存→换显示名，任一步失败都
// 不动旧字体（旧的注册与存档原样保留），并把失败原因回给调用方提示。
export async function importLyricFont(file: File): Promise<LyricFontImportResult> {
    const lowerName = file.name.toLowerCase();
    const looksLikeFont =
        lowerName.endsWith('.ttf') ||
        lowerName.endsWith('.otf') ||
        file.type.includes('font') ||
        file.type === 'application/x-font-ttf' ||
        file.type === 'application/x-font-otf';
    if (!looksLikeFont) {
        return { ok: false, error: '只支持 TTF / OTF 字体文件' };
    }
    if (file.size === 0) {
        return { ok: false, error: '字体文件是空的' };
    }
    if (file.size > MAX_FONT_BYTES) {
        return { ok: false, error: '字体文件超过 10MB 上限' };
    }
    try {
        await registerFace(file);
    } catch {
        return { ok: false, error: '字体加载失败，文件可能已损坏或格式不支持' };
    }
    try {
        await saveLyricFontBlob(file);
    } catch {
        // 本体已注册生效，只是存不下：本次能用，下次打开恢复不了，如实提示。
        return { ok: false, error: '字体已生效但保存失败，下次打开不会保留' };
    }
    setLyricFontName(file.name);
    return { ok: true, name: file.name };
}

// 启动/进播放页时恢复：存过字体就重新注册；返回是否启用了自定义字体。
export async function restoreLyricFont(): Promise<boolean> {
    const blob = await loadLyricFontBlob();
    if (!blob) {
        return false;
    }
    try {
        await registerFace(blob);
        return true;
    } catch {
        // 存档字体加载失败：清掉坏存档回落默认，别每次启动都重试坏文件。
        await deleteLyricFontBlob().catch(() => undefined);
        setLyricFontName('');
        return false;
    }
}

// 恢复默认：摘注册、清存档与显示名，立即生效不需重开 App。
export async function clearLyricFont(): Promise<void> {
    if (registeredFace) {
        document.fonts.delete(registeredFace);
        registeredFace = null;
    }
    setLyricFontName('');
    await deleteLyricFontBlob().catch(() => undefined);
}
