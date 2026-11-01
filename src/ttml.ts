// TTML 歌词解析（0.1.131，全新写）：手动贴词／导入的 TTML 歌词转
// LyricLine[]，格式口径参考 AM++ 的 Apple Music TTML 文档避雷。
//
// 为什么不用 DOMParser：手写一个只够 TTML 用的最小 XML 解析器（元素／
// 属性／文本／CDATA／注释／处理指令／实体），一是 WebView 的 DOMParser
// 对命名空间前缀（ttm:role、itunes:key 这类带冒号属性）的行为要逐个
// 试，二是纯字符串解析在 node 里能直接跑自检。TTML 都是机器生成的
// 良构文档，这个子集够用；结构不配平时抛错，调用方回落 LRC 路径。
//
// 格式口径：
// - body/div 下的 <p begin end itunes:key ttm:agent> 是行，agent 只区分
//   声部编号（独唱 v1／合唱 v1000），都当正常行收，不做声部过滤；
// - 行内 <span begin end> 是逐字词；<span ttm:role="x-bg"> 包裹的是和声
//   组，组内词标 bg；
// - 和声里的纯括号 token 不单独成词（AM++ 实测坑：括号 token 会把逐字
//   高亮带偏）——并入相邻词，没有相邻词就丢弃；
// - 译文轨在 head/metadata 的 translations 里：优先 type=subtitle 且
//   xml:lang 以 zh 开头的轨，其次任意 zh 轨、任意 subtitle 轨；
//   <text for="L 行key"> 按 itunes:key 挂到正文行 translation，
//   与正文相同或为空不挂（与 tlyric 合并同一口径）；
// - 时间格式全支持：MM:SS.mmm、HH:MM:SS.mmm、"12.34s"、"1234ms"、
//   纯秒数（另顺手收 h/m 偏移单位）；
// - 解析完成后与 YRC 共用末词补偿（三条逐字来源同一口径）。

import { compensateLastWordDurations } from './lyrics';
import type { LyricLine, LyricWord } from './lyrics';

// 贴词原文是不是 TTML：去前导空白后以 < 开头且含 <tt（根元素）。
export function isTtmlText(text: string): boolean {
    const trimmed = text.trimStart();
    return trimmed.startsWith('<') && trimmed.includes('<tt');
}

// ---- 最小 XML 解析（只支持良构文档的子集，见文件头） ----

interface XmlNode {
    // 小写 local 名（去掉命名空间前缀），匹配时不被前缀差异绊住。
    tag: string;
    // 属性名原样保留（ttm:role、xml:lang、itunes:key 都带前缀）。
    attrs: Record<string, string>;
    children: XmlNode[];
    // 直接子文本段拼接（已解实体）；与子元素的先后交错不还原——
    // 逐字词各自带文本、行文本从词拼，这个粒度够用。
    text: string;
}

function localName(rawName: string): string {
    const colon = rawName.lastIndexOf(':');
    return (colon >= 0 ? rawName.slice(colon + 1) : rawName).toLowerCase();
}

function decodeEntities(text: string): string {
    return text.replace(/&(#x?[0-9a-fA-F]+|lt|gt|amp|quot|apos);/g, (_whole, body: string) => {
        switch (body) {
            case 'lt':
                return '<';
            case 'gt':
                return '>';
            case 'amp':
                return '&';
            case 'quot':
                return '"';
            case 'apos':
                return "'";
            default: {
                const code = body.startsWith('#x')
                    ? parseInt(body.slice(2), 16)
                    : parseInt(body.slice(1), 10);
                return Number.isFinite(code) && code >= 0 ? String.fromCodePoint(code) : _whole;
            }
        }
    });
}

function parseXml(source: string): XmlNode {
    let pos = 0;
    const len = source.length;
    const fail = (message: string): Error => new Error(`TTML 解析失败：${message}`);

    const skipWhitespace = (): void => {
        while (pos < len && /\s/.test(source[pos] ?? '')) {
            pos += 1;
        }
    };

    // 处理指令／注释／DOCTYPE 这类不产出节点的结构，整段跳过。
    const skipMisc = (): void => {
        for (;;) {
            skipWhitespace();
            if (source.startsWith('<?', pos)) {
                const end = source.indexOf('?>', pos + 2);
                if (end < 0) {
                    throw fail('处理指令未闭合');
                }
                pos = end + 2;
                continue;
            }
            if (source.startsWith('<!--', pos)) {
                const end = source.indexOf('-->', pos + 4);
                if (end < 0) {
                    throw fail('注释未闭合');
                }
                pos = end + 3;
                continue;
            }
            if (source.startsWith('<!', pos) && !source.startsWith('<![CDATA[', pos)) {
                const end = source.indexOf('>', pos + 2);
                if (end < 0) {
                    throw fail('文档声明未闭合');
                }
                pos = end + 1;
                continue;
            }
            return;
        }
    };

    const parseElement = (): XmlNode => {
        // 调用时 source[pos] === '<' 且不是闭合/声明。
        pos += 1;
        const nameMatch = /^[A-Za-z_][\w:.-]*/.exec(source.slice(pos));
        if (!nameMatch) {
            throw fail('标签名不合法');
        }
        const rawName = nameMatch[0];
        pos += rawName.length;
        const attrs: Record<string, string> = {};
        for (;;) {
            skipWhitespace();
            if (source.startsWith('/>', pos)) {
                pos += 2;
                return { tag: localName(rawName), attrs, children: [], text: '' };
            }
            if (source[pos] === '>') {
                pos += 1;
                break;
            }
            const attrMatch = /^[A-Za-z_][\w:.-]*/.exec(source.slice(pos));
            if (!attrMatch) {
                throw fail('属性名不合法');
            }
            const attrName = attrMatch[0];
            pos += attrName.length;
            skipWhitespace();
            let attrValue = '';
            if (source[pos] === '=') {
                pos += 1;
                skipWhitespace();
                const quote = source[pos];
                if (quote !== '"' && quote !== "'") {
                    throw fail('属性值缺少引号');
                }
                const end = source.indexOf(quote, pos + 1);
                if (end < 0) {
                    throw fail('属性值未闭合');
                }
                attrValue = decodeEntities(source.slice(pos + 1, end));
                pos = end + 1;
            }
            attrs[attrName] = attrValue;
        }
        const node: XmlNode = { tag: localName(rawName), attrs, children: [], text: '' };
        for (;;) {
            if (pos >= len) {
                throw fail(`<${rawName}> 未闭合`);
            }
            if (source.startsWith('</', pos)) {
                const end = source.indexOf('>', pos + 2);
                if (end < 0) {
                    throw fail('闭合标签不完整');
                }
                const closeName = source.slice(pos + 2, end).trim();
                if (closeName !== rawName) {
                    throw fail(`标签不配平：<${rawName}> 对 </${closeName}>`);
                }
                pos = end + 1;
                return node;
            }
            if (source.startsWith('<![CDATA[', pos)) {
                const end = source.indexOf(']]>', pos + 9);
                if (end < 0) {
                    throw fail('CDATA 未闭合');
                }
                node.text += source.slice(pos + 9, end);
                pos = end + 3;
                continue;
            }
            if (
                source.startsWith('<!--', pos) ||
                source.startsWith('<?', pos) ||
                source.startsWith('<!', pos)
            ) {
                skipMisc();
                continue;
            }
            if (source[pos] === '<') {
                node.children.push(parseElement());
                continue;
            }
            const next = source.indexOf('<', pos);
            const chunk = next < 0 ? source.slice(pos) : source.slice(pos, next);
            node.text += decodeEntities(chunk);
            pos = next < 0 ? len : next;
        }
    };

    skipMisc();
    if (source[pos] !== '<') {
        throw fail('根元素缺失');
    }
    return parseElement();
}

function textContent(node: XmlNode): string {
    let out = node.text;
    for (const child of node.children) {
        out += textContent(child);
    }
    return out;
}

function findAll(node: XmlNode, tag: string, out: XmlNode[]): void {
    if (node.tag === tag) {
        out.push(node);
    }
    for (const child of node.children) {
        findAll(child, tag, out);
    }
}

function firstDescendant(node: XmlNode, tag: string): XmlNode | null {
    if (node.tag === tag) {
        return node;
    }
    for (const child of node.children) {
        const hit = firstDescendant(child, tag);
        if (hit) {
            return hit;
        }
    }
    return null;
}

// ---- 时间解析 ----

// TTML 时间 → 毫秒。支持时钟格式（MM:SS.mmm／HH:MM:SS.mmm）、
// 偏移格式（12.34s／1234ms，顺手收 h/m）与纯秒数；认不出回 null。
export function parseTtmlTime(value: string | undefined): number | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    const offset = /^(\d+(?:\.\d+)?)(h|m|s|ms)$/.exec(trimmed);
    if (offset) {
        const amount = Number(offset[1]);
        const unit = offset[2];
        const factor = unit === 'h' ? 3600000 : unit === 'm' ? 60000 : unit === 's' ? 1000 : 1;
        return Math.round(amount * factor);
    }
    if (trimmed.includes(':')) {
        const parts = trimmed.split(':');
        if (parts.length !== 2 && parts.length !== 3) {
            return null;
        }
        const last = parts[parts.length - 1] ?? '';
        const dot = last.indexOf('.');
        const secondsText = dot >= 0 ? last.slice(0, dot) : last;
        const fraction = dot >= 0 ? last.slice(dot + 1) : '';
        const heads = parts.slice(0, -1);
        if (!/^\d+$/.test(secondsText) || heads.some((part) => !/^\d+$/.test(part))) {
            return null;
        }
        if (fraction && !/^\d+$/.test(fraction)) {
            return null;
        }
        const millis = fraction ? Number(fraction.padEnd(3, '0').slice(0, 3)) : 0;
        let totalSeconds = Number(secondsText) + millis / 1000;
        // 冒号段从右往左是 秒←分←时。
        let multiplier = 60;
        for (let i = heads.length - 1; i >= 0; i--) {
            totalSeconds += Number(heads[i]) * multiplier;
            multiplier *= 60;
        }
        return Math.round(totalSeconds * 1000);
    }
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
        return Math.round(Number(trimmed) * 1000);
    }
    return null;
}

// ---- 词收集 ----

interface RawWord {
    text: string;
    startMs: number;
    endMs: number;
    bg: boolean;
}

const BRACKET_ONLY = /^[\s()（）[\]［］{}｛｝]+$/;

// 从一个容器元素里收逐字词：带 begin/end 的 span 是词；无时间的 span
// 当包装层下钻（bg 标记继承）；ttm:role="x-bg" 的 span 是和声组。
function collectWords(container: XmlNode, bg: boolean, out: RawWord[]): void {
    for (const child of container.children) {
        if (child.tag !== 'span') {
            continue;
        }
        if (child.attrs['ttm:role'] === 'x-bg') {
            collectBgGroup(child, out);
            continue;
        }
        const begin = parseTtmlTime(child.attrs['begin']);
        const end = parseTtmlTime(child.attrs['end']);
        if (begin !== null && end !== null) {
            out.push({ text: textContent(child), startMs: begin, endMs: end, bg });
        } else {
            collectWords(child, bg, out);
        }
    }
}

// 和声组：组内词标 bg。直接挂在组上的散文本（不在子 span 里）若是纯
// 括号直接丢（AM++ 实测：和声里的括号显示与高亮都不可靠，浅色本身
// 就是区分）；是正文则并进组内最后一个词尾，没词可并且组带时间时
// 自成一词。纯括号 token 的并入在整行收完后统一折叠（foldBracketWords）。
function collectBgGroup(group: XmlNode, out: RawWord[]): void {
    const before = out.length;
    collectWords(group, true, out);
    const direct = group.text.trim();
    if (!direct) {
        return;
    }
    if (BRACKET_ONLY.test(direct)) {
        return;
    }
    const last = out[out.length - 1];
    if (out.length > before && last) {
        last.text += direct;
        return;
    }
    const begin = parseTtmlTime(group.attrs['begin']);
    const end = parseTtmlTime(group.attrs['end']);
    if (begin !== null && end !== null) {
        out.push({ text: direct, startMs: begin, endMs: end, bg: true });
    }
}

// 和声纯括号 token 折叠：并入前一个词（文本追加、结束时间跟着延），
// 前面没词时并入后一个词（文本前插），整行只有它时丢弃。它自己不再
// 单独成词，免得逐字高亮被一个括号卡住（AM++ 实测坑）。
function foldBracketWords(words: RawWord[]): RawWord[] {
    const kept: RawWord[] = [];
    let pendingPrefix = '';
    for (const word of words) {
        if (word.bg && BRACKET_ONLY.test(word.text)) {
            const prev = kept[kept.length - 1];
            if (prev) {
                prev.text += word.text;
                prev.endMs = Math.max(prev.endMs, word.endMs);
            } else {
                pendingPrefix += word.text;
            }
            continue;
        }
        if (pendingPrefix) {
            word.text = pendingPrefix + word.text;
            pendingPrefix = '';
        }
        kept.push(word);
    }
    return kept;
}

// ---- 译文轨 ----

// 选轨优先级：zh 的 subtitle > 任意 zh > 任意 subtitle > 第一条带
// <text> 的。replacement 轨（简繁转换类）不在首选——它与正文多半只差
// 字形，按 key 挂时会被「与正文相同不挂」挡掉大半，剩下的也不算译文。
function collectTranslations(root: XmlNode): Map<string, string> {
    const tracks: XmlNode[] = [];
    findAll(root, 'translation', tracks);
    const usable = tracks.filter((track) =>
        track.children.some((child) => child.tag === 'text')
    );
    const score = (track: XmlNode): number => {
        const lang = (track.attrs['xml:lang'] ?? '').toLowerCase();
        const type = (track.attrs['type'] ?? '').toLowerCase();
        let value = 0;
        if (lang.startsWith('zh')) {
            value += 2;
        }
        if (type === 'subtitle') {
            value += 1;
        }
        return value;
    };
    const chosen = usable.sort((a, b) => score(b) - score(a))[0];
    const map = new Map<string, string>();
    if (!chosen) {
        return map;
    }
    for (const child of chosen.children) {
        if (child.tag !== 'text') {
            continue;
        }
        const key = child.attrs['for'];
        const text = textContent(child).trim();
        if (key && text) {
            map.set(key, text);
        }
    }
    return map;
}

// ---- 主解析 ----

function collectParagraphs(container: XmlNode, out: XmlNode[]): void {
    for (const child of container.children) {
        if (child.tag === 'p') {
            out.push(child);
        } else if (child.tag === 'div') {
            collectParagraphs(child, out);
        }
    }
}

export function parseTtml(text: string): LyricLine[] {
    const root = parseXml(text);
    const body = firstDescendant(root, 'body') ?? root;
    const translations = collectTranslations(root);
    const paragraphs: XmlNode[] = [];
    collectParagraphs(body, paragraphs);
    const lines: LyricLine[] = [];
    for (const p of paragraphs) {
        const begin = parseTtmlTime(p.attrs['begin']);
        if (begin === null) {
            // 没有起始时间的行没法挂到时间轴上，跳过不猜。
            continue;
        }
        const rawWords: RawWord[] = [];
        collectWords(p, false, rawWords);
        rawWords.sort((a, b) => a.startMs - b.startMs);
        const folded = foldBracketWords(rawWords).filter((word) => word.text !== '');
        const words: LyricWord[] = folded.map((word) => {
            const lyricWord: LyricWord = {
                text: word.text,
                startMs: word.startMs,
                durationMs: Math.max(0, word.endMs - word.startMs)
            };
            if (word.bg) {
                lyricWord.bg = true;
            }
            return lyricWord;
        });
        const lineText =
            words.length > 0
                ? words.map((word) => word.text).join('').trim()
                : textContent(p).trim();
        if (!lineText && words.length === 0) {
            continue;
        }
        const line: LyricLine = { timeMs: begin, text: lineText };
        if (words.length > 0) {
            line.words = words;
        }
        const key = p.attrs['itunes:key'];
        const translation = key ? translations.get(key) : undefined;
        if (translation && translation !== lineText) {
            line.translation = translation;
        }
        lines.push(line);
    }
    lines.sort((a, b) => a.timeMs - b.timeMs);
    compensateLastWordDurations(lines);
    return lines;
}
