# 客户跟进管理 - 安卓 App（Capacitor）

个人 CRM 工具的安卓封装版，基于 **Capacitor 7**，把单文件网页版（`crm-app-mobile.html`）
包成独立安卓 App。数据存于 App 私有存储（清浏览器缓存不会丢），支持「通知型」版本更新。

## 与桌面端 / PWA 的关系

三端共用同一份源 HTML（`E:\分贝通资料\测试的\crm-app-mobile.html`）：
- **PWA**（手机网页版）：浏览器存储，清「网站数据」会丢。
- **桌面端**（Electron）：独立 userData，与浏览器隔离。
- **安卓 App**（本项目）：App 私有目录，与浏览器、其他 App 均隔离，最稳。

## 构建与发布（发生在 GitHub Actions，无需本机装 Android SDK）

1. 改源 HTML（`crm-app-mobile.html`）后，跑 `node sync-www.js` 同步到 `www/index.html`。
2. 在 GitHub 仓库 **Actions → Build Android APK → Run workflow**，填入版本号（如 `1.2.0`）与更新说明。
3. Actions 会自动：`cap sync android` → 注入版本号 → 用仓库 Secret 里的 keystore 签名 →
   生成 `crm-android-x.y.z.apk` → 发布到 GitHub Releases。
4. 已安装的 App 启动时静默检查 Releases，有新版本弹窗引导到浏览器下载覆盖安装。

## 目录结构

- `sync-www.js`          把源 HTML 适配为 `www/index.html`（关 SW / 去 PWA 标签 / 注入更新脚本）
- `www/index.html`        应用页面
- `www/android-update.js`  通知型更新检查 + 安卓返回键处理
- `capacitor.config.json`  Capacitor 配置（appId: `cn.ljs140406.crm`）
- `android/`               原生安卓工程（由 `cap add android` 生成，构建时 `cap sync` 更新）
- `resources/`             图标与启动图源文件
- `.github/workflows/build-android.yml`  CI 构建签名发布流程

## 签名与密钥

发布签名 keystore 由 CI Secret（`KEYSTORE_BASE64` 等）提供，**不入库**。
本地如需调试，`www/` 可直接用浏览器打开预览（此时 `android-update.js` 自动降级为开发态）。
