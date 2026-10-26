package com.suanran.zhixiang;

import android.content.Context;
import android.content.Intent;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.PluginMethod;

import java.io.IOException;

/**
 * 播放原生桥：全新写，不抄旧服务。
 *
 * 方法对应 Web 层 src/native/playback-plugin.ts：
 * - start：起保活前台服务（通知应用名 + 当前歌名，无控制按钮）。
 * - stop：停前台服务。
 * - ensureProxy：起本机流代理（StreamProxyServer），回端口；已起则复用。
 * - stopProxy：停本机流代理。
 * - setMedia / setPlaying / clearMedia（0.1.52）：同步系统播放卡的曲目与
 *   播放态到 PlaybackService 的 MediaSession；失败不抛给播放流程。
 * - mediaAction 事件：会话回调（耳机、通知按钮）经静态实例发给 JS，
 *   JS 按逻辑状态幂等处理，绝不在原生侧直接碰播放。
 *
 * 注册方式：与 LocalMusicPlugin / HttpBridgePlugin 一致，放在应用源码里，
 * 由 MainActivity 在桥接创建前显式注册。
 */
@CapacitorPlugin(name = "Playback")
public class PlaybackPlugin extends Plugin {

    private static PlaybackPlugin instance;

    private StreamProxyServer proxy;

    /**
     * 桥接加载时就钉住实例（0.1.56）：之前只在各方法里赋值，若桥接
     * 重建后、下一声道同步前点了系统卡按键，静态实例还指着旧桥接，
     * 会话回调的事件就悄悄丢了，卡上按键看着全没用。
     */
    @Override
    public void load() {
        super.load();
        instance = this;
    }

    /** 会话回调入口：服务侧调，Web 层已不在时直接丢弃。 */
    public static void emitMediaAction(String action) {
        PlaybackPlugin plugin = instance;
        if (plugin == null) {
            return;
        }
        JSObject data = new JSObject();
        data.put("action", action);
        plugin.notifyListeners("mediaAction", data);
    }

    @PluginMethod
    public void start(PluginCall call) {
        instance = this;
        Context context = getContext();
        if (context == null) {
            call.reject("系统服务不可用", "NO_CONTEXT");
            return;
        }
        String title = call.getString("title");
        String artist = call.getString("artist");
        Intent intent = new Intent(context, PlaybackService.class);
        intent.setAction(PlaybackService.ACTION_START);
        intent.putExtra(PlaybackService.EXTRA_TITLE, title == null ? "" : title);
        intent.putExtra(PlaybackService.EXTRA_ARTIST, artist == null ? "" : artist);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
            call.resolve();
        } catch (Exception e) {
            // 后台启动受限等：不崩，Web 层捕获后继续播，只是保活可能失效。
            call.reject("前台服务启动失败", "SERVICE_START_FAILED", e);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        instance = this;
        Context context = getContext();
        if (context == null) {
            call.reject("系统服务不可用", "NO_CONTEXT");
            return;
        }
        Intent intent = new Intent(context, PlaybackService.class);
        intent.setAction(PlaybackService.ACTION_STOP);
        try {
            context.stopService(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("前台服务停止失败", "SERVICE_STOP_FAILED", e);
        }
    }

    @PluginMethod
    public void setMedia(PluginCall call) {
        instance = this;
        Context context = getContext();
        if (context == null) {
            call.reject("系统服务不可用", "NO_CONTEXT");
            return;
        }
        long albumId = -1;
        try {
            albumId = call.getData().optLong("albumId", -1);
        } catch (Exception e) {
            albumId = -1;
        }
        Intent intent = new Intent(context, PlaybackService.class);
        intent.setAction(PlaybackService.ACTION_SET_MEDIA);
        intent.putExtra(PlaybackService.EXTRA_TITLE, stringOrEmpty(call.getString("title")));
        intent.putExtra(PlaybackService.EXTRA_ARTIST, stringOrEmpty(call.getString("artist")));
        intent.putExtra(PlaybackService.EXTRA_ALBUM, stringOrEmpty(call.getString("album")));
        intent.putExtra(PlaybackService.EXTRA_COVER_URL, stringOrEmpty(call.getString("coverUrl")));
        intent.putExtra(PlaybackService.EXTRA_ALBUM_ID, albumId);
        try {
            startServiceCompat(context, intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("媒体会话同步失败", "MEDIA_SYNC_FAILED", e);
        }
    }

    @PluginMethod
    public void setPlaying(PluginCall call) {
        instance = this;
        Context context = getContext();
        if (context == null) {
            call.reject("系统服务不可用", "NO_CONTEXT");
            return;
        }
        Intent intent = new Intent(context, PlaybackService.class);
        intent.setAction(PlaybackService.ACTION_SET_PLAYING);
        intent.putExtra(PlaybackService.EXTRA_PLAYING, call.getBoolean("playing", false));
        try {
            startServiceCompat(context, intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("媒体会话同步失败", "MEDIA_SYNC_FAILED", e);
        }
    }

    @PluginMethod
    public void clearMedia(PluginCall call) {
        instance = this;
        Context context = getContext();
        if (context == null) {
            call.reject("系统服务不可用", "NO_CONTEXT");
            return;
        }
        Intent intent = new Intent(context, PlaybackService.class);
        intent.setAction(PlaybackService.ACTION_CLEAR_MEDIA);
        try {
            startServiceCompat(context, intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("媒体会话同步失败", "MEDIA_SYNC_FAILED", e);
        }
    }

    private String stringOrEmpty(String value) {
        return value == null ? "" : value;
    }

    private void startServiceCompat(Context context, Intent intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    @PluginMethod
    public synchronized void ensureProxy(PluginCall call) {
        try {
            if (proxy == null) {
                proxy = new StreamProxyServer();
            }
            int port = proxy.start();
            JSObject result = new JSObject();
            result.put("port", port);
            call.resolve(result);
        } catch (IOException e) {
            call.reject("本机流代理启动失败", "PROXY_START_FAILED", e);
        }
    }

    @PluginMethod
    public synchronized void stopProxy(PluginCall call) {
        if (proxy != null) {
            proxy.stop();
            proxy = null;
        }
        call.resolve();
    }
}
