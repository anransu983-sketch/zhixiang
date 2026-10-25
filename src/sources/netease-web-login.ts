// 网易云网页登录（全新写，与 YTM 原生登录同款）：原生单独 Activity 里的
// WebView 打开 music.163.com，用户在官网真的登录一次，Activity 读到 MUSIC_U
// 后把整条 Cookie 交回来。本模块只做插件桥接与凭证校验，会话的保存与界面
// 刷新由调用方（首页登录区）做，与扫码路共用同一套会话存储。
//
// 定位：扫码登录的备用路（扫码被拒或扫码流程走不通时用）；登录判定同样只认 MUSIC_U。
// 网页版在手机 WebView 里体验一般（桌面站会闪屏、入口难找），故只作备用，不主推。

import { Capacitor, registerPlugin } from '@capacitor/core';
import { hasMusicU } from './netease-session';

export type NeteaseWebSignInResult =
    | { ok: true; cookie: string }
    | { ok: false; cancelled: boolean; message?: string };

interface NeteaseSignInPlugin {
    signIn(): Promise<{ ok?: unknown; cookie?: unknown }>;
}

const NeteaseSignIn = registerPlugin<NeteaseSignInPlugin>('NeteaseSignIn');

export function isNeteaseSignInAvailable(): boolean {
    return Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('NeteaseSignIn');
}

export async function signInNeteaseWeb(): Promise<NeteaseWebSignInResult> {
    if (!isNeteaseSignInAvailable()) {
        return { ok: false, cancelled: false, message: '当前设备不支持网页登录' };
    }
    try {
        const result = await NeteaseSignIn.signIn();
        const cookie = typeof result?.cookie === 'string' ? result.cookie : '';
        if (!result || result.ok !== true || !cookie || !hasMusicU(cookie)) {
            // 取消、无凭证、无 MUSIC_U 都按取消处理，不当成网络失败。
            return { ok: false, cancelled: true };
        }
        return { ok: true, cookie };
    } catch (error) {
        return {
            ok: false,
            cancelled: false,
            message: error instanceof Error ? error.message : '网易云网页登录失败'
        };
    }
}
