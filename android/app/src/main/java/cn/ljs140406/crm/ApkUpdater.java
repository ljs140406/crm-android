package cn.ljs140406.crm;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

/**
 * 应用内更新：用系统 DownloadManager 下载 APK 并自动拉起安装器。
 *
 * 为什么必须走原生 DownloadManager（历史踩坑记录，勿回退）：
 *  1) Capacitor Filesystem 的 Directory 枚举里【没有 DOWNLOADS】（只有 DOCUMENTS/DATA/LIBRARY/
 *     CACHE/EXTERNAL/EXTERNAL_STORAGE）。传 'DOWNLOADS' 是非法值，原生 getDirectory() 返回 null，
 *     writeFile 直接 reject。
 *  2) 退到 DOCUMENTS 也不行：Android 10+ 公共 Documents 目录需要 publicStorage 运行时权限。
 *  3) 再退到 JS 的 blob: + <a download>：Capacitor WebView 没有 DownloadListener，下载被静默丢弃，
 *     结果是「提示下载完成，但文件根本没落盘、也没有安装弹窗」。
 *  4) 退到 openExternal(下载直链) 会被 Gitee 的 Content-Type: application/zip 污染成 .apk.zip。
 *
 * DownloadManager 同时解决：公共「下载」目录可见、系统通知带进度、完成后可点击安装、
 * 无需把整个 APK 经 JS 桥转成 base64。
 *
 * 目录策略（避免任何运行时权限弹窗）：
 *  · API >= 29：写公共 Downloads（setDestinationInExternalPublicDir），用户在「文件/下载」里能找到。
 *  · API <= 28：写应用外部私有目录（setDestinationInExternalFilesDir），免 WRITE_EXTERNAL_STORAGE。
 */
@CapacitorPlugin(name = "ApkUpdater")
public class ApkUpdater extends Plugin {

    private static final String MIME_APK = "application/vnd.android.package-archive";
    private static final long POLL_MS = 700L;

    private long downloadId = -1L;
    private boolean installFired = false;
    private Uri pendingInstallUri = null;
    private BroadcastReceiver completeReceiver = null;
    private Handler poller = null;
    private Runnable pollTask = null;

    private DownloadManager dm() {
        return (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
    }

    // ------------------------------------------------------------------
    // JS: ApkUpdater.download({ url, fileName })
    // ------------------------------------------------------------------
    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        String fileName = call.getString("fileName");
        if (url == null || url.trim().isEmpty()) {
            call.reject("缺少下载地址");
            return;
        }
        if (fileName == null || fileName.trim().isEmpty()) {
            fileName = "update.apk";
        }
        if (!fileName.toLowerCase().endsWith(".apk")) {
            fileName = fileName + ".apk";
        }

        try {
            cleanup();
            installFired = false;

            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            req.setTitle(fileName);
            req.setDescription("正在下载新版本安装包");
            // 强制正确的 MIME，避免服务器返回 application/zip 时被补成 .apk.zip
            req.setMimeType(MIME_APK);
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setAllowedOverMetered(true);
            req.setAllowedOverRoaming(true);

            boolean publicDir = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q;
            if (publicDir) {
                // Android 10+：公共「下载」目录，无需存储权限，用户可见
                req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
            } else {
                // Android 6~9：应用外部私有目录，免 WRITE_EXTERNAL_STORAGE 运行时权限
                req.setDestinationInExternalFilesDir(getContext(), Environment.DIRECTORY_DOWNLOADS, fileName);
            }

            downloadId = dm().enqueue(req);

            registerCompleteReceiver();
            startPolling();

            JSObject ret = new JSObject();
            ret.put("id", downloadId);
            ret.put("fileName", fileName);
            ret.put("publicDownloads", publicDir);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("启动下载失败：" + e.getMessage(), e);
        }
    }

    // ------------------------------------------------------------------
    // JS: ApkUpdater.install()  —— 手动重试安装（如用户刚授权「安装未知应用」）
    // ------------------------------------------------------------------
    @PluginMethod
    public void install(PluginCall call) {
        if (pendingInstallUri != null) {
            launchInstall(pendingInstallUri);
            call.resolve();
            return;
        }
        if (downloadId > 0) {
            installFired = false;
            installApk(downloadId);
            call.resolve();
            return;
        }
        call.reject("没有待安装的安装包");
    }

    // ------------------------------------------------------------------
    // JS: ApkUpdater.canInstall()  —— 查询是否已允许安装未知来源应用
    // ------------------------------------------------------------------
    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", hasInstallPermission());
        call.resolve(ret);
    }

    // ------------------------------------------------------------------
    // 下载完成广播（部分 ROM 可能不下发，故与轮询双保险）
    // ------------------------------------------------------------------
    private void registerCompleteReceiver() {
        completeReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L);
                if (id == downloadId) {
                    installApk(id);
                }
            }
        };
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        // targetSdk 34+ 注册系统广播必须显式声明导出标志，否则运行时抛 SecurityException。
        // 只用框架 API 分支（不依赖 androidx.core 版本是否带 4 参 registerReceiver）。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getContext().registerReceiver(completeReceiver, filter, Context.RECEIVER_EXPORTED);
        } else {
            getContext().registerReceiver(completeReceiver, filter);
        }
    }

    // ------------------------------------------------------------------
    // 进度轮询：同时负责把进度推给 JS，以及兜底触发安装
    // ------------------------------------------------------------------
    private void startPolling() {
        poller = new Handler(Looper.getMainLooper());
        pollTask = new Runnable() {
            @Override
            public void run() {
                boolean keepGoing = pollOnce();
                if (keepGoing && poller != null) {
                    poller.postDelayed(this, POLL_MS);
                }
            }
        };
        poller.postDelayed(pollTask, POLL_MS);
    }

    private boolean pollOnce() {
        if (downloadId <= 0) return false;
        Cursor c = null;
        try {
            c = dm().query(new DownloadManager.Query().setFilterById(downloadId));
            if (c == null || !c.moveToFirst()) return false;

            int status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            long soFar = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
            long total = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));

            JSObject ev = new JSObject();
            ev.put("bytes", soFar);
            ev.put("total", total);
            ev.put("percent", total > 0 ? (int) (soFar * 100L / total) : -1);

            if (status == DownloadManager.STATUS_SUCCESSFUL) {
                ev.put("status", "success");
                notifyListeners("apkProgress", ev);
                installApk(downloadId);
                return false;
            }
            if (status == DownloadManager.STATUS_FAILED) {
                int reason = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
                ev.put("status", "failed");
                ev.put("reason", reason);
                notifyListeners("apkProgress", ev);
                return false;
            }
            ev.put("status", status == DownloadManager.STATUS_PAUSED ? "paused" : "running");
            notifyListeners("apkProgress", ev);
            return true;
        } catch (Exception e) {
            return false;
        } finally {
            if (c != null) {
                try { c.close(); } catch (Exception ignored) {}
            }
        }
    }

    // ------------------------------------------------------------------
    // 解析已下载文件并拉起安装
    // ------------------------------------------------------------------
    private void installApk(long id) {
        if (installFired) return;
        installFired = true;

        Uri uri = null;
        String localPath = null;

        // 首选 DownloadManager 提供的 content:// URI —— Android 10+ 公共目录下
        // 应用无法直接按原始文件路径读取，只有该 URI 可靠且可授权给安装器
        try {
            uri = dm().getUriForDownloadedFile(id);
        } catch (Exception ignored) {}

        // 取真实路径，供 JS 提示用户「文件在哪」
        Cursor c = null;
        try {
            c = dm().query(new DownloadManager.Query().setFilterById(id));
            if (c != null && c.moveToFirst()) {
                String local = c.getString(c.getColumnIndexOrThrow(DownloadManager.COLUMN_LOCAL_URI));
                if (local != null) {
                    Uri lu = Uri.parse(local);
                    localPath = "file".equals(lu.getScheme()) ? lu.getPath() : local;
                    if (uri == null) uri = lu;
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (c != null) {
                try { c.close(); } catch (Exception ignored) {}
            }
        }

        // 老系统会拿到 file:// —— Android 7+ 不允许直接传给安装器，必须包成 FileProvider content://
        if (uri != null && "file".equals(uri.getScheme())) {
            try {
                File f = new File(uri.getPath());
                uri = FileProvider.getUriForFile(
                    getContext(),
                    getContext().getPackageName() + ".fileprovider",
                    f
                );
            } catch (Exception ignored) {}
        }

        JSObject done = new JSObject();
        done.put("path", localPath == null ? "" : localPath);
        done.put("uri", uri == null ? "" : uri.toString());
        notifyListeners("apkDownloaded", done);

        if (uri == null) {
            JSObject err = new JSObject();
            err.put("message", "下载完成但无法定位安装包");
            notifyListeners("apkInstallError", err);
            return;
        }
        launchInstall(uri);
    }

    private boolean hasInstallPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        try {
            return getContext().getPackageManager().canRequestPackageInstalls();
        } catch (Exception e) {
            return false;
        }
    }

    private void launchInstall(Uri uri) {
        // Android 8+ 未授权「安装未知应用」时，先把用户送到授权页；授权返回后 handleOnResume 自动重试
        if (!hasInstallPermission()) {
            pendingInstallUri = uri;
            JSObject ev = new JSObject();
            ev.put("uri", uri.toString());
            notifyListeners("apkNeedInstallPermission", ev);
            try {
                Intent s = new Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName())
                );
                s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(s);
            } catch (Exception ignored) {}
            return;
        }

        try {
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, MIME_APK);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getContext().startActivity(i);
            pendingInstallUri = null;
            notifyListeners("apkInstallLaunched", new JSObject());
        } catch (Exception e) {
            pendingInstallUri = uri;
            JSObject err = new JSObject();
            err.put("message", e.getMessage() == null ? "无法打开安装器" : e.getMessage());
            notifyListeners("apkInstallError", err);
        }
    }

    // ------------------------------------------------------------------
    // 生命周期
    // ------------------------------------------------------------------
    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (pendingInstallUri != null && hasInstallPermission()) {
            Uri u = pendingInstallUri;
            pendingInstallUri = null;
            launchInstall(u);
        }
    }

    @Override
    protected void handleOnDestroy() {
        cleanup();
        super.handleOnDestroy();
    }

    private void cleanup() {
        if (poller != null && pollTask != null) {
            poller.removeCallbacks(pollTask);
        }
        poller = null;
        pollTask = null;
        if (completeReceiver != null) {
            try { getContext().unregisterReceiver(completeReceiver); } catch (Exception ignored) {}
            completeReceiver = null;
        }
    }
}
