// 应用内更新的检查逻辑：问 GitHub 公开仓库的最新 Release，
// 与本机版本（APP_VERSION）比较，有新版就把 APK 直链与更新说明带回来。
// 公开仓库不需要任何令牌；检查失败抛带中文原因的 Error，调用方原样展示。
//
// 版本比较：tag 去掉前缀 v 后按点分三段逐段比数值；解析不出数字
// （如 tag 不是版本号）时一律按「无更新」处理，不误报不催更。
// 日志只记版本号，不记完整下载地址（凭证类与长地址都不进日志的老规矩）。

import { httpGet } from './native/http';
import { APP_VERSION } from './version';

const LATEST_RELEASE_URL =
    'https://api.github.com/repos/anransu983-sketch/zhixiang/releases/latest';

export interface UpdateCheckResult {
    hasUpdate: boolean;
    latestVersion: string;
    currentVersion: string;
    // Release 说明摘要（纯文本，截断到 600 字）；无更新或没写说明时为空串。
    notes: string;
    // 第一个 .apk 资产的直链；无更新或 Release 里没有 APK 时为空串。
    apkUrl: string;
    // APK 字节数，未知时为 0。
    size: number;
    // hasUpdate 为 false 时区分原因：已是最新 / Release 里没有 APK。
    reason: 'latest' | 'no-apk' | 'update';
}

function parseVersion(text: string): [number, number, number] | null {
    const parts = text.trim().split('.');
    if (parts.length === 0 || parts.length > 3) {
        return null;
    }
    const nums: number[] = [];
    for (const part of parts) {
        if (!/^\d+$/.test(part)) {
            return null;
        }
        nums.push(Number(part));
    }
    while (nums.length < 3) {
        nums.push(0);
    }
    return [nums[0]!, nums[1]!, nums[2]!];
}

/** 三段数值比较：latest 比 current 新才算有更新；任一侧解析失败按无更新。 */
export function isNewerVersion(latest: string, current: string): boolean {
    const a = parseVersion(latest);
    const b = parseVersion(current);
    if (!a || !b) {
        return false;
    }
    for (let i = 0; i < 3; i++) {
        if (a[i]! > b[i]!) {
            return true;
        }
        if (a[i]! < b[i]!) {
            return false;
        }
    }
    return false;
}

interface ReleaseAsset {
    name?: unknown;
    browser_download_url?: unknown;
    size?: unknown;
}

interface ReleasePayload {
    tag_name?: unknown;
    body?: unknown;
    assets?: unknown;
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
    let response;
    try {
        response = await httpGet(LATEST_RELEASE_URL, {
            Accept: 'application/vnd.github+json',
        });
    } catch (error) {
        const reason = error instanceof Error ? error.message : '';
        throw new Error(reason || '检查更新失败，请检查网络后重试');
    }
    if (response.status !== 200) {
        throw new Error(`检查更新失败，服务器返回 ${response.status}，请稍后重试`);
    }
    let payload: ReleasePayload;
    try {
        payload = JSON.parse(response.body) as ReleasePayload;
    } catch {
        throw new Error('检查更新失败，服务器返回的内容无法解析');
    }
    const tag = typeof payload.tag_name === 'string' ? payload.tag_name : '';
    const latestVersion = tag.replace(/^v/i, '').trim();
    if (!latestVersion) {
        throw new Error('检查更新失败，服务器没有返回版本号');
    }
    const base: UpdateCheckResult = {
        hasUpdate: false,
        latestVersion,
        currentVersion: APP_VERSION,
        notes: '',
        apkUrl: '',
        size: 0,
        reason: 'latest',
    };
    if (!isNewerVersion(latestVersion, APP_VERSION)) {
        console.log(`[Update] 已是最新版本 v${APP_VERSION}`);
        return base;
    }
    const assets = Array.isArray(payload.assets) ? (payload.assets as ReleaseAsset[]) : [];
    const apk = assets.find(
        (asset) =>
            typeof asset.name === 'string' &&
            asset.name.toLowerCase().endsWith('.apk') &&
            typeof asset.browser_download_url === 'string',
    );
    if (!apk) {
        console.log(`[Update] 发现新版 v${latestVersion}，但该 Release 里没有 APK`);
        return { ...base, reason: 'no-apk' };
    }
    const notes = typeof payload.body === 'string' ? payload.body.trim().slice(0, 600) : '';
    const size = typeof apk.size === 'number' && apk.size > 0 ? apk.size : 0;
    console.log(`[Update] 发现新版 v${latestVersion}（当前 v${APP_VERSION}）`);
    return {
        ...base,
        hasUpdate: true,
        notes,
        apkUrl: apk.browser_download_url as string,
        size,
        reason: 'update',
    };
}
