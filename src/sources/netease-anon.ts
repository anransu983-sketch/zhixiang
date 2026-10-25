// 网易云游客会话暖机（全新写）：取码前把设备从“冷”变“暖”。
//
// 对 Folia 扫码流程逐行比对后剩下的唯一结构差别：Folia 的设备是暖的——
// 它在日常使用里早就跑过 eapi 请求，NMTID 早已下发并存着，取码那下
// 本来就带着 NMTID；而芷湘是冷启动，第一次取码根本不带 NMTID。
// 服务端很可能在发 key 当时就按设备是否已知定寿命：冷设备给短命 key，
// 暖设备给正常 key。沙箱原型先验加密又跑过多次调用（暖的）才测出
// 170 秒，与此一致；手机每次首码都是冷的，约 20 秒就死。
//
// 暖机办法（按游客注册的接口行为重新实现）：调 eapi 的游客注册，
// 拿到游客 cookie 即算暖；即便注册本身被拒，只要响应里下了 NMTID，
// eapiRequest 里的 rememberNmtid 也会把它存下来，取码就不再是冷的。
// 只记“在/缺失”，不记任何 cookie 值。
//
// 注意：Folia 的 Create 那步并不走网络（只是拼二维码图片地址），已排除，
// 不是差别；Folia 扫码本身也不带 MUSIC_A/__csrf（它传空 cookie），
// 所以暖机只求 NMTID 落袋，不改取码的头。

import { eapiRequest, hasEapiNmtid, md5Hex } from './netease-eapi';

const ANON_DEVICE_KEY = 'zx_anon_device_id';
const ID_XOR_KEY = '3go8&$8*3*3h0k(2)2';

let memoryAnonDevice = '';
let warmUpAttempted = false;

function randomHex(length: number): string {
    const alphabet = '0123456789ABCDEF';
    let out = '';
    for (let index = 0; index < length; index += 1) {
        out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return out;
}

function loadAnonDeviceId(): string {
    if (memoryAnonDevice) {
        return memoryAnonDevice;
    }
    let stored = '';
    try {
        stored = localStorage.getItem(ANON_DEVICE_KEY) || '';
    } catch {
        stored = '';
    }
    if (!stored) {
        stored = randomHex(52);
        try {
            localStorage.setItem(ANON_DEVICE_KEY, stored);
        } catch {
            // 存不下也不中断：内存里的这份本会话内照样稳定。
        }
    }
    memoryAnonDevice = stored;
    return stored;
}

function base64OfText(text: string): string {
    return btoa(text);
}

function base64OfMd5Hex(hex: string): string {
    let binary = '';
    for (let index = 0; index < hex.length; index += 2) {
        binary += String.fromCharCode(parseInt(hex.slice(index, index + 2), 16));
    }
    return btoa(binary);
}

/** 设备 id 异或 → MD5 → Base64（上游游客注册的推导，字符集只含 ASCII）。 */
function encodeAnonId(deviceId: string): string {
    let xored = '';
    for (let index = 0; index < deviceId.length; index += 1) {
        xored += String.fromCharCode(
            deviceId.charCodeAt(index) ^ ID_XOR_KEY.charCodeAt(index % ID_XOR_KEY.length)
        );
    }
    return base64OfMd5Hex(md5Hex(xored));
}

function cookieHas(setCookies: string[] | undefined, name: string): boolean {
    if (!setCookies) {
        return false;
    }
    return setCookies.some((entry) => entry.split(';', 1)[0]?.trim().startsWith(`${name}=`));
}

/**
 * 取码前暖机（每会话最多跑一次）：设备已暖就跳过；冷设备则做一次
 * 游客注册，成败都只记一行、都不拦取码——取码照常进行。
 */
export async function warmUpForQr(): Promise<void> {
    if (warmUpAttempted) {
        return;
    }
    warmUpAttempted = true;
    if (hasEapiNmtid()) {
        console.log('[Netease] 取码前 NMTID 已在，跳过暖机');
        return;
    }
    console.log('[Netease] 取码前设备是冷的（无 NMTID），先做游客注册暖机');
    try {
        const deviceId = loadAnonDeviceId();
        const username = base64OfText(`${deviceId} ${encodeAnonId(deviceId)}`);
        const response = await eapiRequest('/api/register/anonimous', { username });
        let code = 0;
        try {
            code = Number((JSON.parse(response.body) as { code?: unknown }).code) || 0;
        } catch {
            code = 0;
        }
        const hasMusicA = cookieHas(response.setCookies, 'MUSIC_A');
        const hasCsrf = cookieHas(response.setCookies, '__csrf');
        const ok = code === 200 && (hasMusicA || hasCsrf);
        console.log(
            `[Netease] 游客注册：${ok ? '成功' : '失败'}（MUSIC_A ${hasMusicA ? '在' : '缺失'}，` +
            `__csrf ${hasCsrf ? '在' : '缺失'}，NMTID ${hasEapiNmtid() ? '在' : '缺失'}）`
        );
    } catch {
        console.log(
            `[Netease] 游客注册：失败（MUSIC_A 缺失，__csrf 缺失，` +
            `NMTID ${hasEapiNmtid() ? '在' : '缺失'}）`
        );
    }
}
