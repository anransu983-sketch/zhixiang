package com.suanran.zhixiang;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.Shader;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.service.wallpaper.WallpaperService;
import android.text.Layout;
import android.text.StaticLayout;
import android.text.TextPaint;
import android.text.TextUtils;
import android.view.Display;
import android.view.SurfaceHolder;
import android.view.WindowManager;

import org.json.JSONArray;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;

/**
 * 歌词动态壁纸服务（第 8 块，全新写，不抄旧服务）。
 *
 * 形态：Live Wallpaper，引擎每秒读一次 SharedPreferences
 * （zhixiang_wallpaper，见 WallpaperPlugin），画当前歌词行 + 氛围底。
 * 氛围底是星空 / 粒子二选一的轻量版：星空开关开时画星空，否则画
 * 粒子；两个都不开时只画渐变底。四项视觉不全搬进壁纸。
 *
 * 闲置：播放停止后只画一帧静止暗帧，不再推进歌词，之后每 10 秒
 * 复查一次状态（等恢复播放时再动），不空转。
 *
 * 挖孔避让：读 DisplayCutout 的 boundingRect 求顶部安全区，歌名与
 * 歌词都画在安全区之下；读不到挖孔时默认留 32dp 顶部边距。
 *
 * 读不到状态、或无歌词时：只画氛围底 + 歌名（无歌名时画应用名），
 * 绝不崩、绝不空白黑屏。
 */
public class LyricWallpaperService extends WallpaperService {

    @Override
    public Engine onCreateEngine() {
        return new LyricEngine();
    }

    private class LyricEngine extends Engine {

        private final Handler handler = new Handler(Looper.getMainLooper());
        private final Random random = new Random(20261025L);
        private final List<float[]> stars = new ArrayList<>();
        private final List<float[]> particles = new ArrayList<>();
        private boolean visible = false;
        private boolean drawnStatic = false;

        private final Runnable drawRunnable = new Runnable() {
            @Override
            public void run() {
                drawFrame();
            }
        };

        @Override
        public void onVisibilityChanged(boolean visible) {
            this.visible = visible;
            if (visible) {
                drawnStatic = false;
                scheduleDraw(0);
            } else {
                handler.removeCallbacks(drawRunnable);
            }
        }

        @Override
        public void onSurfaceDestroyed(SurfaceHolder holder) {
            super.onSurfaceDestroyed(holder);
            handler.removeCallbacks(drawRunnable);
            visible = false;
        }

        private void scheduleDraw(long delayMs) {
            handler.removeCallbacks(drawRunnable);
            if (visible) {
                handler.postDelayed(drawRunnable, delayMs);
            }
        }

        private void drawFrame() {
            SurfaceHolder holder = getSurfaceHolder();
            Canvas canvas = null;
            boolean playing = false;
            try {
                canvas = holder.lockCanvas();
                if (canvas == null) {
                    return;
                }
                playing = drawOn(canvas);
            } catch (Exception ignored) {
                // 壁纸画布异常时静默跳过这一帧，不崩服务。
            } finally {
                if (canvas != null) {
                    try {
                        holder.unlockCanvasAndPost(canvas);
                    } catch (Exception ignored) {
                        // 解锁失败时同样不崩。
                    }
                }
            }
            if (!visible) {
                return;
            }
            if (playing) {
                drawnStatic = false;
                scheduleDraw(1000);
            } else if (!drawnStatic) {
                drawnStatic = true;
                scheduleDraw(10000);
            } else {
                scheduleDraw(10000);
            }
        }

        // 返回当前是否在播放，供调度决定下一帧间隔。
        private boolean drawOn(Canvas canvas) {
            Context context = LyricWallpaperService.this;
            int width = canvas.getWidth();
            int height = canvas.getHeight();
            if (width <= 0 || height <= 0) {
                return false;
            }
            SharedPreferences prefs =
                    context.getSharedPreferences(WallpaperPlugin.PREFS_NAME, Context.MODE_PRIVATE);
            String title = prefs.getString("trackTitle", "");
            String artist = prefs.getString("trackArtist", "");
            boolean playing = prefs.getBoolean("playing", false);
            int currentLineIndex = prefs.getInt("currentLineIndex", -1);
            boolean starsOn = prefs.getBoolean("toggleStars", false);
            List<String> lines = parseLines(prefs.getString("lyricLines", "[]"));
            String lyric = "";
            if (currentLineIndex >= 0 && currentLineIndex < lines.size()) {
                lyric = lines.get(currentLineIndex);
            }

            float density = context.getResources().getDisplayMetrics().density;
            if (density <= 0) {
                density = 1f;
            }

            Paint bgPaint = new Paint();
            LinearGradient gradient = new LinearGradient(
                    0, 0, 0, height,
                    Color.rgb(0x2a, 0x1a, 0x30),
                    Color.rgb(0x14, 0x10, 0x1c),
                    Shader.TileMode.CLAMP);
            bgPaint.setShader(gradient);
            canvas.drawRect(0, 0, width, height, bgPaint);

            long tick = playing ? System.currentTimeMillis() : 0L;
            if (starsOn) {
                drawStars(canvas, width, height, tick, playing);
            } else {
                drawParticles(canvas, width, height, tick, playing);
            }

            int topSafe = topSafePx(density);
            TextPaint titlePaint = new TextPaint(Paint.ANTI_ALIAS_FLAG);
            titlePaint.setColor(Color.WHITE);
            titlePaint.setTextSize(22f * density);
            titlePaint.setFakeBoldText(true);
            String titleText = title == null || title.isEmpty() ? "芷湘" : title;
            CharSequence titleEllipsized = TextUtils.ellipsize(
                    titleText, titlePaint, width - 64f * density, TextUtils.TruncateAt.END);
            float titleY = topSafe + 28f * density;
            canvas.drawText(titleEllipsized.toString(), 32f * density, titleY, titlePaint);

            float textY = titleY + 30f * density;
            if (artist != null && !artist.isEmpty()) {
                TextPaint artistPaint = new TextPaint(Paint.ANTI_ALIAS_FLAG);
                artistPaint.setColor(Color.rgb(0xc9, 0xb8, 0xd8));
                artistPaint.setTextSize(15f * density);
                CharSequence artistEllipsized = TextUtils.ellipsize(
                        artist, artistPaint, width - 64f * density, TextUtils.TruncateAt.END);
                canvas.drawText(artistEllipsized.toString(), 32f * density, textY, artistPaint);
                textY += 26f * density;
            }

            if (lyric != null && !lyric.isEmpty()) {
                TextPaint lyricPaint = new TextPaint(Paint.ANTI_ALIAS_FLAG);
                lyricPaint.setColor(Color.WHITE);
                lyricPaint.setTextSize(19f * density);
                int textWidth = Math.max(1, (int) (width - 64f * density));
                StaticLayout layout = StaticLayout.Builder.obtain(
                        lyric, 0, lyric.length(), lyricPaint, textWidth)
                        .setAlignment(Layout.Alignment.ALIGN_CENTER)
                        .build();
                canvas.save();
                canvas.translate(32f * density, textY);
                layout.draw(canvas);
                canvas.restore();
            }
            return playing;
        }

        private List<String> parseLines(String json) {
            List<String> lines = new ArrayList<>();
            if (json == null || json.isEmpty()) {
                return lines;
            }
            try {
                JSONArray array = new JSONArray(json);
                for (int i = 0; i < array.length(); i++) {
                    String line = array.optString(i, "");
                    if (line != null) {
                        lines.add(line);
                    }
                }
            } catch (Exception ignored) {
                // 存坏了就当无歌词，仍画氛围底与歌名。
            }
            return lines;
        }

        private int topSafePx(float density) {
            int fallback = Math.round(32f * density);
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    WindowManager manager =
                            (WindowManager) getSystemService(Context.WINDOW_SERVICE);
                    if (manager == null) {
                        return fallback;
                    }
                    @SuppressWarnings("deprecation")
                    Display display = manager.getDefaultDisplay();
                    if (display == null) {
                        return fallback;
                    }
                    android.view.DisplayCutout cutout = display.getCutout();
                    if (cutout == null) {
                        return fallback;
                    }
                    int bottom = 0;
                    for (Rect rect : cutout.getBoundingRects()) {
                        if (rect != null && rect.bottom > bottom) {
                            bottom = rect.bottom;
                        }
                    }
                    return bottom > 0 ? bottom + Math.round(12f * density) : fallback;
                }
            } catch (Exception ignored) {
                // 读不到挖孔时用默认边距，不崩。
            }
            return fallback;
        }

        private void drawStars(Canvas canvas, int width, int height, long tick, boolean animated) {
            if (stars.isEmpty()) {
                for (int i = 0; i < 80; i++) {
                    stars.add(new float[]{
                            random.nextFloat() * width,
                            random.nextFloat() * height,
                            1f + random.nextFloat() * 2f,
                            random.nextFloat() * (float) (Math.PI * 2)});
                }
            }
            Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
            for (float[] star : stars) {
                float alpha;
                if (animated) {
                    alpha = 0.35f + 0.65f * (0.5f + 0.5f * (float) Math.sin(
                            tick / 1000.0 * 0.8 + star[3]));
                } else {
                    alpha = 0.7f;
                }
                paint.setColor(Color.argb(Math.round(alpha * 255), 255, 255, 255));
                canvas.drawCircle(star[0], star[1], star[2], paint);
            }
        }

        private void drawParticles(Canvas canvas, int width, int height, long tick, boolean animated) {
            if (particles.isEmpty()) {
                for (int i = 0; i < 40; i++) {
                    particles.add(new float[]{
                            random.nextFloat() * width,
                            random.nextFloat() * height,
                            (random.nextFloat() - 0.5f) * 2f,
                            (random.nextFloat() - 0.5f) * 2f,
                            2f + random.nextFloat() * 3f});
                }
            }
            Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
            paint.setColor(Color.argb(200, 232, 160, 191));
            for (float[] particle : particles) {
                if (animated) {
                    particle[0] += particle[2];
                    particle[1] += particle[3];
                    if (particle[0] < 0 || particle[0] > width) {
                        particle[2] *= -1;
                    }
                    if (particle[1] < 0 || particle[1] > height) {
                        particle[3] *= -1;
                    }
                }
                canvas.drawCircle(particle[0], particle[1], particle[4], paint);
            }
        }
    }
}
