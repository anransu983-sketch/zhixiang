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

async function request(
    method: string,
    url: string,
    headers?: Record<string, string>,
    body?: string
): Promise<HttpResponse> {
    try {
        return await HttpBridge.request({ url, method, headers, body });
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
