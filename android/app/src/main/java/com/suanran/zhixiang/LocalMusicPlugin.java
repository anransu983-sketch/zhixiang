package com.suanran.zhixiang;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;

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
