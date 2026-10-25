package com.suanran.zhixiang;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.PluginMethod;

/**
 * 动态壁纸原生桥（第 8 块，全新写，不抄旧服务）。
 *
 * 与 Web 层 src/native/wallpaper-plugin.ts 对应：
 * - setWallpaperState：把播放页的当前状态写进 SharedPreferences
 *  （zhixiang_wallpaper），供 LyricWallpaperService 的引擎定时读取。
 *   只在切歌、播放/暂停变化、歌词行变化时由 Web 层调用，不高频写。
 * - openLiveWallpaperPicker：发系统动态壁纸选择器
 *  （ACTION_CHANGE_LIVE_WALLPAPER），由用户自己确认设为系统壁纸；
 *   本应用绝不静默改用户壁纸。
 */
@CapacitorPlugin(name = "Wallpaper")
public class WallpaperPlugin extends Plugin {

    static final String PREFS_NAME = "zhixiang_wallpaper";

    @PluginMethod
    public void setWallpaperState(PluginCall call) {
        Context context = getContext();
        if (context == null) {
            call.reject("系统服务不可用", "NO_CONTEXT");
            return;
        }
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        SharedPreferences.Editor editor = prefs.edit();
        editor.putString("trackTitle", stringOrEmpty(call.getString("trackTitle")));
        editor.putString("trackArtist", stringOrEmpty(call.getString("trackArtist")));
        editor.putBoolean("playing", Boolean.TRUE.equals(call.getBoolean("playing")));
        editor.putInt("positionMs", intOrZero(call.getInt("positionMs")));
        editor.putInt("currentLineIndex", intOrZero(call.getInt("currentLineIndex")));
        JSArray lines = call.getArray("lyricLines");
        editor.putString("lyricLines", lines == null ? "[]" : lines.toString());
        editor.putBoolean("toggleRain", booleanOrDefault(call.getBoolean("toggleRain"), true));
        editor.putBoolean("toggleParticles", booleanOrDefault(call.getBoolean("toggleParticles"), false));
        editor.putBoolean("togglePulse", booleanOrDefault(call.getBoolean("togglePulse"), false));
        editor.putBoolean("toggleStars", booleanOrDefault(call.getBoolean("toggleStars"), false));
        editor.apply();
        call.resolve();
    }

    @PluginMethod
    public void openLiveWallpaperPicker(PluginCall call) {
        Context context = getContext();
        if (context == null) {
            call.reject("系统服务不可用", "NO_CONTEXT");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CHANGE_LIVE_WALLPAPER);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("打不开系统壁纸选择器", "PICKER_FAILED", e);
        }
    }

    private static String stringOrEmpty(String value) {
        return value == null ? "" : value;
    }

    private static int intOrZero(Integer value) {
        return value == null ? 0 : value;
    }

    private static boolean booleanOrDefault(Boolean value, boolean fallback) {
        return value == null ? fallback : value;
    }
}
