package com.suanran.zhixiang;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * 应用内更新插件（全新写）：把 GitHub Release 上的新版 APK 下到缓存目录，
 * 再经 FileProvider 调起系统安装器。公开仓库直下，不需要任何令牌。
 *
 * 方法对应 Web 层 src/native/update-plugin.ts：
 * - download：{url, version} → 下到 cacheDir/updates/zhixiang-<version>.apk，
 *   下载过程经 progress 事件报 {loaded, total, percent}（total 未知时
 *   percent 为 -1）；下完先校验（存在、长度 > 1MB、文件头是 PK）才算成功，
 *   校验不过删文件并 reject（DOWNLOAD_INVALID）。
 * - install：{path} → 先查「安装未知应用」权限，没给时 reject 并带固定
 *   code NEED_INSTALL_PERMISSION，Web 层据此引导用户去开权限；给了才用
 *   FileProvider 拼 uri 发 ACTION_VIEW 安装 intent。
 * - openInstallSettings：打开本应用的「安装未知应用」设置页。
 *
 * 约定：所有 reject 都带中文 message 与 code，不抛裸错（与 HttpBridge 同口径）。
 * 下载在新线程上跑同步 OkHttp 调用，不堵桥线程；进度事件约每 200ms
 * 或每 256KB 报一次，避免高频事件把 Web 层冲垮。
 *
 * 注册方式：与其它本地插件一致，放在应用源码里，由 MainActivity 在
 * 桥接创建前显式注册；清单里另需 REQUEST_INSTALL_PACKAGES 权限。
 */
@CapacitorPlugin(name = "Update")
public class UpdatePlugin extends Plugin {

    private static final long MIN_APK_BYTES = 1024L * 1024L;
    private static final long PROGRESS_STEP_BYTES = 256L * 1024L;
    private static final long PROGRESS_STEP_MS = 200L;

    private static final OkHttpClient CLIENT = new OkHttpClient.Builder()
            .followRedirects(true)
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .build();

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        String version = call.getString("version");
        if (url == null || url.isEmpty()) {
            call.reject("缺少下载地址", "URL_REQUIRED");
            return;
        }
        if (version == null || version.isEmpty()) {
            call.reject("缺少版本号", "VERSION_REQUIRED");
            return;
        }
        Context context = getContext();
        if (context == null) {
            call.reject("系统服务不可用", "NO_CONTEXT");
            return;
        }
        // 版本号来自 Release 的 tag，本应只有数字与点；仍剥掉路径分隔符，
        // 免得拼出来的文件名逃出 updates 目录。
        String safeVersion = version.replaceAll("[^A-Za-z0-9._-]", "_");
        File dir = new File(context.getCacheDir(), "updates");
        File target = new File(dir, "zhixiang-" + safeVersion + ".apk");
        call.setKeepAlive(true);
        new Thread(() -> doDownload(call, url, dir, target)).start();
    }

    private void doDownload(PluginCall call, String url, File dir, File target) {
        try {
            if (!dir.exists() && !dir.mkdirs()) {
                call.reject("缓存目录创建失败，无法下载更新", "CACHE_DIR_FAILED");
                return;
            }
            if (target.exists() && !target.delete()) {
                call.reject("旧安装包删除失败，无法下载更新", "CACHE_DIR_FAILED");
                return;
            }
            Request request = new Request.Builder().url(url).build();
            try (Response response = CLIENT.newCall(request).execute()) {
                if (!response.isSuccessful()) {
                    call.reject("下载失败，服务器返回 " + response.code() + "，请稍后重试", "DOWNLOAD_HTTP");
                    return;
                }
                ResponseBody body = response.body();
                if (body == null) {
                    call.reject("下载失败，服务器没有返回文件内容", "DOWNLOAD_EMPTY");
                    return;
                }
                long total = body.contentLength();
                long loaded = 0L;
                long lastNotifyBytes = 0L;
                long lastNotifyAt = System.currentTimeMillis();
                try (InputStream in = body.byteStream();
                     FileOutputStream out = new FileOutputStream(target)) {
                    byte[] buffer = new byte[8192];
                    int read;
                    while ((read = in.read(buffer)) != -1) {
                        out.write(buffer, 0, read);
                        loaded += read;
                        long now = System.currentTimeMillis();
                        if (loaded - lastNotifyBytes >= PROGRESS_STEP_BYTES
                                || now - lastNotifyAt >= PROGRESS_STEP_MS) {
                            lastNotifyBytes = loaded;
                            lastNotifyAt = now;
                            notifyProgress(loaded, total);
                        }
                    }
                    out.flush();
                }
                notifyProgress(loaded, total);
            }
            if (!isValidApk(target)) {
                // 校验不过的文件留着只会让安装器报错，先删掉再 reject。
                if (target.exists()) {
                    target.delete();
                }
                call.reject("下载到的文件不完整或不是安装包，已删除，请重试", "DOWNLOAD_INVALID");
                return;
            }
            JSObject ret = new JSObject();
            ret.put("path", target.getAbsolutePath());
            ret.put("size", target.length());
            call.resolve(ret);
        } catch (IllegalArgumentException e) {
            call.reject("下载地址不合法", "INVALID_URL", e);
        } catch (IOException e) {
            if (target.exists()) {
                target.delete();
            }
            call.reject("下载失败，请检查网络后重试", "DOWNLOAD_FAILED", e);
        } catch (Exception e) {
            call.reject("下载失败，请稍后重试", "DOWNLOAD_FAILED", e);
        }
    }

    private void notifyProgress(long loaded, long total) {
        JSObject event = new JSObject();
        event.put("loaded", loaded);
        event.put("total", total);
        event.put("percent", total > 0 ? (int) (loaded * 100L / total) : -1);
        notifyListeners("progress", event);
    }

    /** 安装包最低校验：存在、长度过 1MB、头两字节是 ZIP 的 PK 标记。 */
    private boolean isValidApk(File file) {
        if (file == null || !file.exists() || file.length() <= MIN_APK_BYTES) {
            return false;
        }
        try (FileInputStream in = new FileInputStream(file)) {
            return in.read() == 'P' && in.read() == 'K';
        } catch (IOException e) {
            return false;
        }
    }

    @PluginMethod
    public void install(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) {
            call.reject("缺少安装包路径，请重新下载", "PATH_REQUIRED");
            return;
        }
        Context context = getContext();
        if (context == null) {
            call.reject("系统服务不可用", "NO_CONTEXT");
            return;
        }
        File file = new File(path);
        if (!file.exists()) {
            call.reject("安装包文件不存在，请重新下载", "FILE_NOT_FOUND");
            return;
        }
        // Android 8 起安装未知应用是按应用单独授权的：没给时不能硬调安装器
        // （只会被系统拦下），用固定 code 让 Web 层走引导路径。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !context.getPackageManager().canRequestPackageInstalls()) {
            call.reject("需要先允许芷湘安装未知应用：点「去开启安装权限」，在设置里打开开关，回来再点「继续安装」",
                    "NEED_INSTALL_PERMISSION");
            return;
        }
        try {
            Uri uri = FileProvider.getUriForFile(
                    context, context.getPackageName() + ".fileprovider", file);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
            JSObject ret = new JSObject();
            ret.put("launched", true);
            call.resolve(ret);
        } catch (ActivityNotFoundException e) {
            call.reject("系统里没有能打开安装包的应用", "NO_INSTALLER", e);
        } catch (SecurityException e) {
            call.reject("系统不允许调起安装器，请在设置里允许芷湘安装未知应用后再试", "INSTALL_BLOCKED", e);
        } catch (Exception e) {
            call.reject("调起安装器失败，请稍后重试", "INSTALL_FAILED", e);
        }
    }

    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        Context context = getContext();
        if (context == null) {
            call.reject("系统服务不可用", "NO_CONTEXT");
            return;
        }
        try {
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
            intent.setData(Uri.parse("package:" + context.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
            JSObject ret = new JSObject();
            ret.put("opened", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("打开安装权限设置失败，请到系统设置的应用管理里手动允许", "SETTINGS_FAILED", e);
        }
    }
}
