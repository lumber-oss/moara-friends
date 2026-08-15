// scripts/validate-pr.mjs
// PR 校验逻辑（被 auto-pr.yml 的 triage job 调用）
//
// 用法（在 GitHub Actions 的 actions/github-script@v7 里）：
//   const { runValidation } = await import('./scripts/validate-pr.mjs');
//   await runValidation({ owner, repo, pull_number, prHead, prAuthor, runUrl, github, core });
//
// 注意：actions/github-script 默认用 CommonJS，需要用 dynamic import 引入 ESM 文件

// ========== SSRF 防护 ==========
export function isPublicUrl(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return { ok: false, reason: 'URL 无效' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `协议必须是 http/https（当前：${u.protocol}）` };
  }
  if (u.username || u.password) {
    return { ok: false, reason: 'URL 不能包含用户名/密码' };
  }

  let hostname = u.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return { ok: false, reason: `拒绝 localhost：${hostname}` };
  }

  const isIpv6 = hostname.startsWith('[') && hostname.endsWith(']');
  if (isIpv6) hostname = hostname.slice(1, -1);

  let ipv4 = null;
  if (hostname.includes(':')) {
    if (hostname.includes('ffff:')) {
      return { ok: false, reason: `拒绝 IPv4-mapped IPv6：${hostname}` };
    } else if (hostname === '::1' || hostname === '0:0:0:0:0:0:0:1') {
      return { ok: false, reason: `拒绝 IPv6 回环：${hostname}` };
    } else if (hostname.startsWith('fe80:') || hostname.startsWith('fc') || hostname.startsWith('fd')) {
      return { ok: false, reason: `拒绝 IPv6 链路本地/唯一本地：${hostname}` };
    }
  } else {
    ipv4 = hostname;
  }

  if (ipv4) {
    const m = ipv4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
      const [a, b] = [parseInt(m[1]), parseInt(m[2])];
      if (m.slice(1).some(s => parseInt(s) > 255)) {
        return { ok: false, reason: `IPv4 字段超范围：${ipv4}` };
      }
      if (a === 127) return { ok: false, reason: `拒绝回环地址：${ipv4}` };
      if (a === 10) return { ok: false, reason: `拒绝私有地址 10.0.0.0/8：${ipv4}` };
      if (a === 172 && b >= 16 && b <= 31) return { ok: false, reason: `拒绝私有地址 172.16.0.0/12：${ipv4}` };
      if (a === 192 && b === 168) return { ok: false, reason: `拒绝私有地址 192.168.0.0/16：${ipv4}` };
      if (a === 169 && b === 254) return { ok: false, reason: `拒绝链路本地 169.254.0.0/16：${ipv4}` };
      if (a === 0) return { ok: false, reason: `拒绝 0.0.0.0/8：${ipv4}` };
      if (a === 100 && b >= 64 && b <= 127) return { ok: false, reason: `拒绝 CGNAT 100.64.0.0/10：${ipv4}` };
    }
  }
  return { ok: true };
}

// ========== 可达性检查 ==========
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (compatible; Googlebot/2.1; +https://www.google.com/bot.html)',
];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchPage(url, { timeout = 15000 } = {}) {
  const errors = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const ua = USER_AGENTS[attempt % USER_AGENTS.length];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': ua,
          'Accept': 'text/html,application/xhtml+xml,*/*',
        },
      });
      clearTimeout(timer);
      if (res.status >= 200 && res.status < 400) {
        const text = await res.text();
        return { ok: true, status: res.status, text, finalUrl: res.url };
      }
      errors.push(`HTTP ${res.status}`);
    } catch (e) {
      clearTimeout(timer);
      errors.push(e.name === 'AbortError' ? `超时(${timeout / 1000}s)` : e.message);
    }
    if (attempt < 2) await sleep(500 * Math.pow(3, attempt));
  }
  return { ok: false, errors };
}

async function checkUrlReachable(url, { requireImage = false } = {}) {
  const errors = [];
  const redirects = [];

  for (let attempt = 0; attempt < 3; attempt++) {
    const ua = USER_AGENTS[attempt % USER_AGENTS.length];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': ua,
          'Accept': requireImage ? 'image/*' : '*/*',
          'Range': 'bytes=0-1023',
          'Accept-Encoding': 'identity',
        },
      });
      clearTimeout(timer);

      let finalRes = res;
      let location = res.headers.get('location');
      let hops = 0;
      while ([301, 302, 303, 307, 308].includes(finalRes.status) && location && hops < 5) {
        const redirectCheck = isPublicUrl(location);
        if (!redirectCheck.ok) {
          return { ok: false, errors: [`重定向到非法地址：${redirectCheck.reason}`], redirects, attempts: attempt + 1 };
        }
        redirects.push(`${finalRes.status} → ${location}`);
        const nextUrl = new URL(location, url).href;
        const c2 = new AbortController();
        const t2 = setTimeout(() => c2.abort(), 15000);
        finalRes = await fetch(nextUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: c2.signal,
          headers: {
            'User-Agent': ua,
            'Accept': requireImage ? 'image/*' : '*/*',
            'Range': 'bytes=0-1023',
            'Accept-Encoding': 'identity',
          },
        });
        clearTimeout(t2);
        location = finalRes.headers.get('location');
        hops++;
      }

      if (finalRes.status >= 200 && finalRes.status < 400) {
        if (requireImage) {
          const ct = (finalRes.headers.get('content-type') || '').toLowerCase();
          if (!ct.startsWith('image/')) {
            errors.push(`Content-Type 不是 image/* (实际: ${ct || '空'})`);
            await sleep(500 * Math.pow(3, attempt));
            continue;
          }
        }
        return {
          ok: true,
          status: finalRes.status,
          contentType: finalRes.headers.get('content-type'),
          redirects,
          attempts: attempt + 1,
        };
      }

      if (finalRes.status === 405 || finalRes.status === 403 || finalRes.status === 416) {
        const c3 = new AbortController();
        const t3 = setTimeout(() => c3.abort(), 15000);
        const r3 = await fetch(url, {
          method: 'GET',
          redirect: 'follow',
          signal: c3.signal,
          headers: {
            'User-Agent': ua,
            'Accept': requireImage ? 'image/*' : '*/*',
          },
        });
        clearTimeout(t3);
        if (r3.status >= 200 && r3.status < 400) {
          if (requireImage) {
            const ct = (r3.headers.get('content-type') || '').toLowerCase();
            if (!ct.startsWith('image/')) {
              errors.push(`Content-Type 不是 image/* (实际: ${ct || '空'})`);
              await sleep(500 * Math.pow(3, attempt));
              continue;
            }
          }
          return {
            ok: true,
            status: r3.status,
            contentType: r3.headers.get('content-type'),
            redirects,
            attempts: attempt + 1,
            fallback: true,
          };
        }
        errors.push(`HTTP ${r3.status}`);
      } else {
        errors.push(`HTTP ${finalRes.status}`);
      }
    } catch (e) {
      clearTimeout(timer);
      errors.push(e.name === 'AbortError' ? '超时(15s)' : e.message);
    }
    if (attempt < 2) await sleep(500 * Math.pow(3, attempt));
  }

  return { ok: false, errors, redirects, attempts: 3 };
}

// ========== 反链验证 ==========
function verifyBacklink(html, expected) {
  if (!html || !expected) return { found: false, reason: 'empty input' };
  const target = expected.replace(/\/$/, '').toLowerCase();
  const normalized = html.toLowerCase()
    .replaceAll('\\/', '/')
    .replaceAll('&amp;', '&')
    .replace(/\/+(['"\s>])/g, '$1');
  const patterns = [
    /href\s*=\s*["']([^"']+)["']/gi,
    /href\s*=\s*([^\s>]+)/gi,
  ];
  const foundLinks = [];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(normalized)) !== null) {
      const href = (m[1] || '').trim();
      if (!href.startsWith('http')) continue;
      foundLinks.push(href);
      const linkNorm = href.replace(/\/$/, '');
      if (linkNorm === target) {
        return { found: true, matchedHref: href, links: foundLinks };
      }
    }
  }
  return { found: false, links: foundLinks, target };
}

function getHostname(urlStr) {
  try {
    return new URL(urlStr).hostname;
  } catch {
    return null;
  }
}

// ========== 主校验流程 ==========
export async function runValidation({ owner, repo, pull_number, prHead, prAuthor, runUrl, github, core }) {
  const SITE_URL = 'https://blog.945426.xyz';

  async function closePR() {
    try {
      await github.rest.pulls.update({ owner, repo, pull_number, state: 'closed' });
    } catch (e) {
      core.warning(`close PR failed: ${e.message}`);
    }
  }

  async function fail(title, lines) {
    core.error(`❌ ${title}`);
    for (const l of lines) core.error(`  - ${l}`);

    const body = [
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
      '修改后 push 到本 PR 会触发重新校验。  ',
      `[查看 Action 运行日志](${runUrl})`,
    ].join('\n');
    try {
      await github.rest.issues.createComment({ owner, repo, issue_number: pull_number, body });
    } catch (e) {
      core.warning(`createComment failed: ${e.message}`);
    }
    await closePR();
  }

  // ── 1. PR 文件变更范围校验 ─────────────────────────
  let files = [];
  try {
    for await (const res of github.paginate.iterator(
      github.rest.pulls.listFiles,
      { owner, repo, pull_number, per_page: 100 }
    )) {
      files.push(...res.data);
    }
  } catch (e) {
    await fail('无法读取 PR 文件清单', [`错误：${e.message}`]);
    return;
  }

  if (files.length !== 1) {
    await fail('PR 只能包含一个文件变更', [
      `当前变更数：${files.length}`,
      '请保证每个 PR 仅新增/修改/删除 data/friends/ 下单个 .json 文件。',
    ]);
    return;
  }

  const file = files[0];
  const FRIENDS_PREFIX = 'data/friends/';
  if (!file.filename.startsWith(FRIENDS_PREFIX)) {
    await fail('文件路径不合法', [
      `检测到文件：${file.filename}`,
      `只允许更改 ${FRIENDS_PREFIX} 下的文件。`,
    ]);
    return;
  }

  if (!['added', 'modified', 'removed'].includes(file.status)) {
    await fail('不支持的文件操作', [`status: ${file.status}`]);
    return;
  }

  // ── 2. 删除操作：跳过内容校验，直接合并 ───────────
  if (file.status === 'removed') {
    core.info('删除操作，跳过校验，准备合并');
  } else {
    // ── 3. JSON 解析与 schema 校验 ─────────────────
    if (!file.filename.endsWith('.json')) {
      await fail('文件类型不合法', [
        `检测到非 .json 文件：${file.filename}`,
        'data/friends/ 下只允许 .json 文件。',
      ]);
      return;
    }

    let rawContent = '';
    if (file.patch) {
      rawContent = file.patch
        .split('\n')
        .filter((line) => !line.startsWith('@@') && !line.startsWith('---') && !line.startsWith('+++'))
        .map((line) => (line.startsWith('+') ? line.slice(1) : line.startsWith(' ') ? line.slice(1) : line))
        .join('\n')
        .trim();
    } else if (file.status === 'added' || file.status === 'modified') {
      try {
        const res = await fetch(file.raw_url, {
          headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        rawContent = await res.text();
      } catch (e) {
        await fail('无法读取文件内容', [`错误：${e.message}`, `raw_url: ${file.raw_url}`]);
        return;
      }
    }

    let data;
    try {
      data = JSON.parse(rawContent);
    } catch (e) {
      const lines = [
        `文件：${file.filename}`,
        `错误：${e.message}`,
        '',
      ];

      if (/[""]/.test(rawContent)) {
        lines.push('**检测到中文全角引号**（中文输入法常见问题）');
        lines.push('- ❌ 你用了：`"..."`（弯引号，左右配对）');
        lines.push('- ✅ 应改为：`"..."`（直引号，同一个字符）');
        lines.push('- 区别：中文引号是弯的 `""`，ASCII 引号是直的 `""`');
        lines.push('');
      }
      if (/[：，]/.test(rawContent)) {
        lines.push('**检测到中文全角标点**');
        lines.push('- ❌ 你用了：`：` 或 `，`（全角）');
        lines.push('- ✅ 应改为：`:` 或 `,`（半角）');
        lines.push('');
      }
      if (/'[^']*'\s*:|:\s*'[^']*'/.test(rawContent)) {
        lines.push('**检测到单引号字符串**');
        lines.push("- ❌ 你用了：`'...'`（单引号）");
        lines.push('- ✅ 应改为：`"..."`（双引号）');
        lines.push('');
      }
      if (/,\s*[}\]]/.test(rawContent)) {
        lines.push('**检测到尾逗号**');
        lines.push('- ❌ 你写了：`{ "a": 1, }`（最后一个属性后有逗号）');
        lines.push('- ✅ 应改为：`{ "a": 1 }`（删除 `}` 前的逗号）');
        lines.push('');
      }
      if (rawContent.charCodeAt(0) === 0xFEFF) {
        lines.push('**检测到 BOM 头**');
        lines.push('- ❌ 文件以 UTF-8 BOM 开头（不可见字符）');
        lines.push('- ✅ 用编辑器另存为「UTF-8（无 BOM）」');
        lines.push('');
      }
      if (/^\s*\/\//m.test(rawContent) || /^\s*\/\*/m.test(rawContent)) {
        lines.push('**检测到注释**');
        lines.push('- ❌ 你写了：`// 注释` 或 `/* 注释 */`');
        lines.push('- ✅ JSON 不支持注释，请删除所有注释');
        lines.push('');
      }

      lines.push('**修复方法**：');
      lines.push('1. 用 [JSONLint](https://jsonlint.com/) 校验你的 JSON 语法');
      lines.push('2. 把所有中文引号 `"..."` 替换为 ASCII 引号 `"..."`');
      lines.push('3. 把所有中文标点 `：，` 替换为 ASCII 标点 `:,`');
      lines.push('4. 修改后 push 到本 PR 触发重新校验');

      await fail('JSON 解析失败', lines);
      return;
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      await fail('JSON 类型错误', ['JSON 必须是对象，不能是数组或基本类型。']);
      return;
    }

    const errs = [];
    const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
    const isNullOrString = (v) => v === null || typeof v === 'string';
    const isHttpUrl = (v) => {
      if (typeof v !== 'string') return false;
      try {
        const u = new URL(v);
        return u.protocol === 'http:' || u.protocol === 'https:';
      } catch { return false; }
    };

    if (!isNonEmptyString(data.name)) errs.push('`name` 必填且为非空字符串');
    if (!isNonEmptyString(data.url)) errs.push('`url` 必填且为非空字符串');
    else if (!isHttpUrl(data.url)) errs.push('`url` 必须是 `http://` 或 `https://` URL');
    if (data.avatar !== undefined && !isNullOrString(data.avatar))
      errs.push('`avatar` 必须是字符串或 `null`（或省略）');
    if (data.description !== undefined && typeof data.description !== 'string')
      errs.push('`description` 必须是字符串（或省略）');

    if (!isNonEmptyString(data.backlink)) {
      errs.push('`backlink` 必填且为非空字符串（你的友链页 URL）');
    } else if (!isHttpUrl(data.backlink)) {
      errs.push('`backlink` 必须是 `http://` 或 `https://` URL');
    }

    if (Object.prototype.hasOwnProperty.call(data, 'vip')) {
      await fail('检测到 vip 字段，已终止', [
        'vip 字段仅站主直推 main 时可用，PR 不可携带。',
        `文件：${file.filename}`,
        '请删除 vip 字段后重新 push。',
      ]);
      return;
    }

    if (errs.length) {
      await fail('数据校验未通过', [`文件：${file.filename}`, ...errs]);
      return;
    }

    // ── 5. SSRF 防护：检查 url / avatar / backlink ──
    const ssrfErrors = [];
    const urlSsrf = isPublicUrl(data.url);
    if (!urlSsrf.ok) ssrfErrors.push(`\`url\`：${urlSsrf.reason}`);

    if (typeof data.avatar === 'string' && data.avatar.trim()) {
      const avSsrf = isPublicUrl(data.avatar);
      if (!avSsrf.ok) ssrfErrors.push(`\`avatar\`：${avSsrf.reason}`);
    }

    const blSsrf = isPublicUrl(data.backlink);
    if (!blSsrf.ok) ssrfErrors.push(`\`backlink\`：${blSsrf.reason}`);

    if (ssrfErrors.length) {
      await fail('SSRF 防护：URL 不合法', [
        '检测到不可访问的地址（仅允许公网 http/https 地址）：',
        '',
        ...ssrfErrors,
        '',
        '禁止使用：localhost、私有 IP（10.x / 172.16-31.x / 192.168.x）、链路本地（169.254.x）、云元数据端点等。',
      ]);
      return;
    }

    // ── 6. backlink 域名一致性校验 ────────────────
    const urlHost = getHostname(data.url);
    const backlinkHost = getHostname(data.backlink);
    if (urlHost && backlinkHost && urlHost !== backlinkHost) {
      await fail('backlink 域名不一致', [
        `你的 url 主域名：\`${urlHost}\``,
        `你的 backlink 主域名：\`${backlinkHost}\``,
        '两者必须一致（backlink 必须是你自己网站的友链页）。',
      ]);
      return;
    }

    const siteHost = getHostname(SITE_URL);
    if (backlinkHost && siteHost && backlinkHost === siteHost) {
      await fail('backlink 指向本站', [
        'backlink 字段应填写**你自己**网站的友链页 URL，不能指向本站。',
        `本站 URL：\`${SITE_URL}\``,
      ]);
      return;
    }

    // ── 7. URL + avatar 可达性检查（并行）─────────
    core.info('🌐 正在并行检查站点 URL 和头像 URL 可达性...');

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
      await fail('URL 可达性检查未通过', lines);
      return;
    }

    // ── 8. 反链验证 ────────────────────────────────
    core.info(`🔗 正在抓取 backlink 页面检查反链：${data.backlink}`);

    const pageRes = await fetchPage(data.backlink);
    if (!pageRes.ok) {
      await fail('反链验证：无法访问 backlink 页面', [
        `backlink URL：\`${data.backlink}\``,
        `抓取失败：${pageRes.errors.join('；')}`,
        '',
        '请确认你的友链页 URL 正确且可公开访问。',
      ]);
      return;
    }

    core.info(`✓ backlink 页面抓取成功 (HTTP ${pageRes.status}, ${pageRes.text.length} bytes)`);

    const backlinkResult = verifyBacklink(pageRes.text, SITE_URL);
    if (!backlinkResult.found) {
      const lines = [
        `在 backlink 页面未检测到本站友链链接。`,
        '',
        `**需要添加的链接**：\`${SITE_URL}\``,
        `**你的 backlink 页面**：\`${data.backlink}\``,
        '',
        `页面中检测到 ${backlinkResult.links.length} 个 http(s) 链接，但都不匹配本站 URL。`,
        '',
        '**常见原因**：',
        '- 友链页还没添加本站链接，或链接 URL 不完全一致',
        '- 友链页是 JavaScript 动态渲染的（workflow 只抓静态 HTML）',
        '- 友链页需要登录或被防火墙拦截',
        '- CDN 缓存返回了旧版本（等待几分钟后再 push）',
        '',
        '**修复方法**：',
        `1. 在你的友链页添加：<a href="${SITE_URL}">沫然Blog</a>`,
        '2. 确保 href 是绝对链接且 URL 完全一致',
        '3. push 更新本 PR 触发重新校验',
      ];
      await fail('反链验证未通过', lines);
      return;
    }

    core.info(`✓ 反链验证通过：找到匹配链接 ${backlinkResult.matchedHref}`);
  }

  // ── 9. 自动合并 ────────────────────────────────────
  core.info('✅ 所有校验通过（含反链验证 + SSRF 防护），执行自动合并');

  try {
    const mergeRes = await github.rest.pulls.merge({
      owner,
      repo,
      pull_number,
      merge_method: 'squash',
      commit_title: `friends: ${file.status} ${file.filename} (#${pull_number})`,
      commit_message: `由 auto-pr workflow 自动合并（含反链验证 + SSRF 防护）\n\nCo-authored-by: ${prAuthor}`,
    });
    core.info(`✅ 合并成功：${mergeRes.data.sha}`);

    try {
      await github.rest.actions.createWorkflowDispatch({
        owner, repo, workflow_id: 'build.yml', ref: 'main',
      });
      core.info('✅ build workflow 已触发');
    } catch (e) {
      core.warning(`trigger build workflow failed: ${e.message}`);
    }
  } catch (e) {
    await fail('自动合并失败', [`错误：${e.message}`, '请手动合并此 PR 或联系仓库管理员。']);
  }
}
