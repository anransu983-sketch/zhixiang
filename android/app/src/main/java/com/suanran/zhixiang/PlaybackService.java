package com.suanran.zhixiang;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ContentUris;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import android.util.Size;

import androidx.core.app.NotificationCompat;
import androidx.media.app.NotificationCompat.MediaStyle;
import androidx.media.session.MediaButtonReceiver;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 保活前台服务：播放开始时起，播放停止 / 队列播完时停。
 *
 * 0.1.52 起挂原生 MediaSession（WebView 不支持 Media Session Web API，
 * JS 侧 navigator.mediaSession 到不了三星系统播放卡，只能走原生）：
 * - 会话建在服务里，随服务生死；有曲目时 active + 媒体样式通知（上一首 /
 *   播放或暂停 / 下一首 + 封面），系统播放卡、锁屏、耳机线控都走它。
 * - 通知永远只有一个（NOTIFICATION_ID = 1）：有曲目时媒体样式，无曲目时
 *   回落到原来的纯文本通知，保活语义不变。
 * - 耳机与通知按钮不直接碰播放逻辑：会话回调只经 PlaybackPlugin 发
 *   mediaAction 事件，JS 侧按逻辑状态幂等处理（play 时已在播则不动）。
 * - 封面：本地传 albumId，原生 loadThumbnail 取 512px 缩略图（API 29+，
 *   以下跳过）；远程下载后压到 512px 内并落盘缓存，不走 data URL 往返。
 * - 曲目一换，旧封面加载任务凭世代号作废，不盖新曲的图。
 */
public class PlaybackService extends Service {

    public static final String ACTION_START = "com.suanran.zhixiang.ACTION_START_PLAYBACK";
    public static final String ACTION_STOP = "com.suanran.zhixiang.ACTION_STOP_PLAYBACK";
    public static final String ACTION_SET_MEDIA = "com.suanran.zhixiang.ACTION_SET_MEDIA";
    public static final String ACTION_SET_PLAYING = "com.suanran.zhixiang.ACTION_SET_PLAYING";
    public static final String ACTION_CLEAR_MEDIA = "com.suanran.zhixiang.ACTION_CLEAR_MEDIA";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_ARTIST = "artist";
    public static final String EXTRA_ALBUM = "album";
    public static final String EXTRA_COVER_URL = "coverUrl";
    public static final String EXTRA_ALBUM_ID = "albumId";
    public static final String EXTRA_PLAYING = "playing";

    private static final String CHANNEL_ID = "zhixiang_playback";
    private static final int NOTIFICATION_ID = 1;
    private static final int ARTWORK_MAX_PX = 512;

    private MediaSessionCompat session;
    private ExecutorService artworkExecutor;
    private Handler mainHandler;

    private String title = "";
    private String artist = "";
    private String album = "";
    private boolean hasMedia = false;
    private boolean playing = false;
    private Bitmap artwork;
    private int artworkGeneration = 0;

    @Override
    public void onCreate() {
        super.onCreate();
        mainHandler = new Handler(Looper.getMainLooper());
        artworkExecutor = Executors.newSingleThreadExecutor();
        session = new MediaSessionCompat(this, "Zhixiang");
        session.setFlags(MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS
                | MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS);
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override
            public void onPlay() {
                PlaybackPlugin.emitMediaAction("play");
            }

            @Override
            public void onPause() {
                PlaybackPlugin.emitMediaAction("pause");
            }

            @Override
            public void onSkipToNext() {
                PlaybackPlugin.emitMediaAction("next");
            }

            @Override
            public void onSkipToPrevious() {
                PlaybackPlugin.emitMediaAction("previous");
            }

            @Override
            public void onStop() {
                // 没有 stop 语义：停当暂停处理，JS 侧按逻辑状态幂等。
                PlaybackPlugin.emitMediaAction("pause");
            }
        });
        Intent receiverIntent = new Intent(Intent.ACTION_MEDIA_BUTTON);
        receiverIntent.setClass(this, MediaButtonReceiver.class);
        int receiverFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            receiverFlags |= PendingIntent.FLAG_IMMUTABLE;
        }
        session.setMediaButtonReceiver(
                PendingIntent.getBroadcast(this, 0, receiverIntent, receiverFlags));
        session.setActive(false);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            return START_STICKY;
        }
        String action = intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopForegroundCompat();
            stopSelf();
            return START_NOT_STICKY;
        }
        if (Intent.ACTION_MEDIA_BUTTON.equals(action)) {
            // 清单里的 MediaButtonReceiver 查到本服务（MEDIA_BUTTON
            // intent-filter）后起服务并把按键 intent 转交过来；会话回调
            // 再经插件发给 JS，状态变化由 JS 同步回写。
            if (session != null) {
                MediaButtonReceiver.handleIntent(session, intent);
            }
            if (hasMedia) {
                renderNotification();
            } else {
                // 无曲目：按键无事可做，直接停，不留空通知；起前台
                // 服务的时限内 stopSelf 不触发超时异常。
                stopSelf();
            }
            return START_STICKY;
        }
        if (ACTION_SET_MEDIA.equals(action)) {
            title = stringExtra(intent, EXTRA_TITLE);
            artist = stringExtra(intent, EXTRA_ARTIST);
            album = stringExtra(intent, EXTRA_ALBUM);
            String coverUrl = stringExtra(intent, EXTRA_COVER_URL);
            long albumId = intent.getLongExtra(EXTRA_ALBUM_ID, -1);
            hasMedia = true;
            artwork = null;
            artworkGeneration++;
            renderNotification();
            loadArtworkAsync(artworkGeneration, albumId, coverUrl);
            return START_STICKY;
        }
        if (ACTION_SET_PLAYING.equals(action)) {
            playing = intent.getBooleanExtra(EXTRA_PLAYING, false);
            renderNotification();
            return START_STICKY;
        }
        if (ACTION_CLEAR_MEDIA.equals(action)) {
            hasMedia = false;
            artwork = null;
            artworkGeneration++;
            if (session != null) {
                session.setActive(false);
                session.setPlaybackState(new PlaybackStateCompat.Builder()
                        .setActions(0)
                        .setState(PlaybackStateCompat.STATE_NONE,
                                PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN, 1.0f)
                        .build());
            }
            renderNotification();
            return START_STICKY;
        }
        // ACTION_START 与其它：只更新标题/歌手，不动会话与封面——
        // 若曲目已同步，仍渲染媒体样式，不会被纯文本盖回去。
        title = stringExtra(intent, EXTRA_TITLE);
        artist = stringExtra(intent, EXTRA_ARTIST);
        renderNotification();
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        if (session != null) {
            session.setActive(false);
            session.release();
            session = null;
        }
        if (artworkExecutor != null) {
            artworkExecutor.shutdownNow();
            artworkExecutor = null;
        }
        stopForegroundCompat();
        super.onDestroy();
    }

    private void stopForegroundCompat() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(Service.STOP_FOREGROUND_REMOVE);
            } else {
                stopForeground(true);
            }
        } catch (Exception e) {
            // 停止时异常不影响调用方。
        }
    }

    private String stringExtra(Intent intent, String key) {
        String value = intent.getStringExtra(key);
        return value == null ? "" : value;
    }

    private PendingIntent contentIntent() {
        Intent launch = new Intent(this, MainActivity.class);
        launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getActivity(this, 0, launch, pendingFlags);
    }

    /** 唯一通知入口：有曲目走媒体样式，无曲目走原来的纯文本样式。 */
    private void renderNotification() {
        createChannel();
        String songTitle = title.isEmpty() ? "芷湘" : title;
        String text = artist.isEmpty() ? "芷湘" : artist + " · 芷湘";
        Notification notification;
        if (hasMedia && session != null) {
            MediaMetadataCompat.Builder metadata = new MediaMetadataCompat.Builder()
                    .putString(MediaMetadataCompat.METADATA_KEY_TITLE, songTitle)
                    .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist);
            if (!album.isEmpty()) {
                metadata.putString(MediaMetadataCompat.METADATA_KEY_ALBUM, album);
            }
            if (artwork != null) {
                metadata.putBitmap(MediaMetadataCompat.METADATA_KEY_ART, artwork);
            }
            session.setMetadata(metadata.build());
            session.setActive(true);
            int state = playing
                    ? PlaybackStateCompat.STATE_PLAYING
                    : PlaybackStateCompat.STATE_PAUSED;
            session.setPlaybackState(new PlaybackStateCompat.Builder()
                    .setActions(PlaybackStateCompat.ACTION_PLAY
                            | PlaybackStateCompat.ACTION_PAUSE
                            | PlaybackStateCompat.ACTION_PLAY_PAUSE
                            | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
                            | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS)
                    .setState(state, PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN, 1.0f)
                    .build());
            int playPauseIcon = playing
                    ? android.R.drawable.ic_media_pause
                    : android.R.drawable.ic_media_play;
            NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.ic_media_play)
                    .setContentTitle(songTitle)
                    .setContentText(text)
                    .setContentIntent(contentIntent())
                    .setOngoing(true)
                    .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                    .addAction(new NotificationCompat.Action(
                            android.R.drawable.ic_media_previous, "上一首",
                            MediaButtonReceiver.buildMediaButtonPendingIntent(
                                    this, PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS)))
                    .addAction(new NotificationCompat.Action(
                            playPauseIcon, "播放或暂停",
                            MediaButtonReceiver.buildMediaButtonPendingIntent(
                                    this, PlaybackStateCompat.ACTION_PLAY_PAUSE)))
                    .addAction(new NotificationCompat.Action(
                            android.R.drawable.ic_media_next, "下一首",
                            MediaButtonReceiver.buildMediaButtonPendingIntent(
                                    this, PlaybackStateCompat.ACTION_SKIP_TO_NEXT)))
                    .setStyle(new MediaStyle()
                            .setMediaSession(session.getSessionToken())
                            .setShowActionsInCompactView(0, 1, 2));
            if (artwork != null) {
                builder.setLargeIcon(artwork);
            }
            notification = builder.build();
        } else {
            if (session != null) {
                session.setActive(false);
                session.setPlaybackState(new PlaybackStateCompat.Builder()
                        .setActions(0)
                        .setState(PlaybackStateCompat.STATE_NONE,
                                PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN, 1.0f)
                        .build());
            }
            Notification.Builder builder;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                builder = new Notification.Builder(this, CHANNEL_ID);
            } else {
                builder = new Notification.Builder(this);
            }
            notification = builder
                    .setSmallIcon(android.R.drawable.ic_media_play)
                    .setContentTitle(songTitle)
                    .setContentText(text)
                    .setContentIntent(contentIntent())
                    .setOngoing(true)
                    .build();
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                        NOTIFICATION_ID,
                        notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (Exception e) {
            // 降级：通知权限缺失或后台启动受限时不崩，服务继续以普通服务存在，
            // 播放本身不受影响，只是系统可能在资源紧张时回收进程。
        }
    }

    private void loadArtworkAsync(final int generation, final long albumId, final String coverUrl) {
        if (artworkExecutor == null) {
            return;
        }
        artworkExecutor.execute(new Runnable() {
            @Override
            public void run() {
                Bitmap bitmap = null;
                try {
                    if (albumId >= 0) {
                        bitmap = loadLocalArtwork(albumId);
                    } else if (coverUrl != null && coverUrl.startsWith("http")) {
                        bitmap = loadRemoteArtwork(coverUrl);
                    }
                } catch (Exception e) {
                    bitmap = null;
                }
                final Bitmap ready = bitmap;
                mainHandler.post(new Runnable() {
                    @Override
                    public void run() {
                        if (generation != artworkGeneration) {
                            return;
                        }
                        artwork = ready;
                        if (hasMedia) {
                            renderNotification();
                        }
                    }
                });
            }
        });
    }

    /** 本地封面：MediaStore albumart 缩略图，压到 512px 内；API 29 以下跳过。 */
    private Bitmap loadLocalArtwork(long albumId) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return null;
        }
        Uri uri = ContentUris.withAppendedId(
                Uri.parse("content://media/external/audio/albumart"), albumId);
        try {
            return getContentResolver().loadThumbnail(uri, new Size(ARTWORK_MAX_PX, ARTWORK_MAX_PX), null);
        } catch (Exception e) {
            return null;
        }
    }

    /** 远程封面：先读盘缓存， miss 再下载，统一压到 512px 内。 */
    private Bitmap loadRemoteArtwork(String coverUrl) {
        File dir = new File(getCacheDir(), "zhixiang-artwork");
        if (!dir.exists()) {
            dir.mkdirs();
        }
        File cached = new File(dir, md5Hex(coverUrl) + ".bin");
        byte[] bytes = null;
        if (cached.exists()) {
            bytes = readFile(cached);
        }
        if (bytes == null) {
            bytes = download(coverUrl);
            if (bytes != null) {
                writeFile(cached, bytes);
            }
        }
        if (bytes == null) {
            return null;
        }
        return decodeDownscaled(bytes);
    }

    private byte[] download(String coverUrl) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(coverUrl).openConnection();
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(8000);
            connection.setInstanceFollowRedirects(true);
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) {
                return null;
            }
            InputStream input = connection.getInputStream();
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            int total = 0;
            while ((read = input.read(buffer)) != -1) {
                total += read;
                if (total > 8 * 1024 * 1024) {
                    return null;
                }
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        } catch (Exception e) {
            return null;
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private Bitmap decodeDownscaled(byte[] bytes) {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            return null;
        }
        int sample = 1;
        while (bounds.outWidth / sample > ARTWORK_MAX_PX
                || bounds.outHeight / sample > ARTWORK_MAX_PX) {
            sample *= 2;
        }
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = sample;
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
    }

    private byte[] readFile(File file) {
        try {
            FileInputStream input = new FileInputStream(file);
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
            input.close();
            return output.toByteArray();
        } catch (Exception e) {
            return null;
        }
    }

    private void writeFile(File file, byte[] bytes) {
        try {
            FileOutputStream output = new FileOutputStream(file);
            output.write(bytes);
            output.close();
        } catch (Exception e) {
            // 缓存写失败不影响本次封面。
        }
    }

    private String md5Hex(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("MD5");
            byte[] hash = digest.digest(value.getBytes("UTF-8"));
            StringBuilder hex = new StringBuilder();
            for (byte b : hash) {
                hex.append(String.format("%02x", b));
            }
            return hex.toString();
        } catch (Exception e) {
            return String.valueOf(value.hashCode());
        }
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            return;
        }
        if (manager.getNotificationChannel(CHANNEL_ID) != null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "正在播放",
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("显示当前正在播放的歌曲");
        manager.createNotificationChannel(channel);
    }
}
