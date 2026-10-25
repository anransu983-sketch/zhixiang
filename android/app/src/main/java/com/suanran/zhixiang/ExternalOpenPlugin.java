package com.suanran.zhixiang;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 外部打开插件（全新写）：给一个 https 链接发 ACTION_VIEW intent，
 * 让系统去解析——若网易云 App 声明了该域名的 App Link，就会直接进 App
 * 的确认页，不用相机扫码、不用切屏，15–20 秒的短命码也够用。
 * 没有应用可处理时 resolve 成 handled:false，不抛错，调用方按“只能扫码”处理。
 */
@CapacitorPlugin(name = "ExternalOpen")
public class ExternalOpenPlugin extends Plugin {

    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url", "");
        JSObject ret = new JSObject();
        if (url == null || url.isEmpty() || getActivity() == null) {
            ret.put("handled", false);
            call.resolve(ret);
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(intent);
            ret.put("handled", true);
        } catch (ActivityNotFoundException e) {
            ret.put("handled", false);
        }
        call.resolve(ret);
    }
}
