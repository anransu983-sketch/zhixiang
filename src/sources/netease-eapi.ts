// 网易云 eapi 请求（全新写）：官方 App 客户端走的那套加密与身份。
//
// 为什么不用 weapi（2026-10-25 实测教训）：weapi + 网页扫码 type=1
// 是一条“浏览器游客”路——浏览器 UA、无设备标识、无 App header，
// 服务端按非官方客户端判风控：扫码直接 8821，侥幸拿到的 key 约 20 秒
// 就过期（14:02 / 14:27 / 14:39 / 14:44 / 14:52 五次实测 19–27 秒），
// 切去网易云 App 再回来根本来不及。eapi + App 扫码 type=3 是官方
// App 自己的扫码路：App UA、稳定设备标识、header 块齐全，
// 服务端当正常客户端放行，key 寿命正常。
//
// 协议要点（按 Folia 桥已验通的行为重新实现，代码全新写）：
// - 请求发往 https://interface.music.163.com/eapi/<去 /api/ 前缀的路径>，
//   不发 music.163.com。
// - body 只有一项 params：AES-ECB 加密后的大写十六进制。明文格式：
//   `<uri>-36cd479b6b5-<JSON>-36cd479b6b5-<MD5>`，其中 MD5 是对
//   `nobody<uri>use<JSON>md5forencrypt` 取的摘要；JSON 里除业务参数
//   外必须带一个 header 块（设备标识等，见 buildEapiHeader）。
// - UA 是官方 App 的 `NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)`，
//   不是浏览器 UA；Cookie 头就是 header 块本身拼成的串。
// - 设备标识必须跨请求稳定、只生成一次：deviceId 每次随机换会被判
//   「设备环境异常」（8821）；NMTID 由服务端在第一个响应里下发，
//   之后每次请求都要带上。存 localStorage（键见下），localStorage
//   不可用时退回内存（沙箱测试也用这条路）。
// - AES-ECB 说明：WebCrypto 没有 ECB，只能用 AES-CBC 模拟——
//   对单个 16 字节块用零 IV 做 CBC 加密，输出的前 16 字节恰好就是
//   该块的 ECB 密文（CBC 第一块 = E(P XOR 0) = E(P)）。明文先按
//   PKCS#7 自己补齐，再逐块加密、拼起来。MD5 同样没有 WebCrypto，
//   这里按 RFC 1321 全新实现（K 表由 sin 定义现算，不抄表）。
// - 只给扫码登录用（unikey / client/login），其余接口不动。
// - 0.1.68 套 Folia 扫码：Folia 与芷湘的 eapi 请求逐项对过无差别
//   （同 key、同 UA、同 header 块、同 type:3），差在桥的 cookie
//   持久化与轮询节奏——本版按 Folia 补齐 cookie 回写（见下），
//   轮询改 2 秒（home.ts）。

import { httpPost, type HttpResponse } from '../native/http';

const EAPI_KEY_TEXT = 'e82ckenh8dichen8';
const EAPI_BASE = 'https://interface.music.163.com';
const EAPI_UA = 'NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)';
const DEVICE_STORAGE_KEY = 'zx_eapi_device_v1';

interface EapiDeviceState {
    deviceId: string;
    nuid: string;
    wnmcid: string;
    nmtid: string;
}

let memoryDevice: EapiDeviceState | null = null;

function randomChars(length: number, alphabet: string): string {
    let out = '';
    for (let index = 0; index < length; index += 1) {
        out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return out;
}

function loadDeviceState(): EapiDeviceState {
    if (memoryDevice) {
        return memoryDevice;
    }
    let stored: Partial<EapiDeviceState> | null = null;
    try {
        const raw = localStorage.getItem(DEVICE_STORAGE_KEY);
        stored = raw ? (JSON.parse(raw) as Partial<EapiDeviceState>) : null;
    } catch {
        stored = null;
    }
    const next: EapiDeviceState = {
        deviceId:
            typeof stored?.deviceId === 'string' && stored.deviceId
                ? stored.deviceId
                : randomChars(16, 'abcdefghijklmnopqrstuvwxyz0123456789'),
        nuid:
            typeof stored?.nuid === 'string' && stored.nuid
                ? stored.nuid
                : randomChars(32, '0123456789abcdef'),
        wnmcid:
            typeof stored?.wnmcid === 'string' && stored.wnmcid
                ? stored.wnmcid
                : `${randomChars(6, 'abcdefghijklmnopqrstuvwxyz')}.${Date.now()}.01.0`,
        nmtid: typeof stored?.nmtid === 'string' ? stored.nmtid : ''
    };
    memoryDevice = next;
    try {
        localStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify(next));
    } catch {
        // 存不下也不中断：内存里的这份本会话内照样稳定。
    }
    return next;
}

// Folia 桥同款 cookie 回写（0.1.68 套 Folia 扫码时补上）：Folia 的 eapi
// 请求会把服务端响应里 Set-Cookie 的会话值带回后续请求（它的桥有
// cookie 持久化，见 Folia eapi.js 的 EAPI_COOKIE_KEYS 与 NMTID 回写）。
// 芷湘桥不配 CookieJar，之前只回写 NMTID 一个值——且手机上响应里
// 从没出现过 NMTID，等于没回写。改成全量回写：每次 eapi 响应都把
// Set-Cookie 的名值对存下来（日志只记名不记值），下次请求时按
// Folia 的规则补进 header 块里缺失的项（已有生成值的不覆盖，设备
// 身份 deviceId/_ntes_nuid/WNMCID/_ntes_nnid 永远用本地生成的）。
const EAPI_COOKIE_KEYS = [
    'MUSIC_U',
    'MUSIC_A',
    '__csrf',
    'NMTID',
    'WNMCID',
    'WEVNSM',
    '_ntes_nuid',
    '_ntes_nnid',
    'MUSIC_R_U',
    'deviceId',
    'sDeviceId',
    'WM_TID',
    'WM_NI',
    'WM_NIKE'
];
const EAPI_COOKIE_STORAGE_KEY = 'zx_eapi_cookies_v1';

let memoryCookies: Record<string, string> | null = null;

function loadEapiCookies(): Record<string, string> {
    if (memoryCookies) {
        return memoryCookies;
    }
    let stored: Record<string, string> | null = null;
    try {
        const raw = localStorage.getItem(EAPI_COOKIE_STORAGE_KEY);
        stored = raw ? (JSON.parse(raw) as Record<string, string>) : null;
    } catch {
        stored = null;
    }
    memoryCookies = stored && typeof stored === 'object' ? stored : {};
    return memoryCookies;
}

function rememberEapiCookies(setCookies: string[] | undefined): void {
    if (!setCookies || setCookies.length === 0) {
        return;
    }
    const store = loadEapiCookies();
    let changed = false;
    const names: string[] = [];
    for (const entry of setCookies) {
        const pair = entry.split(';', 1)[0]?.trim();
        if (!pair) {
            continue;
        }
        const eq = pair.indexOf('=');
        if (eq <= 0) {
            continue;
        }
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (!name || !value) {
            continue;
        }
        names.push(name);
        if (store[name] !== value) {
            store[name] = value;
            changed = true;
        }
    }
    if (!changed) {
        return;
    }
    try {
        localStorage.setItem(EAPI_COOKIE_STORAGE_KEY, JSON.stringify(store));
    } catch {
        // 存不下也不中断：内存里的本会话内照样用。
    }
    // NMTID 同步进设备态：hasEapiNmtid 与 header 里的 NMTID 都认它。
    const nmtid = store.NMTID;
    if (nmtid) {
        const state = loadDeviceState();
        if (state.nmtid !== nmtid) {
            state.nmtid = nmtid;
            try {
                localStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify(state));
            } catch {
                // 忽略：内存里的已更新。
            }
        }
    }
    // 只记名不记值：下次再看不到 NMTID，就说明服务端确实没下发。
    console.log(`[Netease] eapi 回写：${[...new Set(names)].join(',')}`);
}

// ---- MD5（RFC 1321，输入按 UTF-8 编码，输出小写十六进制） ----

export function md5Hex(text: string): string {
    const bytes = new TextEncoder().encode(text);
    const bitLength = bytes.length * 8;
    // 总长 = (消息 + 0x80 + 8 字节长度) 向上取整到 64 的倍数。
    const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, bitLength & 0xffffffff, true);
    view.setUint32(padded.length - 4, Math.floor(bitLength / 0x100000000), true);

    // K[i] = floor(abs(sin(i + 1)) * 2^32)，现算不抄表。
    const k: number[] = [];
    for (let i = 0; i < 64; i += 1) {
        k.push(Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);
    }
    const shifts = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
    ];
    const rotateLeft = (value: number, bits: number): number =>
        ((value << bits) | (value >>> (32 - bits))) >>> 0;
    const add = (...values: number[]): number => {
        let sum = 0;
        for (const value of values) {
            sum = (sum + (value >>> 0)) >>> 0;
        }
        return sum >>> 0;
    };

    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;
    for (let offset = 0; offset < padded.length; offset += 64) {
        const words: number[] = [];
        for (let i = 0; i < 16; i += 1) {
            words.push(view.getUint32(offset + i * 4, true));
        }
        let a = a0;
        let b = b0;
        let c = c0;
        let d = d0;
        for (let i = 0; i < 64; i += 1) {
            let f: number;
            let g: number;
            if (i < 16) {
                f = (b & c) | (~b & d);
                g = i;
            } else if (i < 32) {
                f = (d & b) | (~d & c);
                g = (5 * i + 1) % 16;
            } else if (i < 48) {
                f = b ^ c ^ d;
                g = (3 * i + 5) % 16;
            } else {
                f = c ^ (b | ~d);
                g = (7 * i) % 16;
            }
            const temp = d;
            d = c;
            c = b;
            // 下标恒在范围内（i < 64，g < 16）：noUncheckedIndexedAccess 下用 ! 断言。
            b = add(b, rotateLeft(add(a, f, k[i]!, words[g]!), shifts[i]!));
            a = temp;
        }
        a0 = add(a0, a);
        b0 = add(b0, b);
        c0 = add(c0, c);
        d0 = add(d0, d);
    }
    const hexWord = (value: number): string => {
        let out = '';
        for (let i = 0; i < 4; i += 1) {
            out += ((value >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
        }
        return out;
    };
    return hexWord(a0) + hexWord(b0) + hexWord(c0) + hexWord(d0);
}

// ---- AES-ECB（WebCrypto CBC 单块模拟，见文件头注释） ----

let cachedKey: CryptoKey | null = null;

async function ecbKey(): Promise<CryptoKey> {
    if (cachedKey) {
        return cachedKey;
    }
    cachedKey = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(EAPI_KEY_TEXT),
        { name: 'AES-CBC' },
        false,
        ['encrypt']
    );
    return cachedKey;
}

async function ecbEncrypt(plain: Uint8Array): Promise<string> {
    const key = await ecbKey();
    const paddedLength = (Math.floor(plain.length / 16) + 1) * 16;
    const padded = new Uint8Array(paddedLength);
    padded.set(plain);
    const padValue = paddedLength - plain.length;
    padded.fill(padValue, plain.length);
    const zeroIv = new Uint8Array(16);
    const out = new Uint8Array(paddedLength);
    for (let offset = 0; offset < paddedLength; offset += 16) {
        const block = padded.slice(offset, offset + 16);
        const encrypted = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: zeroIv }, key, block);
        // CBC 单块输出 32 字节（明文块 + 填充块），前 16 字节即 ECB 密文。
        out.set(new Uint8Array(encrypted).slice(0, 16), offset);
    }
    return [...out].map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// 导出给沙箱测试：与 node:crypto 的参考实现逐字节比对，保证 shipped 代码本身正确。
export async function eapiEncrypt(uri: string, body: Record<string, unknown>): Promise<string> {
    const text = JSON.stringify(body);
    const digest = md5Hex(`nobody${uri}use${text}md5forencrypt`);
    const payload = `${uri}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
    return ecbEncrypt(new TextEncoder().encode(payload));
}

function buildEapiHeader(): Record<string, string> {
    const state = loadDeviceState();
    const now = Date.now();
    const header: Record<string, string> = {
        osver: '16.2',
        deviceId: state.deviceId,
        appver: '9.0.90',
        versioncode: '140',
        mobilename: '',
        buildver: String(now).slice(0, 10),
        resolution: '1920x1080',
        __csrf: '',
        os: 'iPhone OS',
        channel: 'distribution',
        requestId: `${now}_${String(Math.floor(Math.random() * 1000)).padStart(4, '0')}`,
        _ntes_nuid: state.nuid,
        _ntes_nnid: `${state.nuid},${now}`,
        WNMCID: state.wnmcid,
        WEVNSM: '1.0.0',
        __remember_me: 'true',
        ntes_kaola_ad: '1'
    };
    if (state.nmtid) {
        header.NMTID = state.nmtid;
    }
    // Folia 规则：只补缺失项，不覆盖已有值。设备身份四项已有生成值，
    // 不会被回写覆盖；NMTID/MUSIC_A/__csrf/sDeviceId 这类服务端下发的
    // 值在这里补进 header 块，随后 formatCookieHeader 也会把它带进
    // Cookie 头（与 Folia 的 header 即 Cookie 串同一做法）。
    const stored = loadEapiCookies();
    for (const key of EAPI_COOKIE_KEYS) {
        const value = stored[key];
        if (header[key] === undefined && value) {
            header[key] = value;
        }
    }
    return header;
}

function formatCookieHeader(header: Record<string, string>): string {
    return Object.entries(header)
        .filter(([, value]) => value !== '')
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('; ');
}

/** 短指纹（MD5 前 8 位）：日志里核对用，只认得出是否一致，看不出原始值。 */
export function shortHash(text: string): string {
    return md5Hex(text).slice(0, 8);
}

/**
 * 稳定身份指纹：deviceId|nuid|osver 三项（取码与轮询必须同一身份；
 * requestId/buildver 每次都变，不算身份）。取码与每次检查都记这个值，
 * 身份漂移（比如被全局 CookieHandler 换了头）时一眼能看出来。
 */
export function getEapiIdentityHash(): string {
    const state = loadDeviceState();
    return shortHash(`${state.deviceId}|${state.nuid}|16.2`);
}

/** 取码前设备是否已暖（NMTID 在不在）：只认有无，不返回值。 */
export function hasEapiNmtid(): boolean {
    return loadDeviceState().nmtid !== '';
}

/** 当前一次请求的完整 Cookie 串（回显测试用；每次调用 requestId/buildver 都会变，属正常）。 */
export function buildEapiCookieHeader(): string {
    return formatCookieHeader(buildEapiHeader());
}

/**
 * 发一次 eapi 请求。path 可带或不带 /api/ 前缀；data 为业务参数，
 * header 块由本模块补。返回与 httpPost 一致的 {status, body, setCookies}。
 */
export async function eapiRequest(path: string, data: Record<string, unknown>): Promise<HttpResponse> {
    const uri = path.startsWith('/api/') ? path : `/api/${path.replace(/^\//, '')}`;
    const apiPath = uri.slice(5);
    const header = buildEapiHeader();
    const params = await eapiEncrypt(uri, { ...data, header });
    // JS 层 25 秒兜底超时：OkHttp 连接 15 秒＋读取 20 秒可能叠到 35 秒
    // 才报失败，期间界面一直是“正在获取二维码…”。eapi 目前只给扫码
    // 登录用，超时只影响这条链路；底层的 httpPost 继续跑完、结果丢弃。
    let timer: number | undefined;
    try {
        const timeout = new Promise<never>((_, reject) => {
            timer = window.setTimeout(() => reject(new Error('eapi 请求超时')), 25000);
        });
        const response = await Promise.race([
            httpPost(
                `${EAPI_BASE}/eapi/${apiPath}`,
                `params=${encodeURIComponent(params)}`,
                {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': EAPI_UA,
                    Cookie: formatCookieHeader(header)
                }
            ),
            timeout
        ]);
        rememberEapiCookies(response.setCookies);
        return response;
    } finally {
        if (timer !== undefined) {
            window.clearTimeout(timer);
        }
    }
}
