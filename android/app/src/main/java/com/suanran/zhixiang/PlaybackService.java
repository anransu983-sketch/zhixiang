package com.suanran.zhixiang;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * 保活前台服务：播放开始时起，播放停止 / 队列播完时停。
 *
 * 全新写的最小服务，不抄任何旧服务实现：
 * - 常驻通知只有应用名 + 当前歌名，没有控制按钮（控制以后再说）。
 * - 点通知回应用：PendingIntent 指回 MainActivity（singleTask，回到原任务栈）。
 * - Android 13+ 通知权限缺失时不崩：仍尝试起前台服务，起失败只降级，
 *   不抛异常、不杀播放流程；通知由系统按权限情况处理。
 * - 前台服务类型 mediaPlayback（见 Manifest 声明），与音乐播放用途一致。
 */
public class PlaybackService extends Service {

    public static final String ACTION_START = "com.suanran.zhixiang.ACTION_START_PLAYBACK";
    public static final String ACTION_STOP = "com.suanran.zhixiang.ACTION_STOP_PLAYBACK";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_ARTIST = "artist";

    private static final String CHANNEL_ID = "zhixiang_playback";
    private static final int NOTIFICATION_ID = 1;

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
        String title = intent.getStringExtra(EXTRA_TITLE);
        String artist = intent.getStringExtra(EXTRA_ARTIST);
        Notification notification = buildNotification(title, artist);
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
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
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

    private Notification buildNotification(String title, String artist) {
        createChannel();
        Intent launch = new Intent(this, MainActivity.class);
        launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, launch, pendingFlags);

        String songTitle = title == null || title.isEmpty() ? "芷湘" : title;
        String text = artist == null || artist.isEmpty() ? "芷湘" : artist + " · 芷湘";

        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder = new Notification.Builder(this, CHANNEL_ID);
        } else {
            builder = new Notification.Builder(this);
        }
        return builder
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentTitle(songTitle)
                .setContentText(text)
                .setContentIntent(contentIntent)
                .setOngoing(true)
                .build();
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
