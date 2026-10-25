// 外部打开的 TS 封装：调原生 ExternalOpen 插件发 ACTION_VIEW intent。
// 有应用接手返回 true；没应用可处理返回 false（不抛错）。

import { registerPlugin } from '@capacitor/core';

interface ExternalOpenPlugin {
    openUrl(options: { url: string }): Promise<{ handled: boolean }>;
}

const ExternalOpen = registerPlugin<ExternalOpenPlugin>('ExternalOpen');

export async function openExternalUrl(url: string): Promise<boolean> {
    try {
        const result = await ExternalOpen.openUrl({ url });
        return result.handled === true;
    } catch {
        return false;
    }
}
