// 脱机模式（借鉴 NeriPlayer 脱机体验）：用 navigator.onLine 与
// online/offline 事件维护状态。脱机时远程区不发请求、不转圈不
// 报错，本地歌/歌单/足迹照常可用；恢复在线时通知各区刷新。
let offline = typeof navigator !== 'undefined' && navigator.onLine === false;
const listeners = new Set<(offline: boolean) => void>();
let initialized = false;

export function isOffline(): boolean {
    return offline;
}

export function onOfflineChange(listener: (offline: boolean) => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function initOfflineTracking(): void {
    if (initialized) {
        return;
    }
    initialized = true;
    const apply = (next: boolean): void => {
        if (next === offline) {
            return;
        }
        offline = next;
        console.log(`[Offline] ${offline ? '进入脱机模式' : '恢复在线'}`);
        for (const listener of listeners) {
            listener(offline);
        }
    };
    window.addEventListener('offline', () => apply(true));
    window.addEventListener('online', () => apply(false));
    apply(navigator.onLine === false);
}
