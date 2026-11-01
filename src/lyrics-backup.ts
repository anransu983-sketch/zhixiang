// 手动歌词备份恢复（0.1.131，全新写）：把 manual-lyrics 的全部贴词
// 打成一个 ZIP 存到系统下载目录，换机／清数据后选包恢复，不再丢词
// （此前贴词只存 localStorage，清数据即全丢）。格式口径借鉴 AM++ 的
// 自定义歌词 ZIP 备份：包内一份 manifest.json 描述条目、恢复时用户
// 选覆盖或保留；校验口径同样借鉴——格式／版本不符整包拒绝。
//
// ZIP 不引第三方库，自己实现最小子集：写出只用 stored（不压缩，
// 歌词文本量小，压缩收益低，stored 还保证任何解压工具可读）；读入
// 支持 stored 与 deflate（inflate 走平台 DecompressionStream，
// 不可用时如实报错）。ZIP64 不支持：备份包远到不了 4GB／65535 条
// 的量级，遇到直接报错，不猜。
//
// 备份格式 v1：
//   manifest.json  { format:'zhixiang-manual-lyrics', version:1,
//                    exportedAt, entries:[{ key, file, savedAt }] }
//   lyrics/0001.lrc|.ttml  每条贴词一个文件，内容是 TTML 存 .ttml、
//                    否则 .lrc；key 与 manual-lyrics 的存储键同口径
//                    （source:id），恢复按 key 对齐本机已有贴词。

import { hasManualLyricsKey, listManualLyrics, setManualLyricsByKey } from './manual-lyrics';
import type { ManualLyricsEntry } from './manual-lyrics';
import { isTtmlText } from './ttml';
import { saveFileToDownloads } from './sources/local';

export type { ManualLyricsEntry };

const BACKUP_FORMAT = 'zhixiang-manual-lyrics';
const BACKUP_VERSION = 1;

// ---- CRC32（ZIP 校验用，标准多项式查表） ----

const CRC_TABLE: number[] = (() => {
    const table: number[] = [];
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table.push(c >>> 0);
    }
    return table;
})();

export function crc32(data: Uint8Array): number {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
        crc = CRC_TABLE[(crc ^ (data[i] ?? 0)) & 0xff]! ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

// ---- ZIP 写出（stored） ----

export interface ZipFileEntry {
    name: string;
    data: Uint8Array;
}

function dosDateTime(date: Date): { time: number; date: number } {
    const time =
        ((date.getHours() & 0x1f) << 11) |
        ((date.getMinutes() & 0x3f) << 5) |
        ((date.getSeconds() >> 1) & 0x1f);
    const dosDate =
        (((Math.max(1980, date.getFullYear()) - 1980) & 0x7f) << 9) |
        (((date.getMonth() + 1) & 0xf) << 5) |
        (date.getDate() & 0x1f);
    return { time, date: dosDate };
}

export function buildZipBytes(files: ZipFileEntry[]): Uint8Array {
    const encoder = new TextEncoder();
    const { time, date } = dosDateTime(new Date());
    const parts: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    const u16 = (value: number): Uint8Array => {
        const bytes = new Uint8Array(2);
        new DataView(bytes.buffer).setUint16(0, value, true);
        return bytes;
    };
    const u32 = (value: number): Uint8Array => {
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value, true);
        return bytes;
    };
    const push = (list: Uint8Array[], bytes: Uint8Array): void => {
        list.push(bytes);
    };
    for (const file of files) {
        const nameBytes = encoder.encode(file.name);
        const crc = crc32(file.data);
        const local = [
            u32(0x04034b50),
            u16(20),
            u16(0x0800), // UTF-8 文件名标志
            u16(0), // stored
            u16(time),
            u16(date),
            u32(crc),
            u32(file.data.length),
            u32(file.data.length),
            u16(nameBytes.length),
            u16(0)
        ];
        for (const part of local) {
            push(parts, part);
        }
        push(parts, nameBytes);
        push(parts, file.data);
        const centralEntry = [
            u32(0x02014b50),
            u16(20),
            u16(20),
            u16(0x0800),
            u16(0),
            u16(time),
            u16(date),
            u32(crc),
            u32(file.data.length),
            u32(file.data.length),
            u16(nameBytes.length),
            u16(0), // extra
            u16(0), // comment
            u16(0), // disk
            u16(0), // internal attrs
            u32(0), // external attrs
            u32(offset)
        ];
        for (const part of centralEntry) {
            push(central, part);
        }
        push(central, nameBytes);
        offset += local.reduce((sum, part) => sum + part.length, 0) + nameBytes.length + file.data.length;
    }
    const centralStart = offset;
    const centralSize = central.reduce((sum, part) => sum + part.length, 0);
    const end = [
        u32(0x06054b50),
        u16(0),
        u16(0),
        u16(files.length),
        u16(files.length),
        u32(centralSize),
        u32(centralStart),
        u16(0)
    ];
    const all = [...parts, ...central, ...end];
    const total = all.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let cursor = 0;
    for (const part of all) {
        out.set(part, cursor);
        cursor += part.length;
    }
    return out;
}

// ---- ZIP 读入（stored + deflate） ----

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
    if (typeof DecompressionStream !== 'function') {
        // 平台没有解压能力时如实报错，不假装读过。
        throw new Error('当前环境不支持解压这个备份包（deflate 条目）');
    }
    const source = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(data);
            controller.close();
        }
    });
    // TS 的 DOM 类型里 DecompressionStream 的泛型与 pipeThrough 对不齐
    // （运行时无碍），这里窄化成字节流配对再接。
    const stream = source.pipeThrough(
        new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<
            Uint8Array,
            Uint8Array
        >
    );
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
}

export async function parseZipBytes(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // EOCD 在包尾（注释最长 64KB），从尾往前找签名。
    const searchFloor = Math.max(0, bytes.length - 22 - 0xffff);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= searchFloor; i--) {
        if (view.getUint32(i, true) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) {
        throw new Error('不是有效的 ZIP 文件（找不到中央目录）');
    }
    const total = view.getUint16(eocd + 10, true);
    const centralOffset = view.getUint32(eocd + 16, true);
    if (centralOffset === 0xffffffff) {
        throw new Error('ZIP64 备份包暂不支持');
    }
    const decoder = new TextDecoder();
    const files = new Map<string, Uint8Array>();
    let cursor = centralOffset;
    for (let index = 0; index < total; index++) {
        if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x02014b50) {
            throw new Error('ZIP 中央目录损坏');
        }
        const method = view.getUint16(cursor + 10, true);
        const compressedSize = view.getUint32(cursor + 20, true);
        const nameLength = view.getUint16(cursor + 28, true);
        const extraLength = view.getUint16(cursor + 30, true);
        const commentLength = view.getUint16(cursor + 32, true);
        const localOffset = view.getUint32(cursor + 42, true);
        const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
        if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) {
            throw new Error(`ZIP 条目损坏：${name}`);
        }
        const localNameLength = view.getUint16(localOffset + 26, true);
        const localExtraLength = view.getUint16(localOffset + 28, true);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
        if (method === 0) {
            files.set(name, new Uint8Array(compressed));
        } else if (method === 8) {
            files.set(name, await inflateRaw(compressed));
        } else {
            throw new Error(`不支持的 ZIP 压缩方式（${method}）：${name}`);
        }
        cursor += 46 + nameLength + extraLength + commentLength;
    }
    return files;
}

// ---- 备份包组装／解析 ----

export function buildLyricsBackupZip(entries: ManualLyricsEntry[]): Uint8Array {
    const encoder = new TextEncoder();
    const files: ZipFileEntry[] = [];
    const manifestEntries = entries.map((entry, index) => {
        const file = `lyrics/${String(index + 1).padStart(4, '0')}.${isTtmlText(entry.text) ? 'ttml' : 'lrc'}`;
        files.push({ name: file, data: encoder.encode(entry.text) });
        return { key: entry.key, file, savedAt: entry.savedAt };
    });
    const manifest = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        entries: manifestEntries
    };
    files.unshift({ name: 'manifest.json', data: encoder.encode(JSON.stringify(manifest, null, 2)) });
    return buildZipBytes(files);
}

export async function parseLyricsBackupZip(bytes: Uint8Array): Promise<ManualLyricsEntry[]> {
    const files = await parseZipBytes(bytes);
    const manifestBytes = files.get('manifest.json');
    if (!manifestBytes) {
        throw new Error('备份包里没有 manifest.json，不是芷湘的歌词备份包');
    }
    let manifest: unknown;
    try {
        manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    } catch {
        throw new Error('备份包的 manifest.json 读不懂，整包拒绝');
    }
    const record = manifest as { format?: unknown; version?: unknown; entries?: unknown };
    if (record.format !== BACKUP_FORMAT || record.version !== BACKUP_VERSION) {
        throw new Error('备份包格式或版本不符，整包拒绝');
    }
    if (!Array.isArray(record.entries)) {
        throw new Error('备份包条目清单不完整，整包拒绝');
    }
    const decoder = new TextDecoder();
    const entries: ManualLyricsEntry[] = [];
    for (const raw of record.entries as Array<Record<string, unknown>>) {
        const key = typeof raw.key === 'string' ? raw.key : '';
        const file = typeof raw.file === 'string' ? raw.file : '';
        const savedAt = typeof raw.savedAt === 'number' ? raw.savedAt : 0;
        const data = file ? files.get(file) : undefined;
        if (!key || !data) {
            throw new Error('备份包有条目缺文件，整包拒绝');
        }
        const text = decoder.decode(data);
        if (text.trim().length === 0) {
            throw new Error('备份包有条目是空歌词，整包拒绝');
        }
        entries.push({ key, text, savedAt });
    }
    return entries;
}

// ---- 导出／恢复（存储与原生落盘的胶水） ----

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

// 导出全部手动贴词到下载目录，返回文件名与条数；没有贴词时抛中文原因。
export async function exportLyricsBackup(): Promise<{ filename: string; count: number }> {
    const entries = listManualLyrics();
    if (entries.length === 0) {
        throw new Error('还没有手动贴词，先给歌曲贴词再备份');
    }
    const bytes = buildLyricsBackupZip(entries);
    const now = new Date();
    const stamp =
        `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}` +
        `-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    const filename = `zhixiang-lyrics-backup-${stamp}.zip`;
    try {
        const result = await saveFileToDownloads(filename, bytesToBase64(bytes));
        return { filename: result.filename || filename, count: entries.length };
    } catch (error) {
        // 原生 reject 的 message 已是可展示的中文原因，原样上抛。
        throw error instanceof Error ? error : new Error('导出失败，请稍后再试');
    }
}

// 读入用户选的备份文件并校验，返回条目（先不落盘，覆盖与否等用户选）。
export async function readLyricsBackupFile(file: File): Promise<ManualLyricsEntry[]> {
    const buffer = await file.arrayBuffer();
    return parseLyricsBackupZip(new Uint8Array(buffer));
}

// 执行恢复：overwrite 覆盖同 key；keep 时同 key 跳过（保留已有）。
export function applyLyricsBackup(
    entries: ManualLyricsEntry[],
    mode: 'overwrite' | 'keep'
): { written: number; skipped: number } {
    let written = 0;
    let skipped = 0;
    for (const entry of entries) {
        if (mode === 'keep' && hasManualLyricsKey(entry.key)) {
            skipped += 1;
            continue;
        }
        setManualLyricsByKey(entry.key, entry.text, entry.savedAt);
        written += 1;
    }
    return { written, skipped };
}
