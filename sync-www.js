#!/usr/bin/env node
/**
 * 把唯一源 HTML 同步为安卓 App 的 www/index.html。
 *
 * 唯一源：E:\分贝通资料\测试的\crm-app-mobile.html
 * 桌面版、PWA、安卓版三端共用这一份源，本脚本只做「安卓壳适配」的幂等改造：
 *   1) 禁用 Service Worker 注册（Capacitor 是本地资源，天生离线，SW 只会添乱）
 *   2) 注释掉 manifest / apple-touch-icon 引用（原生壳里这两个文件不存在，避免 404 噪音）
 *   3) 注入 android-update.js（通知型更新检查 + 安卓返回键处理）
 *
 * 源 HTML 本身不被修改。
 */
const fs = require('fs');
const path = require('path');

// 允许用环境变量覆盖，便于 GitHub Actions 里直接用仓库内的 www/index.html
const SOURCE = process.env.CRM_SOURCE_HTML || 'E:\\分贝通资料\\测试的\\crm-app-mobile.html';
const TARGET = path.join(__dirname, 'www', 'index.html');

if (!fs.existsSync(SOURCE)) {
  console.error(`[sync-www] 找不到源文件：${SOURCE}`);
  process.exit(1);
}

let html = fs.readFileSync(SOURCE, 'utf8');
const originalLength = html.length;
const applied = [];

// ---- 1) 禁用 Service Worker 注册 ----
const SW_GUARD = "if (['http:', 'https:'].includes(location.protocol) && 'serviceWorker' in navigator) {";
const SW_GUARD_OFF = "if (false /* android-shell: Capacitor 本地资源无需 SW */ && ['http:', 'https:'].includes(location.protocol) && 'serviceWorker' in navigator) {";
if (html.includes(SW_GUARD_OFF)) {
  applied.push('SW 已是禁用状态（跳过）');
} else if (html.includes(SW_GUARD)) {
  html = html.replace(SW_GUARD, SW_GUARD_OFF);
  applied.push('已禁用 Service Worker 注册');
} else {
  console.warn('[sync-www] 警告：未找到 Service Worker 守卫语句，源可能已变动，请核对');
}

// ---- 2) 注释掉 PWA 专用的 manifest / icon 引用 ----
const pwaLinks = [
  '<link rel="manifest" href="manifest.webmanifest">',
  '<link rel="apple-touch-icon" href="icon.svg">',
];
pwaLinks.forEach((tag) => {
  if (html.includes(`<!-- android-shell 已移除: ${tag}`)) {
    applied.push(`PWA 标签已注释（跳过）: ${tag.slice(0, 30)}…`);
  } else if (html.includes(tag)) {
    html = html.replace(tag, `<!-- android-shell 已移除: ${tag} -->`);
    applied.push(`已注释 PWA 标签: ${tag.slice(0, 30)}…`);
  }
});

// ---- 3) 注入 android-update.js ----
const INJECT = '<script src="android-update.js"></script>';
if (html.includes(INJECT)) {
  applied.push('android-update.js 已注入（跳过）');
} else {
  const idx = html.lastIndexOf('</body>');
  if (idx === -1) {
    console.error('[sync-www] 未找到 </body>，无法注入 android-update.js');
    process.exit(1);
  }
  html = html.slice(0, idx) + INJECT + '\n' + html.slice(idx);
  applied.push('已注入 android-update.js');
}

fs.mkdirSync(path.dirname(TARGET), { recursive: true });
fs.writeFileSync(TARGET, html, 'utf8');

console.log(`[sync-www] 源 ${originalLength} 字节 -> www/index.html ${html.length} 字节`);
applied.forEach((m) => console.log(`  · ${m}`));
