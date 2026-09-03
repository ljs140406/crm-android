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
        tip.textContent = '点「下载新版本」后会跳到浏览器下载安装包，下载完成点开安装即可，直接覆盖安装、数据不会丢失。';
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
            if (apkUrl) {
                openExternal(apkUrl);
                closeUpdateModal();
                toast('已跳转浏览器下载，完成后点开安装包安装', 2600);
            } else {
                openExternal(info.htmlUrl);
                closeUpdateModal();
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
