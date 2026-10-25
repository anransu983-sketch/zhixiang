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
 * 四个方法，对应 Web 层 src/native/playback-plugin.ts：
 * - start：起保活前台服务（通知应用名 + 当前歌名，无控制按钮）。
 * - stop：停前台服务。
 * - ensureProxy：起本机流代理（StreamProxyServer），回端口；已起则复用。
 * - stopProxy：停本机流代理。
 *
 * 注册方式：与 LocalMusicPlugin / HttpBridgePlugin 一致，放在应用源码里，
 * 由 MainActivity 在桥接创建前显式注册。
 */
@CapacitorPlugin(name = "Playback")
public class PlaybackPlugin extends Plugin {

    private StreamProxyServer proxy;

    @PluginMethod
    public void start(PluginCall call) {
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
