package com.suanran.zhixiang;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.util.Base64;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.getcapacitor.PluginMethod;

/**
 * 本地音乐插件：查询 MediaStore，返回设备上的音乐文件。
 *
 * 注册方式：本插件直接放在应用源码里，不属于任何 npm 包，
 * cap sync 生成的 capacitor.plugins.json 覆盖不到它，
 * 因此由 MainActivity 在桥接创建前显式注册（见 MainActivity）。
 */
@CapacitorPlugin(
    name = "LocalMusic",
    permissions = {
        @Permission(alias = "audio", strings = { Manifest.permission.READ_MEDIA_AUDIO }),
        @Permission(alias = "audioLegacy", strings = { Manifest.permission.READ_EXTERNAL_STORAGE })
    }
)
public class LocalMusicPlugin extends Plugin {

    @PluginMethod
    public void scan(PluginCall call) {
        if (!hasAudioPermission()) {
            // 8.4.2 正确做法：按系统版本选 alias 拉系统授权弹窗，结果回
            // audioPermissionCallback；不用已废弃的 requestPermissions(int) 老路。
            // Manifest 声明已在（READ_MEDIA_AUDIO + maxSdk 32 的 READ_EXTERNAL_STORAGE）。
            String alias = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                ? "audio"
                : "audioLegacy";
            requestPermissionForAlias(alias, call, "audioPermissionCallback");
            return;
        }
        doScan(call);
    }

    @PermissionCallback
    private void audioPermissionCallback(PluginCall call) {
        if (hasAudioPermission()) {
            // 授权通过：同一 call 直接重扫，不用用户再点一次。
            doScan(call);
        } else {
            // 拒绝（含永久拒绝）：保留去系统设置的提示，TS 侧原样展示。
            call.reject("缺少读取音频文件的权限", "PERMISSION_DENIED");
        }
    }

    private void doScan(PluginCall call) {
        if (getContext() == null) {
            call.reject("系统服务不可用", "NO_CONTEXT");
            return;
        }
        ContentResolver resolver = getContext().getContentResolver();
        if (resolver == null) {
            call.reject("系统服务不可用", "NO_RESOLVER");
            return;
        }

        String[] projection = {
            MediaStore.Audio.Media._ID,
            MediaStore.Audio.Media.TITLE,
            MediaStore.Audio.Media.ARTIST,
            MediaStore.Audio.Media.ALBUM,
            MediaStore.Audio.Media.ALBUM_ID,
            MediaStore.Audio.Media.DURATION,
            MediaStore.Audio.Media.DATA
        };
        String selection = MediaStore.Audio.Media.IS_MUSIC + " != 0";
        String sortOrder = MediaStore.Audio.Media.TITLE + " ASC";

        try (Cursor cursor = resolver.query(
            MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
            projection,
            selection,
            null,
            sortOrder
        )) {
            if (cursor == null) {
                call.reject("读取媒体库失败", "NO_CURSOR");
                return;
            }
            int idIndex = cursor.getColumnIndex(MediaStore.Audio.Media._ID);
            int titleIndex = cursor.getColumnIndex(MediaStore.Audio.Media.TITLE);
            int artistIndex = cursor.getColumnIndex(MediaStore.Audio.Media.ARTIST);
            int albumIndex = cursor.getColumnIndex(MediaStore.Audio.Media.ALBUM);
            int albumIdIndex = cursor.getColumnIndex(MediaStore.Audio.Media.ALBUM_ID);
            int durationIndex = cursor.getColumnIndex(MediaStore.Audio.Media.DURATION);
            int dataIndex = cursor.getColumnIndex(MediaStore.Audio.Media.DATA);

            JSArray tracks = new JSArray();
            while (cursor.moveToNext()) {
                String path = dataIndex >= 0 ? cursor.getString(dataIndex) : null;
                if (path == null || path.isEmpty()) {
                    continue;
                }
                JSObject track = new JSObject();
                long id = idIndex >= 0 ? cursor.getLong(idIndex) : -1;
                track.put("id", String.valueOf(id));
                String title = titleIndex >= 0 ? cursor.getString(titleIndex) : null;
                track.put("title", title == null || title.isEmpty() ? path : title);
                String artist = artistIndex >= 0 ? cursor.getString(artistIndex) : null;
                track.put("artist", artist == null || artist.isEmpty() ? "未知歌手" : artist);
                String album = albumIndex >= 0 ? cursor.getString(albumIndex) : null;
                if (album != null && !album.isEmpty()) {
                    track.put("album", album);
                }
                if (durationIndex >= 0) {
                    track.put("durationMs", cursor.getLong(durationIndex));
                }
                long albumId = albumIdIndex >= 0 ? cursor.getLong(albumIdIndex) : -1;
                if (albumId > 0) {
                    Uri coverUri = ContentUris.withAppendedId(
                        Uri.parse("content://media/external/audio/albumart"),
                        albumId
                    );
                    track.put("coverUri", coverUri.toString());
                }
                track.put("path", path);
                tracks.put(track);
            }

            JSObject result = new JSObject();
            result.put("tracks", tracks);
            call.resolve(result);
        } catch (SecurityException e) {
            call.reject("缺少读取音频文件的权限", "PERMISSION_DENIED", e);
        } catch (Exception e) {
            call.reject("扫描本地音乐失败", "SCAN_FAILED", e);
        }
    }

    // 播放页封面：按专辑 id 读一张专辑图，转 data URL 回 Web 层。
    // 只在播放页点开当前曲目时调一次，不批量扫库；读不到图时 reject，
    // TS 侧按无封面处理（隐藏封面，不露破图）。
    @PluginMethod
    public void coverArt(PluginCall call) {
        if (getContext() == null) {
            call.reject("系统服务不可用", "NO_CONTEXT");
            return;
        }
        long albumId = call.getData() != null ? call.getData().optLong("albumId", -1) : -1;
        if (albumId <= 0) {
            call.reject("缺少专辑 id", "NO_ALBUM_ID");
            return;
        }
        ContentResolver resolver = getContext().getContentResolver();
        if (resolver == null) {
            call.reject("系统服务不可用", "NO_RESOLVER");
            return;
        }
        Uri coverUri = ContentUris.withAppendedId(
            Uri.parse("content://media/external/audio/albumart"),
            albumId
        );
        try (InputStream input = resolver.openInputStream(coverUri)) {
            if (input == null) {
                call.reject("没有专辑图", "NO_COVER");
                return;
            }
            Bitmap bitmap = BitmapFactory.decodeStream(input);
            if (bitmap == null) {
                call.reject("没有专辑图", "NO_COVER");
                return;
            }
            int width = bitmap.getWidth();
            int height = bitmap.getHeight();
            Bitmap scaled = bitmap;
            int maxSide = Math.max(width, height);
            if (maxSide > 512) {
                float scale = 512f / maxSide;
                scaled = Bitmap.createScaledBitmap(
                    bitmap,
                    Math.max(1, Math.round(width * scale)),
                    Math.max(1, Math.round(height * scale)),
                    true
                );
            }
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            scaled.compress(Bitmap.CompressFormat.JPEG, 85, output);
            if (scaled != bitmap) {
                scaled.recycle();
            }
            bitmap.recycle();
            String base64 = Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP);
            JSObject result = new JSObject();
            result.put("dataUrl", "data:image/jpeg;base64," + base64);
            call.resolve(result);
        } catch (SecurityException e) {
            call.reject("缺少读取音频文件的权限", "PERMISSION_DENIED", e);
        } catch (Exception e) {
            call.reject("读专辑图失败", "COVER_FAILED", e);
        }
    }

    // 内嵌歌词（0.1.103）：读文件自带的词（同名 .lrc / MP3 USLT /
    // FLAC 注释 / M4A ©lyr），见 EmbeddedLyrics。读不到只回 found=false，
    // TS 侧落到联网补源；文件读失败也只 reject，TS 侧同样落到补源。
    @PluginMethod
    public void embeddedLyrics(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) {
            call.reject("缺少文件路径", "NO_PATH");
            return;
        }
        try {
            EmbeddedLyrics.Result result = EmbeddedLyrics.read(path);
            JSObject out = new JSObject();
            out.put("found", result != null);
            out.put("lyrics", result != null ? result.text : "");
            out.put("source", result != null ? result.source : "");
            call.resolve(out);
        } catch (Exception e) {
            call.reject("读内嵌歌词失败", "READ_FAILED", e);
        }
    }

    private boolean hasAudioPermission() {
        if (getContext() == null) {
            return false;
        }
        String permission;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permission = Manifest.permission.READ_MEDIA_AUDIO;
        } else {
            permission = Manifest.permission.READ_EXTERNAL_STORAGE;
        }
        return ContextCompat.checkSelfPermission(getContext(), permission)
            == PackageManager.PERMISSION_GRANTED;
    }
}
