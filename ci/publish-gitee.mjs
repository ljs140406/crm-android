/**
 * CI 步骤：把刚构建好的 APK 镜像到 Gitee（公开仓 lij140406/crm-android）。
 *
 * 目的：消除「GitHub 先发、Gitee 后补」的发布时差——此前 Gitee 镜像靠本地脚本
 * 手动补发，新版本刚发布的窗口期内 Gitee 没有该版本，应用内「检查更新」只能
 * 从 GitHub 下载（国内很慢）。此步骤在 GitHub Release 创建后立即执行，保证
 * Gitee 与 GitHub 同步可下载。
 *
 * 环境变量：
 *   GITEE_TOKEN   Gitee 私人令牌（仓库 Settings → Secrets → Actions 添加）；
 *                 未配置时本步骤打印警告并跳过（exit 0），不阻塞构建。
 *   GITEE_NOTES   （可选）release 说明文字。
 *
 * 用法：
 *   node ci/publish-gitee.mjs <apk路径> <tag如v1.1.8> <版本如1.1.8>
 *
 * 已知 Gitee API 坑（沿用本地脚本验证过的处理方式）：
 *   - 经 API 建的仓库默认私有（private:false 会被忽略）→ 建完后 PATCH 强制公开；
 *   - PATCH 改可见性必须带 name 字段，否则 400；
 *   - 对不存在的 release，GET 返回 200 + null（不是 404），判空用 `st==200 && rel`；
 *   - release 的 assets 列表无 id 字段，删除旧 release 直接整删（级联删附件）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [, , apkArg, tagArg, verArg] = process.argv;
const APK_PATH = apkArg || '';
const TAG = tagArg || '';
const VERSION = verArg || (TAG ? TAG.replace(/^v/, '') : '');
const GT_TOKEN = process.env.GITEE_TOKEN || '';
const NOTES = process.env.GITEE_NOTES || `安卓端 v${VERSION} 更新（Gitee 镜像，国内下载更快）。`;

const GH_OWNER = 'ljs140406';      // GitHub 仓库 owner（与 Gitee owner 不同，勿混用）
const OWNER = 'lij140406';         // Gitee 仓库 owner
const REPO = 'crm-android';
const GH_API = 'https://api.github.com';
const GT_API = 'https://gitee.com/api/v5';
let GT_BRANCH = 'master';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, { tries = 4, backoffMs = 3000, label = '请求' } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) {
        console.log(`  [retry ${i + 1}/${tries}] ${label} 失败（${e.message}），${backoffMs * (i + 1) / 1000}s 后重试…`);
        await sleep(backoffMs * (i + 1));
      }
    }
  }
  throw lastErr;
}

async function ghApi(method, apiPath) {
  const res = await withRetry(async () => {
    const r = await fetch(GH_API + apiPath, {
      method,
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN || ''}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'crm-ci',
      },
    });
    if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
    return r;
  }, { label: `GitHub ${method} ${apiPath}` });
  const raw = await res.text();
  let json = {};
  try { json = raw ? JSON.parse(raw) : {}; } catch { /* ignore */ }
  return { status: res.status, json };
}

async function gtApi(method, apiPath, data = undefined) {
  const url = GT_API + apiPath + (apiPath.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(GT_TOKEN);
  return withRetry(async () => {
    const headers = { Accept: 'application/json', 'User-Agent': 'crm-ci' };
    const body = data !== undefined ? JSON.stringify(data) : undefined;
    if (body) headers['Content-Type'] = 'application/json';
    const r = await fetch(url, { method, headers, body });
    const raw = await r.text();
    let json = {};
    try { json = raw ? JSON.parse(raw) : {}; } catch { json = raw.slice(0, 400); }
    // Gitee 限流时返回 403/429，稍等重试
    if (r.status === 403 || r.status === 429) throw new Error(`HTTP ${r.status}（限流？）`);
    return { status: r.status, json };
  }, { label: `Gitee ${method} ${apiPath}` });
}

async function main() {
  if (!APK_PATH || !TAG) {
    console.error('用法：node ci/publish-gitee.mjs <apk路径> <tag> <版本>');
    process.exit(1);
  }
  if (!GT_TOKEN) {
    console.warn('::warning::未配置 Secret GITEE_TOKEN，跳过 Gitee 镜像（应用内更新将只有 GitHub 源）');
    process.exit(0);
  }
  const apk = path.resolve(APK_PATH);
  if (!fs.existsSync(apk)) {
    console.error(`找不到 APK：${apk}`);
    process.exit(1);
  }
  const apkName = path.basename(apk);
  const apkBuf = fs.readFileSync(apk);
  const sha256 = crypto.createHash('sha256').update(apkBuf).digest('hex');
  console.log(`APK: ${apkName}，${apkBuf.length} 字节，sha256=${sha256}`);

  // 0) 用 GitHub 资产 digest 交叉校验（确保镜像的就是刚发布的那个包）
  const gh = await ghApi('GET', `/repos/${GH_OWNER}/${REPO}/releases/tags/${TAG}`);
  if (gh.status === 200 && gh.json) {
    const asset = (gh.json.assets || []).find((a) => a.name === apkName);
    const expect = asset && asset.digest ? String(asset.digest).replace(/^sha256:/, '') : '';
    if (expect && expect !== sha256) {
      console.error(`APK 与 GitHub 资产 sha256 不一致：期望 ${expect}，实际 ${sha256}`);
      process.exit(1);
    }
    if (expect) console.log('  与 GitHub 资产 sha256 校验一致 ✓');
  } else {
    console.log('  （GitHub release 未查到，跳过交叉校验）');
  }

  // 1) 确保仓库存在且公开
  let st, o;
  ({ status: st, json: o } = await gtApi('GET', `/repos/${OWNER}/${REPO}`));
  if (st !== 200 || !o || !o.id) {
    console.log('Gitee 仓库不存在，创建…');
    ({ status: st, json: o } = await gtApi('POST', '/user/repos', {
      name: REPO, auto_init: true, private: false,
      description: '客户跟进管理系统 - 安卓 App 更新源（Gitee 镜像）',
    }));
    if (st !== 201) {
      console.error(`仓库创建失败: ${st} ${JSON.stringify(o).slice(0, 300)}`);
      process.exit(1);
    }
  }
  GT_BRANCH = o.default_branch || 'master';
  // PATCH 强制公开（API 建仓默认私有会导致下载 403；必须带 name 字段否则 400）
  await gtApi('PATCH', `/repos/${OWNER}/${REPO}`, { name: REPO, private: false });
  console.log(`Gitee 仓库就绪，默认分支 ${GT_BRANCH}`);

  // 2) 确保 release（已存在则整删重建，保证幂等可重跑）
  let rel = null;
  ({ status: st, json: rel } = await gtApi('GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`));
  if (st === 200 && rel && rel.id) {
    console.log(`Gitee 已有 ${TAG} release（id=${rel.id}），删除重建…`);
    await gtApi('DELETE', `/repos/${OWNER}/${REPO}/releases/${rel.id}`);
    await gtApi('DELETE', `/repos/${OWNER}/${REPO}/tags/${TAG}`).catch(() => {});
    await sleep(2000);
  }
  ({ status: st, json: rel } = await gtApi('POST', `/repos/${OWNER}/${REPO}/releases`, {
    tag_name: TAG, name: TAG, body: NOTES,
    target_commitish: GT_BRANCH, prerelease: false,
  }));
  if (st !== 201 || !rel || !rel.id) {
    console.error(`创建 release 失败: ${st} ${JSON.stringify(rel).slice(0, 300)}`);
    process.exit(1);
  }
  const relId = rel.id;
  console.log(`release 创建成功 id=${relId}`);

  // 3) 上传 APK 资产（multipart）
  const boundary = '----crm-ci-' + crypto.randomBytes(12).toString('hex');
  const pre = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="access_token"\r\n\r\n${GT_TOKEN}\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${apkName}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`);
  const post = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([pre, apkBuf, post]);
  const upRes = await withRetry(async () => {
    const r = await fetch(`${GT_API}/repos/${OWNER}/${REPO}/releases/${relId}/attach_files`, {
      method: 'POST',
      headers: { 'User-Agent': 'crm-ci', 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    const raw = await r.text();
    return { status: r.status, raw: raw.slice(0, 400) };
  }, { tries: 3, backoffMs: 5000, label: '上传 APK 资产' });
  console.log(`[gt asset] ${apkName}: ${upRes.status}`);
  if (upRes.status !== 201) {
    console.error('资产上传失败:', upRes.raw);
    process.exit(1);
  }

  console.log(`\nDONE. Gitee 下载直链：https://gitee.com/${OWNER}/${REPO}/releases/download/${TAG}/${apkName}`);
}

main().catch((e) => {
  console.error('Gitee 镜像失败:', e && e.message);
  // 镜像失败不阻塞构建产物（GitHub release 已完成），但要在日志中醒目提示
  console.error('::warning::Gitee 镜像失败，本次发布国内下载源未更新，可本地运行 publish-gitee-android.py 补发');
  process.exit(0);
});
