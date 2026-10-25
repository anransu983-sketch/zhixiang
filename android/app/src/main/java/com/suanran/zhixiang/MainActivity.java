package com.suanran.zhixiang;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // 本地插件在应用源码内，不进 cap sync 的插件清单，
        // 必须在桥接创建前注册，否则 Web 层调不到它。
        registerPlugin(LocalMusicPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
