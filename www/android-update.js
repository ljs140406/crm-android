/*!
 * 安卓壳增强脚本（只在 Capacitor App 内生效，网页/桌面端不加载此文件）
 *
 *  1) 通知型版本更新：拉 GitHub Releases 最新版，比对版本号，有新版就弹窗引导下载 APK
 *  2) 侧边栏底部显示当前版本号 + 「检查更新」入口
 *  3) 安卓物理返回键：优先关闭浮层 → 再按一次退出（避免误退出丢失编辑）
 *
 * 本文件不依赖源 HTML 的任何 CSS，样式全部内联，确保跟主程序零冲突。
 */
(function () {
    'use strict';

    // ---------------------------------------------------------------
    // 配置
    // ---------------------------------------------------------------
    // __APP_VERSION__ 会在 GitHub Actions 构建时被替换成真实版本号
    var APP_VERSION = '__APP_VERSION__';
    // 注意：GitHub 与 Gitee 的 owner 不同（GitHub=ljs140406，Gitee=lij140406），
    // 勿复用同一个 REPO 变量——曾因复用导致 Gitee 检查 URL 404、更新永远只走 GitHub。
    var REPO = 'ljs140406/crm-android';        // GitHub（兜底源）
    var GITEE_REPO = 'lij140406/crm-android';  // Gitee（国内快速源，优先）
    // 双源检查：GitHub 兜底，Gitee 下载更快（国内）
    var API_LATEST_GITHUB = 'https://api.github.com/repos/' + REPO + '/releases/latest';
    var API_LATEST_GITEE = 'https://gitee.com/api/v5/repos/' + GITEE_REPO + '/releases/latest';
    var SKIP_KEY = 'crm_android_skip_version';
    var LAST_CHECK_KEY = 'crm_android_last_check';
    var AUTO_CHECK_INTERVAL = 6 * 60 * 60 * 1000; // 自动检查最多 6 小时一次

    if (APP_VERSION.indexOf('__') === 0) {
        // 未经 CI 替换（本地直接打开 www/index.html 调试时），降级为开发态
        APP_VERSION = '0.0.0-dev';
    }

    // ---------------------------------------------------------------
    // 小工具
    // ---------------------------------------------------------------
    function cmpVersion(a, b) {
        var pa = String(a).replace(/^v/i, '').split(/[.\-+]/);
        var pb = String(b).replace(/^v/i, '').split(/[.\-+]/);
        for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
            var na = parseInt(pa[i], 10);
            var nb = parseInt(pb[i], 10);
            if (isNaN(na)) na = 0;
            if (isNaN(nb)) nb = 0;
            if (na > nb) return 1;
            if (na < nb) return -1;
        }
        return 0;
    }

    function toast(msg, ms) {
        var el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = [
            'position:fixed', 'left:50%', 'bottom:calc(72px + env(safe-area-inset-bottom,0px))',
            'transform:translateX(-50%)', 'background:rgba(17,24,39,.92)', 'color:#fff',
            'padding:10px 18px', 'border-radius:22px', 'font-size:14px', 'z-index:2147483000',
            'max-width:80vw', 'text-align:center', 'pointer-events:none',
            'box-shadow:0 4px 20px rgba(0,0,0,.25)'
        ].join(';');
        document.body.appendChild(el);
        setTimeout(function () {
            el.style.transition = 'opacity .3s';
            el.style.opacity = '0';
            setTimeout(function () { el.remove(); }, 320);
        }, ms || 1800);
    }

    function openExternal(url) {
        // Capacitor 对非应用域链接会自动交给系统浏览器/下载器处理
        try {
            window.open(url, '_blank');
        } catch (e) {
            location.href = url;
        }
    }

    // 把 base64 二进制转 Uint8Array（CapacitorHttp 对二进制返回 base64 字符串）
    function base64ToUint8(b64) {
        var bin = atob(b64);
        var len = bin.length;
        var arr = new Uint8Array(len);
        for (var i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
        return arr;
    }

    // 原生下载 APK：彻底绕开 Gitee 把 .apk 当 application/zip 返回的坑（否则安卓下载器会补成 .apk.zip）。
    // 做法：用 CapacitorHttp 原生拉取字节（返回 base64，完全不受服务器 Content-Type 影响），
    // 再以 Filesystem 写进「下载」目录并强制 .apk 文件名——文件后缀永远正确、可被安装器直接打开。
    // 关键：绝不回退到 openExternal(下载URL)，那正是 .apk.zip 的根源。
    function downloadApk(url, version) {
        var Cap = window.Capacitor;
        var Http = Cap && Cap.Plugins && Cap.Plugins.CapacitorHttp;
        var FS = Cap && Cap.Plugins && Cap.Plugins.Filesystem;
        var v = String(version || APP_VERSION).replace(/^v/i, '');
        var fileName = 'crm-android-' + v + '.apk';

        if (!Http || typeof Http.request !== 'function') {
            toast('当前环境不支持原生下载，请到「关于」页手动复制下载链接', 4000);
            return;
        }

        toast('正在下载安装包…', 2500);
        // 不传 responseType（CapacitorHttp 对二进制默认返回 base64 字符串），避免不兼容的 'blob' 直接抛错
        Http.request({ method: 'GET', url: url, headers: {}, timeout: 180000 })
            .then(function (resp) {
                var b64 = toBase64(resp && resp.data);
                if (!b64) {
                    toast('下载失败：未能解析安装包数据', 4000);
                    return;
                }
                if (FS && typeof FS.writeFile === 'function') {
                    writeApk(FS, b64, fileName);
                } else {
                    // 无 Filesystem 插件时退回 Blob + <a download>（文件名仍是 .apk，不再走 Gitee URL）
                    fallbackBlobDownload(b64, fileName);
                }
            })
            .catch(function (e) {
                toast('下载失败：' + (e && e.message ? e.message : e), 4000);
            });
    }

    // 把 CapacitorHttp 返回的多种二进制形态统一成 base64 字符串
    function toBase64(data) {
        if (typeof data === 'string' && data) return data;            // 通常是 base64
        if (data instanceof Uint8Array) return uint8ToBase64(data);
        if (data && typeof data === 'object' && typeof data.byteLength === 'number') return uint8ToBase64(new Uint8Array(data)); // ArrayBuffer
        if (data && Array.isArray(data)) return uint8ToBase64(new Uint8Array(data));
        return null;
    }

    function uint8ToBase64(u8) {
        var bin = '';
        var chunk = 0x8000;
        for (var i = 0; i < u8.length; i += chunk) {
            bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
        }
        return btoa(bin);
    }

    // 用 Filesystem 把 APK 写进下载目录，文件名强制 .apk；失败逐目录回退
    function writeApk(FS, b64, fileName) {
        var write = function (dir) {
            return FS.writeFile({ path: fileName, data: b64, directory: dir, recursive: true });
        };
        write('DOWNLOADS')
            .then(function () { toast('安装包已保存到「下载」目录：' + fileName + '，请到文件管理器点开安装', 6000); })
            .catch(function () {
                write('DOCUMENTS')
                    .then(function () { toast('安装包已保存到「文档」目录：' + fileName + '，请打开安装', 6000); })
                    .catch(function () { fallbackBlobDownload(b64, fileName); });
            });
    }

    // 无 Filesystem 时的兜底：仍以 Blob + <a download> 存成正确 .apk 文件名（不再走 Gitee URL）
    function fallbackBlobDownload(b64, fileName) {
        try {
            var blob = new Blob([base64ToUint8(b64)], { type: 'application/vnd.android.package-archive' });
            var objUrl = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = objUrl; a.download = fileName; a.rel = 'noopener';
            document.body.appendChild(a); a.click();
            setTimeout(function () { try { URL.revokeObjectURL(objUrl); a.remove(); } catch (e) {} }, 4000);
            toast('下载完成，请在下载通知中点开安装包', 3500);
        } catch (e) {
            toast('下载失败，请到「关于」页手动复制下载链接', 4000);
        }
    }

    // ---------------------------------------------------------------
    // 更新弹窗（自绘）
    // ---------------------------------------------------------------
    var overlayEl = null;

    function closeUpdateModal() {
        if (overlayEl) {
            overlayEl.remove();
            overlayEl = null;
        }
    }

    function isUpdateModalOpen() {
        return !!overlayEl;
    }

    function showUpdateModal(info) {
        closeUpdateModal();
        var apkUrl = info.apkUrl;
        var notes = (info.body || '').trim();
        if (notes.length > 400) notes = notes.slice(0, 400) + '…';

        overlayEl = document.createElement('div');
        overlayEl.style.cssText = [
            'position:fixed', 'inset:0', 'background:rgba(0,0,0,.5)', 'z-index:2147483100',
            'display:flex', 'align-items:center', 'justify-content:center', 'padding:20px',
            '-webkit-tap-highlight-color:transparent'
        ].join(';');

        var card = document.createElement('div');
        card.style.cssText = [
            'background:#fff', 'border-radius:16px', 'width:100%', 'max-width:360px',
            'overflow:hidden', 'box-shadow:0 20px 50px rgba(0,0,0,.3)',
            'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif'
        ].join(';');

        var head = document.createElement('div');
        head.style.cssText = 'background:linear-gradient(135deg,#4f46e5,#6366f1);color:#fff;padding:18px 20px';
        head.innerHTML = '<div style="font-size:17px;font-weight:600">发现新版本</div>' +
            '<div style="font-size:13px;opacity:.9;margin-top:4px">当前 v' + APP_VERSION +
            ' &nbsp;→&nbsp; 最新 v' + info.version + '</div>';

        var body = document.createElement('div');
        body.style.cssText = 'padding:16px 20px;max-height:40vh;overflow:auto;color:#374151;font-size:14px;line-height:1.65';
        if (notes) {
            var pre = document.createElement('div');
            pre.style.cssText = 'white-space:pre-wrap;word-break:break-word';
            pre.textContent = notes;
            body.appendChild(pre);
        } else {
            body.textContent = '本次更新包含功能改进与问题修复，建议更新。';
        }

        var tip = document.createElement('div');
        tip.style.cssText = 'padding:0 20px 4px;color:#9ca3af;font-size:12px;line-height:1.6';
        tip.textContent = '点「下载新版本」会直接下载安装包，下载完成点通知里的安装包即可，覆盖安装数据不会丢失。';
        body.appendChild(tip);

        var foot = document.createElement('div');
        foot.style.cssText = 'display:flex;gap:10px;padding:14px 20px 18px';

        function mkBtn(text, primary) {
            var b = document.createElement('button');
            b.textContent = text;
            b.style.cssText = [
                'flex:1', 'border:none', 'border-radius:10px', 'padding:12px 0',
                'font-size:15px', 'font-weight:500', 'cursor:pointer',
                primary ? 'background:#4f46e5;color:#fff' : 'background:#f3f4f6;color:#4b5563'
            ].join(';');
            return b;
        }

        var later = mkBtn('稍后再说', false);
        later.onclick = closeUpdateModal;

        var skip = document.createElement('button');
        skip.textContent = '跳过此版本';
        skip.style.cssText = 'display:block;width:100%;border:none;background:none;color:#9ca3af;font-size:13px;padding:0 0 14px;cursor:pointer';
        skip.onclick = function () {
            try { localStorage.setItem(SKIP_KEY, info.version); } catch (e) {}
            closeUpdateModal();
            toast('已跳过 v' + info.version + '，下次有更新版本再提醒');
        };

        var go = mkBtn('下载新版本', true);
        go.onclick = function () {
            closeUpdateModal();
            if (apkUrl) {
                // 用原生下载（CapacitorHttp 拉字节），绕开 Gitee 把 .apk 当 zip 返回的坑，确保文件名是 .apk
                downloadApk(apkUrl, info.version);
            } else {
                openExternal(info.htmlUrl);
            }
        };

        foot.appendChild(later);
        foot.appendChild(go);
        card.appendChild(head);
        card.appendChild(body);
        card.appendChild(foot);
        card.appendChild(skip);
        overlayEl.appendChild(card);
        overlayEl.addEventListener('click', function (e) {
            if (e.target === overlayEl) closeUpdateModal();
        });
        document.body.appendChild(overlayEl);
    }

    // ---------------------------------------------------------------
    // 检查更新（GitHub + Gitee 双源，下载优先 Gitee 以提速）
    // ---------------------------------------------------------------
    var checking = false;

    function fetchJson(url) {
        return fetch(url, {
            headers: { Accept: 'application/json' },
            cache: 'no-store'
        }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        });
    }

    // 把 release JSON 归一化为 {version, body, apkUrl, htmlUrl}
    function parseRelease(j) {
        var tag = String(j.tag_name || j.name || '').replace(/^v/i, '');
        var apk = null;
        (j.assets || []).forEach(function (a) {
            if (!apk && /\.apk$/i.test(a.name || '')) apk = a.browser_download_url;
        });
        return { version: tag, body: j.body || '', apkUrl: apk, htmlUrl: j.html_url || '' };
    }

    function checkUpdate(manual) {
        if (checking) return;
        checking = true;
        if (manual) toast('正在检查更新…', 1200);

        // 两个源并行查，任一失败都降级为 null，不影响另一源
        var pGithub = fetchJson(API_LATEST_GITHUB).then(parseRelease).catch(function () { return null; });
        var pGitee = fetchJson(API_LATEST_GITEE).then(parseRelease).catch(function () { return null; });

        Promise.all([pGithub, pGitee]).then(function (res) {
            try { localStorage.setItem(LAST_CHECK_KEY, String(Date.now())); } catch (e) {}
            var github = res[0], gitee = res[1];

            // 取较新版本；Gitee 与 GitHub 同版本时优先 Gitee
            var best = null;
            if (github && cmpVersion(github.version, APP_VERSION) > 0) best = github;
            if (gitee && cmpVersion(gitee.version, APP_VERSION) > 0 &&
                (!best || cmpVersion(gitee.version, best.version) >= 0)) {
                best = gitee;
            }

            if (best) {
                // 下载链接优先 Gitee：若较新版本来自 GitHub，但 Gitee 也有同版本 APK，则改用 Gitee 直链
                var dl = best.apkUrl;
                if (best === github && gitee && gitee.apkUrl &&
                    cmpVersion(gitee.version, best.version) >= 0) {
                    dl = gitee.apkUrl;
                }
                var skipped = '';
                try { skipped = localStorage.getItem(SKIP_KEY) || ''; } catch (e) {}
                if (!manual && skipped && cmpVersion(best.version, skipped) <= 0) { checking = false; return; }
                showUpdateModal({
                    version: best.version,
                    body: best.body,
                    apkUrl: dl,
                    htmlUrl: best.htmlUrl
                });
            } else if (manual) {
                toast('已是最新版本 v' + APP_VERSION, 2000);
            }
            checking = false;
        }).catch(function (e) {
            if (manual) toast('检查更新失败：' + (e && e.message ? e.message : '网络异常'), 2600);
            checking = false;
        });
    }

    // ---------------------------------------------------------------
    // 侧边栏底部：版本号 + 检查更新入口
    // ---------------------------------------------------------------
    function mountSidebarEntry() {
        var footer = document.querySelector('.sidebar-footer');
        if (!footer || footer.querySelector('#androidUpdateBtn')) return;

        var vi = footer.querySelector('.version-info');
        if (vi) vi.textContent = 'V' + APP_VERSION + ' 数据存于本机';

        var btn = document.createElement('button');
        btn.id = 'androidUpdateBtn';
        btn.textContent = '检查更新';
        btn.style.cssText = [
            'display:block', 'width:100%', 'margin-top:8px', 'padding:8px 0',
            'border:1px solid rgba(148,163,184,.45)', 'border-radius:8px',
            'background:transparent', 'color:inherit', 'opacity:.85',
            'font-size:13px', 'cursor:pointer'
        ].join(';');
        btn.onclick = function (e) {
            e.stopPropagation();
            checkUpdate(true);
        };
        footer.appendChild(btn);
    }

    // ---------------------------------------------------------------
    // 安卓返回键
    // ---------------------------------------------------------------
    var backOnce = false;

    function anyOverlayOpen() {
        return document.querySelector(
            '.modal-overlay.show, #sidebar.show, #searchOverlay.show, #detailMoreMenu.show'
        );
    }

    function setupBackButton() {
        var Cap = window.Capacitor;
        var CapApp = Cap && Cap.Plugins && Cap.Plugins.App;
        if (!CapApp || !CapApp.addListener) return false;

        CapApp.addListener('backButton', function () {
            // 1) 自绘的更新弹窗
            if (isUpdateModalOpen()) {
                closeUpdateModal();
                return;
            }
            // 2) 主程序的浮层：复用其已有的 ESC 关闭逻辑
            if (anyOverlayOpen()) {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                return;
            }
            // 3) 再按一次退出
            if (backOnce) {
                try { CapApp.exitApp(); } catch (e) {}
            } else {
                backOnce = true;
                toast('再按一次返回键退出', 1600);
                setTimeout(function () { backOnce = false; }, 1800);
            }
        });
        return true;
    }

    // ---------------------------------------------------------------
    // 启动
    // ---------------------------------------------------------------
    function boot() {
        mountSidebarEntry();

        // Capacitor 桥可能比页面脚本稍晚就绪，重试若干次
        var tries = 0;
        (function tryBack() {
            if (setupBackButton()) return;
            if (++tries < 20) setTimeout(tryBack, 250);
        })();

        // 启动后静默检查（限频）
        setTimeout(function () {
            var last = 0;
            try { last = parseInt(localStorage.getItem(LAST_CHECK_KEY) || '0', 10) || 0; } catch (e) {}
            if (Date.now() - last > AUTO_CHECK_INTERVAL) checkUpdate(false);
        }, 4000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    // 暴露给调试/外部调用
    window.crmAndroid = {
        version: APP_VERSION,
        checkUpdate: function () { checkUpdate(true); }
    };
})();
