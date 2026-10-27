# 芷湘（全新重做版）

全新写的音乐应用，不 fork、不移植旧仓源码。

- 应用名：芷湘；包名：`com.suanran.zhixiang`
- 技术栈：Vite + TypeScript + Capacitor 8（Web UI + Android 壳）
- UI 只做中文；入口文件只组装

## 功能清单（冻结）

本地音乐、网易云、YTM；淡入淡出、后台保活（前台服务）；首页海报墙；3D 歌单架；
歌词动态壁纸（设为系统壁纸、跟随播放页、挖孔避让、停止后闲置）；雨滴玻璃（默认开）、
粒子舞台、节奏脉动、氛围星空（各项独立开关）。

0.1.85 新增：YTM 今日星荐改走 WEB_REMIX gl=US 取数；我的页新增主题衣橱
（波奇酱／夜之城·毛玻璃／夜之城·黄昏三套主题＋主题配色行）、雨窗（雨滴三档：
关／静态水滴／动态滑落）、轻装模式（性能开关）；底部胶囊磁吸悬浮导航；
听歌钥匙收起模块（两源登录收在模块内）；本地歌词封面网易云搜索匹配补源
（时长差超 10 秒不用同步词，封面照常用）。

不做：Spotify、QQ、酷狗、睡眠定时器、预加载、AI 主题、/api 中继、登录体系、命令面板。

## 命令

```sh
npm install
npm run typecheck   # tsc --noEmit
npm run build       # vite build -> dist/
npm run cap:sync    # build + cap sync android
node scripts/check-scope.mjs   # 范围门
```

本机无 Android SDK，gradle 打包留 CI 验。

## 签名

- 本地发布签名文件：`android/keystore.properties` 与 `android/zhixiang-release.jks`
  （共用固定证书，已 gitignore，不进仓库）。
- CI 发版时由 secret 恢复这两个文件：
  `ANDROID_KEYSTORE_BASE64` / `KEYSTORE_PASSWORD` / `KEY_ALIAS` / `KEY_PASSWORD`。
- 版本推导：versionName = package.json 版本；
  versionCode = major × 1000000 + minor × 1000 + patch（单调递增）。
- 正式发版：先本地提交升版，再手动 dispatch（bump=none）。

## 图标

`scripts/make-icon.py`：白猫照片放背景层、不抠图，脸落在中央安全区，
外围用照片模糊延伸补满；API 26+ 自适应图标，26 以下预合成方形与圆形版。
源图：`~/workspace/goals/app/hidden_files/zhixiang-icon-source.jpg`（不进仓库）。
