// 通用原生 HTTP 桥的 TS 封装：后续音源（网易云、YTM）共用。
// WebView 里直接 fetch 跨域接口会被 CORS 拦，所以一律走原生 HttpBridge 插件。
//
// 约定（与 HttpBridgePlugin.java 一致）：
// - 只要服务器回了 HTTP 响应，get/post 就返回 {status, body}，不按 status 抛错，
//   由调用方按 status 与响应体判断成败（fetch 风格）。
// - 只有没拿到 HTTP 响应时才抛错，且一定是带中文提示的 Error，
//   原生侧的 code 拼在消息后，方便调用方原样展示或排查。

import { registerPlugin } from '@capacitor/core';

export interface HttpResponse {
    status: number;
    body: string;
    // 原生侧回传的 Set-Cookie（登录流程拿凭证的兜底）；普通请求不用理会。
    setCookies?: string[];
    // 原生侧换行拼的 Set-Cookie 全量：优先用它，避开 "[a, b]" 按 ", " 切
    // 会误切 Expires 日期的问题。
    setCookiesJoined?: string;
    // 网络实情（原生侧回传）：协议、TLS 版本/套件、收发头名；只含名不含值。
    networkProtocol?: string;
    tlsVersion?: string;
    tlsCipher?: string;
    requestHeaderNames?: string[];
    responseHeaderNames?: string[];
}

interface HttpBridgePlugin {
    request(options: {
        url: string;
        method?: string;
        headers?: Record<string, string>;
        body?: string;
    }): Promise<HttpResponse>;
}

const HttpBridge = registerPlugin<HttpBridgePlugin>('HttpBridge');

export async function httpGet(url: string, headers?: Record<string, string>): Promise<HttpResponse> {
    return request('GET', url, headers);
}

export async function httpPost(
    url: string,
    body?: string,
    headers?: Record<string, string>
): Promise<HttpResponse> {
    return request('POST', url, headers, body);
}

// Capacitor 把原生 ArrayList 到 JS 时不一定是数组：YTM 头名在 0.1.67
// 已实测到字符串形式的 "[a, b]"，.join 直接抛错。Set-Cookie 同理——
// 原生侧明明用 headers().values("Set-Cookie") 全量回传（不是 Map，不会
// 压成一条），到 JS 若还是字符串，cookieFromSetCookies 逐字符拆就全错。
// 这里统一归一化：数组原样，字符串按 Java List 的 "[a, b]" 格式拆，
// 拆出来的 Expires 日期碎片（无 = 号）由下游解析时过滤，不会丢 MUSIC_U。
function normalizeStringArray(value: unknown): string[] | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (Array.isArray(value)) {
        return value.filter((item) => typeof item === 'string');
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) {
            return [];
        }
        const inner = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
        if (!inner.trim()) {
            return [];
        }
        return inner.split(', ');
    }
    return undefined;
}

async function request(
    method: string,
    url: string,
    headers?: Record<string, string>,
    body?: string
): Promise<HttpResponse> {
    try {
        const response = await HttpBridge.request({ url, method, headers, body });
        // setCookiesJoined 优先：每行一条完整 Set-Cookie，Expires 里的逗号
        // 不会被误切；老字段只作兜底（仍按 "[a, b]" 格式归一化）。
        if (typeof response.setCookiesJoined === 'string' && response.setCookiesJoined) {
            response.setCookies = response.setCookiesJoined.split('\n').filter(Boolean);
        } else {
            response.setCookies = normalizeStringArray(response.setCookies);
        }
        response.requestHeaderNames = normalizeStringArray(response.requestHeaderNames);
        response.responseHeaderNames = normalizeStringArray(response.responseHeaderNames);
        return response;
    } catch (error) {
        // 不抛裸错：原生侧 reject 一律带中文 message 与 code，这里拼成一句中文。
        const message = error instanceof Error ? error.message : '';
        const code = (error as { code?: unknown } | null)?.code;
        if (message && /[\u4e00-\u9fff]/.test(message)) {
            throw new Error(typeof code === 'string' && code ? `${message}（${code}）` : message);
        }
        throw new Error('网络请求失败，请检查网络后重试');
    }
}
