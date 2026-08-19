/**
 * scripts/validate-issue.mjs
 *
 * Issue 路径校验脚本，被 .github/workflows/issue-bot.yml 调用。
 * 监听 issues.opened（标题以 [Friend Link] 开头），解析 Issue body 中固定字段，
 * 校验通过后直接 git push 写入 data/friends/<filename>.json，并触发 build.yml。
 *
 * 设计原则：
 *   - 浏览器只生成预填 Issue 草稿 URL，不持有仓库写权限
 *   - 字段、SSRF、可达性、回链校验规则与 PR 路径完全一致（复用 lib/validate.mjs）
 *   - 仅支持「新增」友链；「修改/删除」仍走 PR 路径
 *   - 用 Issue 评论里的隐藏 marker 实现幂等，防止事件重复投递
 *   - bot 以 github-actions[bot] 身份提交，使用仓库默认 GITHUB_TOKEN
 *
 * 入口：runIssueBot({ mode, github, core, context, env })
 *   - mode: 'opened' | 'review'
 *     · opened：处理刚提交的 Issue（确认评论 + 立即校验）
 *     · review：扫描所有开放 Issue 并处理（手动 dispatch 用）
 *
 * Issue body 字段格式（由 apply.html 生成）：
 *   ## Friend Link Application
 *
 *   - Site Name: 站点名称
 *   - Site URL: https://example.com
 *   - Friend Page URL: https://example.com/friends
 *   - Avatar URL: https://example.com/avatar.png
 *   - Short Description: 站点简介
 *   - Filename: example.json
 *   - Reciprocal Link Added: yes
 */

import {
  SITE_URL,
  isPublicUrl,
  validateFields,
  checkSsrf,
  checkBacklinkDomainConsistency,
  checkUrlReachable,
  checkBacklink,
  validateFilename,
  normalizeFilename,
  standardizeFriendData,
  sleep,
  getHostname,
} from './lib/validate.mjs';

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ========== 常量 ==========
const ISSUE_TITLE_PREFIX = '[Friend Link]';
const MARKER_INITIAL = '<!-- moara-friends-bot:initial -->';
const MARKER_ACCEPTED = '<!-- moara-friends-bot:accepted -->';
const MARKER_REJECTED = '<!-- moara-friends-bot:rejected -->';

// 冷却等待（毫秒）。0 = 不等待。
// 预留位置：如果未来发现用户提交 Issue 后回链还没生效（CDN 缓存慢），
// 把这个值调大（如 10 * 60 * 1000 = 10 分钟）即可。
const COOLDOWN_MS = 0;

// 最大处理 Issue 数（防止单 run 处理过多超时）
const MAX_ISSUES_PER_RUN = 50;

// ========== Issue body 解析 ==========
/**
 * 解析 Issue body 中的固定字段
 * 容忍 "- Site URL:" 这类无空格冒号；重复标签取首次出现；
 * 支持缩进续行折叠
 */
export function parseApplication(body = '') {
  const lines = String(body ?? '').split(/\r?\n/);
  const values = {};
  let currentLabel = null;

  for (const rawLine of lines) {
    const fieldMatch = rawLine.match(/^\s{0,3}-\s*([^:\n]+?)\s*:\s*(.*)$/);
    if (fieldMatch) {
      const label = fieldMatch[1].trim().toLowerCase();
      const value = fieldMatch[2].trim();
      currentLabel = label;
      if (value && !values[label]) values[label] = value;
      continue;
    }
    // 缩进续行折叠进当前字段值（子列表项不折叠）
    if (currentLabel && /^\s{2,}\S/.test(rawLine) && !/^\s{2,}[-*>\d.]\s/.test(rawLine)) {
      const continuation = rawLine.trim();
      if (values[currentLabel]) values[currentLabel] = ` ${values[currentLabel]} ${continuation}`.trim();
    } else {
      currentLabel = null;
    }
  }

  return {
    name:           values['site name'] || '',
    url:            values['site url'] || '',
    friendPageUrl:  values['friend page url'] || '',
    avatar:         values['avatar url'] || '',
    description:    values['short description'] || '',
    filename:       values['filename'] || '',
    reciprocalLinkAdded: values['reciprocal link added'] || '',
  };
}

// ========== 工具：调用 GitHub API ==========
// 通用重试包装：处理瞬时网络抖动（如 fetch failed）
// 对 5xx 和网络错误重试 3 次，4xx 立即失败
async function withRetry(fn, { name = 'api', retries = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = e.status || e.response?.status || 0;
      // 4xx (除 429/408) 不重试
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) break;
      if (i < retries - 1) {
        const wait = 1000 * Math.pow(2, i);  // 1s, 2s, 4s
        console.warn(`${name} 失败(${status || 'network'}): ${e.message}，${wait}ms 后重试...`);
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

async function createComment(octokit, owner, repo, issue_number, body) {
  try {
    await withRetry(
      () => octokit.rest.issues.createComment({ owner, repo, issue_number, body }),
      { name: 'createComment' }
    );
  } catch (e) {
    console.warn(`createComment 最终失败: ${e.message}`);
  }
}

async function closeIssue(octokit, owner, repo, issue_number, state_reason = 'completed') {
  try {
    await withRetry(
      () => octokit.rest.issues.update({ owner, repo, issue_number, state: 'closed', state_reason }),
      { name: 'closeIssue' }
    );
  } catch (e) {
    console.warn(`closeIssue 最终失败: ${e.message}`);
  }
}

async function addLabels(octokit, owner, repo, issue_number, labels) {
  try {
    await withRetry(
      () => octokit.rest.issues.addLabels({ owner, repo, issue_number, labels }),
      { name: 'addLabels' }
    );
  } catch (e) {
    console.warn(`addLabels 最终失败: ${e.message}`);
  }
}

async function ensureLabel(octokit, owner, repo, name, color) {
  try {
    await octokit.rest.issues.getLabel({ owner, repo, name });
  } catch (e) {
    if (e.status === 404) {
      try {
        await octokit.rest.issues.createLabel({ owner, repo, name, color });
      } catch (createErr) {
        // 忽略创建失败（可能并发创建）
      }
    }
  }
}

// ========== 列出现有 data/friends/*.json ==========
async function listExistingFriends(octokit, owner, repo) {
  const friends = [];
  try {
    const res = await octokit.rest.repos.getContent({ owner, repo, path: 'data/friends' });
    if (Array.isArray(res.data)) {
      for (const item of res.data) {
        if (item.type === 'file' && item.name.endsWith('.json')) {
          friends.push(item.name);
        }
      }
    }
  } catch (e) {
    console.warn(`listExistingFriends failed: ${e.message}`);
  }
  return friends;
}

// 读取 data/friends 下所有 JSON 内容，建立 {name, url} → filename 的反向索引
async function buildFriendIndex(octokit, owner, repo) {
  const index = { byUrl: {}, byName: {}, byFilename: {} };
  try {
    const res = await octokit.rest.repos.getContent({ owner, repo, path: 'data/friends' });
    if (!Array.isArray(res.data)) return index;

    for (const item of res.data) {
      if (item.type !== 'file' || !item.name.endsWith('.json')) continue;
      try {
        const fileRes = await octokit.rest.repos.getContent({ owner, repo, path: item.path });
        if (fileRes.data && fileRes.data.content) {
          const raw = Buffer.from(fileRes.data.content, fileRes.data.encoding || 'base64').toString('utf-8');
          const parsed = JSON.parse(raw);
          const urlNorm = parsed.url ? parsed.url.replace(/\/$/, '').toLowerCase() : '';
          if (urlNorm) index.byUrl[urlNorm] = item.name;
          if (parsed.name) index.byName[parsed.name.trim().toLowerCase()] = item.name;
          index.byFilename[item.name] = true;
        }
      } catch {}
    }
  } catch (e) {
    console.warn(`buildFriendIndex failed: ${e.message}`);
  }
  return index;
}

// ========== Git 操作：写入文件并推送 ==========
function gitExec(args, { cwd, env } = {}) {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function commitAndPushFriendFile({ filename, content, targetBranch, workspace }) {
  const filePath = path.join(workspace, 'data', 'friends', filename);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');

  gitExec(['add', filePath], { cwd: workspace });

  // 检查是否有改动（幂等：内容相同则跳过）
  const status = gitExec(['status', '--porcelain'], { cwd: workspace });
  if (!status.trim()) {
    return { pushed: false, reason: 'no_changes' };
  }

  gitExec([
    '-c', 'user.name=github-actions[bot]',
    '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'commit', '-m', `feat: add friend link via issue (#${process.env.ISSUE_NUMBER || 'manual'})`,
  ], { cwd: workspace });

  // push 重试：网络抖动允许重试
  let pushOk = false;
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      gitExec(['push', 'origin', `HEAD:${targetBranch}`], { cwd: workspace });
      pushOk = true;
      break;
    } catch (e) {
      lastErr = e.message;
      await sleep(2000 * Math.pow(2, i));
    }
  }
  if (!pushOk) throw new Error(`git push failed: ${lastErr}`);

  // 取 commit SHA
  const sha = gitExec(['rev-parse', 'HEAD'], { cwd: workspace });
  return { pushed: true, sha };
}

// ========== 失败评论构造 ==========
function buildFailBody(title, lines) {
  return [
    `## ❌ ${title}`,
    '',
    ...lines.map((l) => {
      if (l === '') return '';
      if (l.startsWith('```') || l.startsWith('    ')) return l;
      if (/^\s*([-*+]|\d+\.)\s/.test(l)) return l;
      return `- ${l}`;
    }),
    '',
    '---',
    '',
    '<details>',
    '<summary><b>🔄 重新校验</b></summary>',
    '',
    '修复上述问题后，任选一种方式触发重新校验：',
    '',
    '1. **重新打开此 Issue** —— 直接点下方「Reopen」按钮，bot 会自动重新校验',
    '2. **在本 Issue 评论 `/recheck`** —— bot 会自动重新校验',
    '',
    '> 修改 Issue 正文（编辑上方描述）后，再触发重新校验即可，无需新建 Issue。',
    '',
    '</details>',
    '',
    `如对审核结果有疑问，可[联系 moara](mailto:moara@foxmail.com)。`,
  ].join('\n');
}

function buildSuccessBody({ filename, sha, usedPlaywright }) {
  return [
    `## ✅ 友链申请已通过`,
    '',
    `已自动写入 \`${filename}\`，commit \`${sha ? sha.slice(0, 7) : 'unknown'}\`。`,
    '',
    `**校验结果**：`,
    `- 字段格式 ✓`,
    `- SSRF 防护 ✓`,
    `- 回链域名一致性 ✓`,
    `- URL 与头像可达性 ✓`,
    `- 回链验证 ✓${usedPlaywright ? '（Playwright 渲染）' : '（静态 HTML）'}`,
    '',
    '稍后 build workflow 会重建 `friends.json`，CDN 缓存刷新后即可在本站友链页看到。',
    '',
    '如需修改或删除，请走 PR 流程并完成域名所有权验证（详见 README）。',
  ].join('\n');
}

// ========== 单个 Issue 处理流程 ==========
async function processIssue({ octokit, owner, repo, issue, workspace, targetBranch, core, forceReprocess = false }) {
  const issue_number = issue.number;
  const log = (msg) => core?.info?.(msg) ?? console.log(msg);

  log(`\n========== 处理 Issue #${issue_number}: ${issue.title}${forceReprocess ? ' (强制重新校验)' : ''} ==========`);

  // 幂等检查：
  // - forceReprocess=true（reopened/recheck 触发）：只跳过已 accepted 的，允许重新处理 rejected 的
  // - forceReprocess=false（opened/review 触发）：accepted 和 rejected 都跳过
  try {
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner, repo, issue_number, per_page: 100,
    });
    const allBodies = comments.map(c => c.body || '').join('\n');
    const hasAccepted = allBodies.includes(MARKER_ACCEPTED);
    const hasRejected = allBodies.includes(MARKER_REJECTED);

    if (hasAccepted) {
      log(`⏭️  Issue #${issue_number} 已通过（accepted），跳过`);
      return { skipped: true, reason: 'already_accepted' };
    }
    if (hasRejected && !forceReprocess) {
      log(`⏭️  Issue #${issue_number} 之前被拒（rejected），跳过；如需重试请重新打开 Issue 或评论 /recheck`);
      return { skipped: true, reason: 'already_rejected' };
    }
    if (hasRejected && forceReprocess) {
      log(`🔄 Issue #${issue_number} 之前被拒，现在重新校验`);
    }
  } catch (e) {
    core?.warning?.(`检查已有评论失败: ${e.message}`);
  }

  // 标题前缀检查
  if (!issue.title || !issue.title.startsWith(ISSUE_TITLE_PREFIX)) {
    log(`⏭️  Issue #${issue_number} 标题不以 ${ISSUE_TITLE_PREFIX} 开头，跳过`);
    return { skipped: true };
  }

  // ── 0. 发布初始确认评论 ──
  await createComment(octokit, owner, repo, issue_number, [
    `${MARKER_INITIAL}`,
    `## 📨 已收到友链申请${forceReprocess ? '（重新校验）' : ''}`,
    '',
    '正在校验以下内容：',
    '- 字段格式',
    '- SSRF 防护',
    '- 回链域名一致性',
    '- URL 与头像可达性',
    '- 回链验证（你的友链页是否已添加本站链接）',
    '',
    '校验通常在 1-2 分钟内完成，请稍候。',
  ].join('\n'));

  // ── 1. 解析 Issue body ──
  const app = parseApplication(issue.body || '');
  log(`解析字段: ${JSON.stringify(app, null, 2)}`);

  // 检查必要字段是否全部非空（filename 除外，可以由 name 推断）
  const missingFields = [];
  if (!app.name) missingFields.push('Site Name');
  if (!app.url) missingFields.push('Site URL');
  if (!app.friendPageUrl) missingFields.push('Friend Page URL');
  if (!app.filename) missingFields.push('Filename');
  if (missingFields.length) {
    await createComment(octokit, owner, repo, issue_number, buildFailBody(
      'Issue 内容不完整',
      [
        `缺少必要字段：${missingFields.join(', ')}`,
        '',
        '请使用申请表单（apply.html 或博客 /friends 页面）生成的草稿提交，不要手工编辑 Issue 正文。',
        '完整字段包括：Site Name / Site URL / Friend Page URL / Avatar URL（可选） / Short Description（可选） / Filename。',
      ],
    ) + `\n${MARKER_REJECTED}`);
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'incomplete' };
  }

  // ── 2. 构造 data 对象 + 字段校验 ──
  const data = {
    name: app.name,
    url: app.url,
    backlink: app.friendPageUrl,
  };
  if (app.avatar) data.avatar = app.avatar;
  if (app.description) data.description = app.description;

  const fieldResult = validateFields(data);
  if (!fieldResult.ok) {
    await createComment(octokit, owner, repo, issue_number, buildFailBody(
      '字段校验未通过',
      fieldResult.errors,
    ) + `\n${MARKER_REJECTED}`);
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'field_invalid' };
  }

  // ── 3. 文件名校验 ──
  const filenameErr = validateFilename(app.filename);
  if (filenameErr) {
    await createComment(octokit, owner, repo, issue_number, buildFailBody(
      '文件名不符合规则',
      [
        filenameErr,
        '',
        '文件名只能包含英文字母、数字、短横线和下划线，可选 `.json` 后缀。',
        '示例：`example.json`、`my-blog.json`、`demo-blog`。',
      ],
    ) + `\n${MARKER_REJECTED}`);
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'filename_invalid' };
  }
  const filename = normalizeFilename(app.filename);

  // ── 4. SSRF 防护 ──
  const ssrfErrors = checkSsrf(data);
  if (ssrfErrors.length) {
    await createComment(octokit, owner, repo, issue_number, buildFailBody(
      'URL 不合法',
      [
        '检测到不可访问的地址：',
        '',
        ...ssrfErrors,
        '',
        '禁止使用：localhost、私有 IP、链路本地、云元数据端点等。',
      ],
    ) + `\n${MARKER_REJECTED}`);
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'ssrf' };
  }

  // ── 5. 回链域名一致性 ──
  const domainErr = checkBacklinkDomainConsistency(data);
  if (domainErr) {
    await createComment(octokit, owner, repo, issue_number, buildFailBody(
      domainErr.title,
      domainErr.lines,
    ) + `\n${MARKER_REJECTED}`);
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'domain_mismatch' };
  }

  // ── 6. 去重检查 ──
  const index = await buildFriendIndex(octokit, owner, repo);
  const urlNorm = data.url.replace(/\/$/, '').toLowerCase();
  const nameNorm = data.name.trim().toLowerCase();

  if (index.byUrl[urlNorm]) {
    await createComment(octokit, owner, repo, issue_number, buildFailBody(
      '站点 URL 已存在',
      [
        `你的 URL：\`${data.url}\``,
        `已存在的友链文件：\`${index.byUrl[urlNorm]}\``,
        '',
        '如需修改你已有的友链信息，请走 PR 流程并完成域名所有权验证（详见 README）。',
      ],
    ) + `\n${MARKER_REJECTED}`);
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'url_exists' };
  }
  if (index.byName[nameNorm]) {
    await createComment(octokit, owner, repo, issue_number, buildFailBody(
      '站点名称已存在',
      [
        `你的站点名称：\`${data.name}\``,
        `已存在的友链文件：\`${index.byName[nameNorm]}\``,
        '',
        '请换一个站点名称，或如需修改已有同名友链，请走 PR 流程。',
      ],
    ) + `\n${MARKER_REJECTED}`);
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'name_exists' };
  }
  if (index.byFilename[filename]) {
    await createComment(octokit, owner, repo, issue_number, buildFailBody(
      '文件名已被占用',
      [
        `你申请的文件名：\`${filename}\``,
        '该文件名已存在，请换一个。',
        '建议用站点域名做文件名，如 `example.json`。',
      ],
    ) + `\n${MARKER_REJECTED}`);
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'filename_exists' };
  }

  // ── 7. URL + avatar 可达性 ──
  log('🌐 正在并行检查站点 URL 和头像 URL 可达性...');
  const tasks = [
    checkUrlReachable(data.url, { requireImage: false })
      .then((r) => ({ label: '站点 url', url: data.url, result: r })),
  ];
  if (typeof data.avatar === 'string' && data.avatar.trim()) {
    tasks.push(
      checkUrlReachable(data.avatar, { requireImage: true })
        .then((r) => ({ label: '头像 avatar', url: data.avatar, result: r }))
    );
  }
  const results = await Promise.all(tasks);
  const failedChecks = results.filter((r) => !r.result.ok);

  if (failedChecks.length) {
    const lines = [];
    for (const r of results) {
      if (!r.result.ok) {
        lines.push('```');
        lines.push(`✗ ${r.label} 不可达 (${r.url})`);
        lines.push(`  · 尝试 ${r.result.attempts} 次，错误：${r.result.errors.join('；')}`);
        lines.push('```');
        lines.push('');
      }
    }
    await createComment(octokit, owner, repo, issue_number, buildFailBody('可达性检查未通过', lines) + `\n${MARKER_REJECTED}`);
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'unreachable' };
  }

  // ── 8. 回链验证（静态 + Playwright 兜底）──
  log(`🔗 正在抓取友链页面检查回链：${data.backlink}`);
  const backlinkResult = await checkBacklink(data.backlink, { log });

  if (!backlinkResult.ok) {
    const lines = backlinkResult.reason === 'unreachable'
      ? [
          `backlink URL：\`${data.backlink}\``,
          `抓取失败：${(backlinkResult.errors || []).join('；')}`,
          '',
          '请确认你的友链页 URL 正确且可公开访问。',
        ]
      : [
          `未检测到本站友链链接`,
          '',
          `**需要添加的链接**：\`${SITE_URL}\``,
          `**你的友链页面**：\`${data.backlink}\``,
          '',
          '**常见原因**：',
          '- 友链页还没添加本站链接，或链接 URL 不完全一致',
          '- 友链页需要登录或被防火墙拦截',
          '- CDN 缓存返回了旧版本',
          '',
          '**解决方法**：',
          `1. 在你的友链页添加：<a href="${SITE_URL}">沫然Blog</a>`,
          '2. 确保 href 是绝对链接且 URL 完全一致',
          '3. 等待 CDN 刷新后重新提交 Issue',
        ];
    await createComment(octokit, owner, repo, issue_number, buildFailBody('回链验证未通过', lines) + `\n${MARKER_REJECTED}`);
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'backlink_not_found' };
  }

  log(`✓ 回链验证通过${backlinkResult.usedPlaywright ? '（Playwright 渲染）' : '（静态 HTML）'}`);

  // ── 9. 写入文件并 push ──
  const stdData = standardizeFriendData(data);
  const content = JSON.stringify(stdData, null, 2) + '\n';

  let pushResult;
  try {
    process.env.ISSUE_NUMBER = String(issue_number);
    pushResult = await commitAndPushFriendFile({
      filename,
      content,
      targetBranch,
      workspace,
    });
  } catch (e) {
    await createComment(octokit, owner, repo, issue_number, buildFailBody(
      '写入文件失败',
      [
        `错误：${e.message}`,
        '',
        '校验已通过但写入仓库失败。请稍后重试，或[联系 moara](mailto:moara@foxmail.com)。',
      ],
    ) + `\n${MARKER_REJECTED}`);
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'push_failed', error: e.message };
  }

  if (!pushResult.pushed) {
    // 内容相同（幂等），仍然算成功
    log(`⚠️  文件内容与现有相同，未触发 push（幂等）`);
  } else {
    log(`✅ 写入成功：${filename} @ ${pushResult.sha.slice(0, 7)}`);
  }

  // ── 10. 成功评论 + 关闭 Issue + 触发 build ──
  await createComment(octokit, owner, repo, issue_number,
    buildSuccessBody({
      filename,
      sha: pushResult.sha,
      usedPlaywright: backlinkResult.usedPlaywright,
    }) + `\n${MARKER_ACCEPTED}`);

  await ensureLabel(octokit, owner, repo, '友链', '0e8a16');
  await ensureLabel(octokit, owner, repo, '已互链', '0e8a16');
  await addLabels(octokit, owner, repo, issue_number, ['友链', '已互链']);

  await closeIssue(octokit, owner, repo, issue_number, 'completed');

  // 触发 build workflow（重建 friends.json + 刷 jsDelivr）
  // 注意：GITHUB_TOKEN 的 git push 不会触发 on: push workflow，
  // 必须显式 dispatch build.yml
  try {
    await octokit.rest.actions.createWorkflowDispatch({
      owner, repo, workflow_id: 'build.yml', ref: targetBranch,
    });
    log('✅ build workflow 已触发');
  } catch (e) {
    log(`⚠️  trigger build workflow failed: ${e.message}`);
    log('   友链文件已入库，build 可由后续 push 或定时任务自动重跑');
  }

  return { ok: true, filename, sha: pushResult.sha };
}

// ========== 主入口 ==========
export async function runIssueBot({ mode, github, core, context, env }) {
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  const targetBranch = env.FRIEND_LINK_TARGET_BRANCH || context.ref?.replace('refs/heads/', '') || 'main';

  core.info(`Issue Bot 启动，mode=${mode}, owner=${owner}/${repo}, branch=${targetBranch}`);

  // 冷却等待（预留位置；当前 COOLDOWN_MS = 0，不等待）
  if (mode === 'opened' && COOLDOWN_MS > 0) {
    core.info(`⏳ 冷却等待 ${COOLDOWN_MS / 1000}s...`);
    await sleep(COOLDOWN_MS);
  }

  if (mode === 'opened' || mode === 'reopened') {
    // 处理刚打开或重新打开的 Issue
    // reopened 视为重新校验：forceReprocess=true，允许重试已 rejected 的
    const issue = context.payload.issue;
    if (!issue) {
      core.warning('未找到 issue payload');
      return;
    }
    await processIssue({
      octokit: github, owner, repo, issue, workspace, targetBranch, core,
      forceReprocess: mode === 'reopened',
    });
    return;
  }

  if (mode === 'recheck') {
    // 处理 issue_comment 事件中的 /recheck 斜杠命令
    const comment = context.payload.comment;
    const issue = context.payload.issue;
    if (!comment || !issue) {
      core.warning('未找到 comment 或 issue payload');
      return;
    }

    // 二次校验评论内容（防止 workflow_dispatch 误触发）
    const body = (comment.body || '').trim();
    if (!body.startsWith('/recheck')) {
      core.info(`评论内容不是 /recheck 命令，跳过：${body.slice(0, 50)}`);
      return;
    }

    // 标题前缀检查
    if (!issue.title || !issue.title.startsWith(ISSUE_TITLE_PREFIX)) {
      core.info(`Issue #${issue.number} 标题不以 ${ISSUE_TITLE_PREFIX} 开头，跳过`);
      return;
    }

    // 如果 Issue 处于关闭状态，先重新打开
    if (issue.state === 'closed') {
      core.info(`Issue #${issue.number} 处于关闭状态，重新打开以进行校验`);
      try {
        await github.rest.issues.update({
          owner, repo, issue_number: issue.number, state: 'open',
        });
      } catch (e) {
        core.warning(`重新打开 Issue 失败: ${e.message}`);
      }
    }

    // 触发处理（强制重新校验）
    await processIssue({
      octokit: github, owner, repo, issue, workspace, targetBranch, core,
      forceReprocess: true,
    });
    return;
  }

  if (mode === 'review') {
    // 扫描所有开放的 [Friend Link] Issue
    core.info('🔍 扫描开放的友链申请 Issue...');
    const openIssues = await github.paginate(github.rest.issues.listForRepo, {
      owner, repo, state: 'open', per_page: 100,
    });

    const friendLinkIssues = openIssues.filter(
      (i) => i.title && i.title.startsWith(ISSUE_TITLE_PREFIX)
    );

    core.info(`找到 ${friendLinkIssues.length} 个开放的 [Friend Link] Issue`);

    let processed = 0;
    for (const issue of friendLinkIssues.slice(0, MAX_ISSUES_PER_RUN)) {
      try {
        await processIssue({ octokit: github, owner, repo, issue, workspace, targetBranch, core });
        processed++;
      } catch (e) {
        core.warning(`处理 Issue #${issue.number} 时异常: ${e.message}`);
      }
    }

    core.info(`\n========== 本轮处理完毕：${processed}/${friendLinkIssues.length} ==========`);
    return;
  }

  throw new Error(`未知 mode: ${mode}`);
}
