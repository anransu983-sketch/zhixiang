// 封面取色（0.1.101）：跨域匿名加载封面，缩到 48px 后按 4-bit 桶统计，
// 取饱和像素最多的桶的均色。网易云 p1/p2、YTM i.ytimg.com/lh3 均回
// Access-Control-Allow-Origin: *（2026-10-29 实测），三源封面都能采；
// 失败（跨域拦截、超时、无饱和像素）回 null，调用方用主题色兜底。

export function sampleCoverColor(url: string, timeoutMs = 5000): Promise<string | null> {
    return new Promise((resolve) => {
        let done = false;
        const finish = (value: string | null): void => {
            if (done) {
                return;
            }
            done = true;
            resolve(value);
        };
        const timer = window.setTimeout(() => finish(null), timeoutMs);
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            window.clearTimeout(timer);
            try {
                const size = 48;
                const canvas = document.createElement('canvas');
                canvas.width = size;
                canvas.height = size;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                if (!ctx) {
                    finish(null);
                    return;
                }
                ctx.drawImage(img, 0, 0, size, size);
                const data = ctx.getImageData(0, 0, size, size).data;
                interface Bucket {
                    count: number;
                    r: number;
                    g: number;
                    b: number;
                }
                const buckets = new Map<number, Bucket>();
                let allCount = 0;
                let allR = 0;
                let allG = 0;
                let allB = 0;
                for (let i = 0; i < data.length; i += 4) {
                    const r = data[i]!;
                    const g = data[i + 1]!;
                    const b = data[i + 2]!;
                    const a = data[i + 3]!;
                    if (a < 128) {
                        continue;
                    }
                    allCount += 1;
                    allR += r;
                    allG += g;
                    allB += b;
                    // 近灰像素不入选，避免灰白黑底主导取色。
                    if (Math.max(r, g, b) - Math.min(r, g, b) < 24) {
                        continue;
                    }
                    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
                    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
                    bucket.count += 1;
                    bucket.r += r;
                    bucket.g += g;
                    bucket.b += b;
                    buckets.set(key, bucket);
                }
                let best: Bucket | null = null;
                for (const bucket of buckets.values()) {
                    if (!best || bucket.count > best.count) {
                        best = bucket;
                    }
                }
                const pick =
                    best ??
                    (allCount > 0 ? { count: allCount, r: allR, g: allG, b: allB } : null);
                if (!pick) {
                    finish(null);
                    return;
                }
                const toHex = (v: number): string =>
                    Math.round(v).toString(16).padStart(2, '0');
                finish(
                    `#${toHex(pick.r / pick.count)}${toHex(pick.g / pick.count)}${toHex(pick.b / pick.count)}`
                );
            } catch {
                finish(null);
            }
        };
        img.onerror = () => {
            window.clearTimeout(timer);
            finish(null);
        };
        img.src = url;
    });
}
