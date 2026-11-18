// 性能自检轻量版（Folia perfCheck 的思路，不要它的 Electron 壳
// 与多档位对比）：播放页第一次打开时用 rAF 实测 2.5 秒帧率，
// 低于 45 帧/秒才自动开轻装（复用 appearance.ts 的 perf-mode），
// 并弹一次横条告知、可一键恢复。只测一次（localStorage 记 done），
// 之后每次打开都不再测、不再弹；测到一半切后台即作废，下次重测。

import { applyPerfMode, loadPerfMode } from './appearance';

const DONE_KEY = 'zx.perf.autocheck.v1';
const MEASURE_MS = 2500;
const FPS_THRESHOLD = 45;

function isDone(): boolean {
    try {
        return localStorage.getItem(DONE_KEY) === '1';
    } catch {
        return true;
    }
}

function markDone(): void {
    try {
        localStorage.setItem(DONE_KEY, '1');
    } catch {
        // 记不住也只影响下次是否重测，不中断播放。
    }
}

function showLiteBanner(fps: number): void {
    const banner = document.createElement('div');
    banner.className = 'perf-check-banner';
    const text = document.createElement('span');
    text.className = 'perf-check-text';
    text.textContent = `这台手机播歌词动画有点卡（约 ${fps} 帧/秒），已为你开轻装`;
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'login-btn';
    restore.textContent = '恢复原样';
    restore.addEventListener('click', () => {
        applyPerfMode(false);
        console.log('[PerfCheck] 用户点恢复原样，已关轻装');
        banner.remove();
    });
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'login-btn';
    dismiss.textContent = '知道了';
    dismiss.addEventListener('click', () => {
        banner.remove();
    });
    banner.append(text, restore, dismiss);
    document.body.appendChild(banner);
}

export function runFirstOpenPerfCheck(): void {
    if (isDone() || loadPerfMode()) {
        return;
    }
    if (document.hidden) {
        return;
    }
    let frames = 0;
    let cancelled = false;
    const onVisibility = (): void => {
        if (document.hidden) {
            cancelled = true;
        }
    };
    document.addEventListener('visibilitychange', onVisibility);
    const startedAt = performance.now();
    const tick = (): void => {
        if (cancelled) {
            document.removeEventListener('visibilitychange', onVisibility);
            return;
        }
        frames += 1;
        const elapsed = performance.now() - startedAt;
        if (elapsed < MEASURE_MS) {
            requestAnimationFrame(tick);
            return;
        }
        document.removeEventListener('visibilitychange', onVisibility);
        markDone();
        const fps = Math.round((frames / elapsed) * 1000);
        console.log(`[PerfCheck] 首次打开播放页实测 ${fps} 帧/秒（${frames} 帧/${Math.round(elapsed)}ms）`);
        if (fps < FPS_THRESHOLD) {
            applyPerfMode(true);
            console.log('[PerfCheck] 低于阈值，已自动开轻装');
            showLiteBanner(fps);
        }
    };
    requestAnimationFrame(tick);
}
