package com.suanran.zhixiang;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

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

    // 专辑图/sidecar 图共用：最长边压到 512、JPEG 85，返回 data URL。
    // 传进来的 bitmap 在这里回收，调用方不要再用。
    private String encodeBitmapToDataUrl(Bitmap bitmap) {
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
        return "data:image/jpeg;base64," + base64;
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
            JSObject result = new JSObject();
            result.put("dataUrl", encodeBitmapToDataUrl(bitmap));
            call.resolve(result);
        } catch (SecurityException e) {
            call.reject("缺少读取音频文件的权限", "PERMISSION_DENIED", e);
        } catch (Exception e) {
            call.reject("读专辑图失败", "COVER_FAILED", e);
        }
    }

    // 同名封面（0.1.106 写回配套）：音频同目录下同名 .jpg/.png，
    // 先 .jpg 后 .png；读不到只 reject，TS 侧落到原有链。Android 13+
    // 上读他人图片文件须所有文件访问权限（或 READ_MEDIA_IMAGES），
    // 没权限时抛 SecurityException，同样落到原有链，不影响播放。
    @PluginMethod
    public void coverFile(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) {
            call.reject("缺少文件路径", "NO_PATH");
            return;
        }
        int dot = path.lastIndexOf('.');
        int slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
        if (dot <= slash) {
            call.reject("没有同名封面", "NO_COVER");
            return;
        }
        String base = path.substring(0, dot);
        File jpg = new File(base + ".jpg");
        File png = new File(base + ".png");
        File file = jpg.isFile() ? jpg : (png.isFile() ? png : null);
        if (file == null) {
            call.reject("没有同名封面", "NO_COVER");
            return;
        }
        try (FileInputStream input = new FileInputStream(file)) {
            Bitmap bitmap = BitmapFactory.decodeStream(input);
            if (bitmap == null) {
                call.reject("没有同名封面", "NO_COVER");
                return;
            }
            JSObject result = new JSObject();
            result.put("dataUrl", encodeBitmapToDataUrl(bitmap));
            call.resolve(result);
        } catch (SecurityException e) {
            call.reject("缺少读取文件的权限", "PERMISSION_DENIED", e);
        } catch (Exception e) {
            call.reject("读同名封面失败", "COVER_FAILED", e);
        }
    }

    // 所有文件访问权限：查（0.1.106 写回配套）。API 30 以下没有
    // isExternalStorageManager，直接回未授予。
    @PluginMethod
    public void checkAllFilesAccess(PluginCall call) {
        boolean granted = false;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                granted = Environment.isExternalStorageManager();
            }
        } catch (Exception e) {
            granted = false;
        }
        JSObject result = new JSObject();
        result.put("granted", granted);
        call.resolve(result);
    }

    // 所有文件访问权限：开设置页（0.1.106 写回配套）。只发 Intent 立即
    // 返回，不等结果；用户授权后回 App 再点检查。带包名的本应用设置页
    // 打不开时 fallback 到通用所有文件访问设置页。
    @PluginMethod
    public void requestAllFilesAccess(PluginCall call) {
        if (getContext() == null) {
            call.reject("系统服务不可用", "NO_CONTEXT");
            return;
        }
        try {
            Intent intent;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                intent = new Intent(
                    Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                    Uri.parse("package:" + getContext().getPackageName())
                );
            } else {
                intent = new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            JSObject result = new JSObject();
            result.put("opened", true);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("打不开所有文件访问设置页", "OPEN_SETTINGS_FAILED", e);
        }
    }

    // sidecar 写回（0.1.106）：只写音频同目录的同名 .lrc（UTF-8 歌词）
    // 与同名 .jpg（coverDataUrl 解 base64），不动原音频文件；目标文件
    // 已存在时跳过不覆盖（不毁用户自己的文件）。先写封面后写歌词：
    // 封面失败时歌词还没动，重跑可全量重试；歌词失败时封面已落盘，
    // 重跑因歌词未落盘仍会重试（封面那步跳过已存在）。任一写失败
    //  reject，TS 侧计失败、不中断整批。没开所有文件访问权限时直接
    // 拒绝，不写。
    @PluginMethod
    public void writeSidecar(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) {
            call.reject("缺少文件路径", "NO_PATH");
            return;
        }
        String lyrics = call.getString("lyrics");
        String coverDataUrl = call.getString("coverDataUrl");
        boolean hasLyrics = lyrics != null && !lyrics.isEmpty();
        boolean hasCover = coverDataUrl != null && !coverDataUrl.isEmpty();
        if (!hasLyrics && !hasCover) {
            call.reject("没有可写的内容", "NOTHING_TO_WRITE");
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                && !Environment.isExternalStorageManager()) {
            call.reject("未授予所有文件访问权限", "NO_ALL_FILES_ACCESS");
            return;
        }
        int dot = path.lastIndexOf('.');
        int slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
        String base = dot > slash ? path.substring(0, dot) : path;
        File lrcFile = new File(base + ".lrc");
        File jpgFile = new File(base + ".jpg");
        boolean lyricWritten = false;
        boolean coverWritten = false;
        boolean skipped = false;
        try {
            if (hasCover && coverDataUrl != null) {
                if (jpgFile.isFile()) {
                    skipped = true;
                } else {
                    String base64 = coverDataUrl;
                    int comma = base64.indexOf(',');
                    if (comma >= 0) {
                        base64 = base64.substring(comma + 1);
                    }
                    byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                    if (bytes.length == 0) {
                        throw new IllegalArgumentException("empty cover");
                    }
                    try (OutputStream out = new FileOutputStream(jpgFile)) {
                        out.write(bytes);
                    }
                    coverWritten = true;
                }
            }
            if (hasLyrics && lyrics != null) {
                if (lrcFile.isFile()) {
                    skipped = true;
                } else {
                    try (OutputStream out = new FileOutputStream(lrcFile)) {
                        out.write(lyrics.getBytes(StandardCharsets.UTF_8));
                    }
                    lyricWritten = true;
                }
            }
        } catch (Exception e) {
            call.reject("写 sidecar 失败", "WRITE_FAILED", e);
            return;
        }
        JSObject result = new JSObject();
        result.put("lyricWritten", lyricWritten);
        result.put("coverWritten", coverWritten);
        result.put("skipped", skipped);
        call.resolve(result);
    }

    // 封面下载（0.1.106 写回配套）：HttpBridge 的 body 是 UTF-8 文本，
    // 二进制图片走它会坏字节，所以下载放原生做（HttpURLConnection，
    // 纯 JDK，不新引依赖）：跟随跳转、15 秒超时、8MB 上限，回 base64
    // data URL；TS 侧拿它直接调 writeSidecar。
    @PluginMethod
    public void downloadCover(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("缺少封面链接", "NO_URL");
            return;
        }
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(15000);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty(
                "User-Agent",
                "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 "
                    + "(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
            );
            int status = conn.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) {
                call.reject("封面下载失败", "DOWNLOAD_FAILED");
                return;
            }
            String contentType = conn.getContentType();
            String mime = (contentType != null && contentType.startsWith("image/"))
                ? contentType.split(";")[0].trim()
                : "image/jpeg";
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            int total = 0;
            try (InputStream input = conn.getInputStream()) {
                while ((read = input.read(buffer)) != -1) {
                    total += read;
                    if (total > 8 * 1024 * 1024) {
                        call.reject("封面过大", "COVER_TOO_LARGE");
                        return;
                    }
                    output.write(buffer, 0, read);
                }
            }
            if (total == 0) {
                call.reject("封面下载失败", "DOWNLOAD_FAILED");
                return;
            }
            String base64 = Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP);
            JSObject result = new JSObject();
            result.put("dataUrl", "data:" + mime + ";base64," + base64);
            call.resolve(result);
        } catch (SecurityException e) {
            call.reject("缺少网络权限", "PERMISSION_DENIED", e);
        } catch (Exception e) {
            call.reject("封面下载失败", "DOWNLOAD_FAILED", e);
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
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
