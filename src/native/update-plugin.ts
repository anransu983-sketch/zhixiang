// 应用内更新的原生插件封装：与 UpdatePlugin.java 对应。
// Web 层只经这层调原生：下载 APK（带进度回调）、调起系统安装器、
// 打开「安装未知应用」设置页。
//
// 约定：
// - 原生侧 reject 一律带中文 message 与 code；这里原样往上抛，
//   需要区分原因的调用方读 error.code（如 NEED_INSTALL_PERMISSION）。
// - 下载进度经 progress 事件回传，downloadUpdateApk 负责订阅与退订，
//   调用方只给一个普通回调，不用管监听句柄。

import { registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

export interface UpdateProgress {
    loaded: number;
    total: number;
    // total 未知（服务器没给长度）时为 -1，此时只展示已下载大小。
    percent: number;
}

interface UpdatePlugin {
    download(options: { url: string; version: string }): Promise<{ path: string; size: number }>;
    install(options: { path: string }): Promise<{ launched: boolean }>;
    openInstallSettings(): Promise<{ opened: boolean }>;
    addListener(
        eventName: 'progress',
        listener: (event: UpdateProgress) => void,
    ): Promise<PluginListenerHandle>;
}

const Update = registerPlugin<UpdatePlugin>('Update');

export async function downloadUpdateApk(
    url: string,
    version: string,
    onProgress?: (progress: UpdateProgress) => void,
): Promise<{ path: string; size: number }> {
    let handle: PluginListenerHandle | undefined;
    if (onProgress) {
        handle = await Update.addListener('progress', onProgress);
    }
    try {
        return await Update.download({ url, version });
    } finally {
        if (handle) {
            await handle.remove();
        }
    }
}

export async function installUpdateApk(path: string): Promise<void> {
    await Update.install({ path });
}

export async function openInstallPermissionSettings(): Promise<void> {
    await Update.openInstallSettings();
}
