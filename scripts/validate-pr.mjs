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

  // IPv6 hostname 带方括号，先去掉再检查
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }

  let ipv4 = null;
  if (hostname.includes(':')) {
    // IPv6（去括号后）
    if (hostname.includes('ffff:')) {
      return { ok: false, reason: `拒绝 IPv4-mapped IPv6：${hostname}` };
    }
    // 归一化：去掉前导零压缩
    const normalized = hostname.replace(/(^|:)0+(?=:|$)/g, '$1').replace(/^0+:/, '0:');
    if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
      return { ok: false, reason: `拒绝 IPv6 回环：${hostname}` };
    }
    if (normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) {
      return { ok: false, reason: `拒绝 IPv6 链路本地/唯一本地：${hostname}` };
    }
    if (normalized.startsWith('ff')) {
      return { ok: false, reason: `拒绝 IPv6 多播：${hostname}` };
    }
    if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') {
      return { ok: false, reason: `拒绝 IPv6 未指定地址：${hostname}` };
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
      if (a === 192 && b === 0 && parseInt(m[3]) === 2) return { ok: false, reason: `拒绝 TEST-NET-1 192.0.2.0/24：${ipv4}` };
      if (a === 192 && b === 0 && parseInt(m[3]) === 0) return { ok: false, reason: `拒绝 IETF 协议分配 192.0.0.0/24：${ipv4}` };
      if (a === 198 && (b === 51 && parseInt(m[3]) === 100)) return { ok: false, reason: `拒绝 TEST-NET-2 198.51.100.0/24：${ipv4}` };
      if (a === 203 && b === 0 && parseInt(m[3]) === 113) return { ok: false, reason: `拒绝 TEST-NET-3 203.0.113.0/24：${ipv4}` };
      if (a === 198 && (b === 18 || b === 19)) return { ok: false, reason: `拒绝基准测试 198.18.0.0/15：${ipv4}` };
      if (a >= 224) return { ok: false, reason: `拒绝多播/保留地址：${ipv4}` };
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
      let currentUrl = url;
      let finalRes = null;
      let hops = 0;

      // 手动跟随重定向，每跳都做 SSRF 检查
      while (hops < 5) {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), timeout);
        const res = await fetch(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: c.signal,
          headers: {
            'User-Agent': ua,
            'Accept': 'text/html,application/xhtml+xml,*/*',
          },
        });
        clearTimeout(t);

        if ([301, 302, 303, 307, 308].includes(res.status)) {
          const location = res.headers.get('location');
          if (!location) break;
          const nextUrl = new URL(location, currentUrl).href;
          const ssrfCheck = isPublicUrl(nextUrl);
          if (!ssrfCheck.ok) {
            return { ok: false, errors: [`重定向到非法地址：${ssrfCheck.reason}`] };
          }
          currentUrl = nextUrl;
          hops++;
          continue;
        }

        finalRes = res;
        break;
      }

      if (finalRes && finalRes.status >= 200 && finalRes.status < 400) {
        const text = await finalRes.text();
        return { ok: true, status: finalRes.status, text, finalUrl: currentUrl };
      }
      errors.push(`HTTP ${finalRes ? finalRes.status : 'unknown'}`);
    } catch (e) {
      clearTimeout(timer);
      errors.push(e.name === 'AbortError' ? `超时(${timeout / 1000}s)` : e.message);
    }
    if (attempt < 2) await sleep(500 * Math.pow(3, attempt));
  }
  return { ok: false, errors };
}

// Playwright 渲染抓取（处理 JS 动态渲染的友链页）
// 浏览器按需安装——静态 fetch 找不到回链时才安装，节省大部分 PR 的时间
let playwrightInstalled = false;

async function ensurePlaywrightBrowser() {
  if (playwrightInstalled) return;
  const { execFileSync } = await import('node:child_process');
  console.log('📦 安装 Playwright 浏览器（约 20 秒）...');
  execFileSync('npx', ['playwright', 'install', 'chromium', '--with-deps'], {
    stdio: 'inherit',
    timeout: 120000,
  });
  playwrightInstalled = true;
  console.log('✓ Playwright 浏览器安装完成');
}

async function fetchWithPlaywright(url) {
  await ensurePlaywrightBrowser();

  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');

  // 使用唯一临时目录，避免并发冲突
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moara-pw-'));
  const scriptPath = path.join(tmpDir, 'fetch-pw.mjs');
  const script = `
    import { createRequire } from 'module';
    const require = createRequire('${process.cwd()}/');
    const { chromium } = require('@playwright/test');
    const targetUrl = process.argv[2];

    const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

    async function fetchOnce() {
      let browser;
      try {
        browser = await chromium.launch({
          headless: true,
          args: ['--disable-blink-features=AutomationControlled'],
        });
        const context = await browser.newContext({
          userAgent: CHROME_UA,
          locale: 'zh-CN',
          timezoneId: 'Asia/Shanghai',
          viewport: { width: 1920, height: 1080 },
          extraHTTPHeaders: {
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          },
        });

        await context.addInitScript(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
          Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
          Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
          window.chrome = { runtime: {} };
        });

        const page = await context.newPage();

        const response = await page.goto(targetUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });

        try {
          await page.waitForLoadState('networkidle', { timeout: 5000 });
        } catch {}

        const body = await page.content();
        const finalUrl = page.url();
        const status = response ? response.status() : 0;
        await browser.close();
        return { ok: status >= 200 && status < 400, status, text: body, finalUrl };
      } catch (e) {
        if (browser) await browser.close();
        return { ok: false, error: e.message };
      }
    }

    let result = await fetchOnce();
    if (!result.ok) {
      await new Promise(r => setTimeout(r, 2000));
      result = await fetchOnce();
    }
    console.log(JSON.stringify(result));
  `;
  fs.writeFileSync(scriptPath, script);

  try {
    const output = execFileSync('node', [scriptPath, url], {
      cwd: tmpDir,
      encoding: 'utf8',
      timeout: 90000,
      maxBuffer: 20 * 1024 * 1024,
    });
    const result = JSON.parse(output.trim().split('\n').pop());
    if (result.ok) {
      return { ok: true, status: result.status, text: result.text, finalUrl: result.finalUrl };
    }
    return { ok: false, errors: [result.error || '未知错误'] };
  } catch (e) {
    return { ok: false, errors: [e.message] };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
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
        // 先解析为绝对 URL，再做 SSRF 检查（location 可能是相对路径如 /newpage）
        const nextUrl = new URL(location, url).href;
        const redirectCheck = isPublicUrl(nextUrl);
        if (!redirectCheck.ok) {
          return { ok: false, errors: [`重定向到非法地址：${redirectCheck.reason}`], redirects, attempts: attempt + 1 };
        }
        redirects.push(`${finalRes.status} → ${nextUrl}`);
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

// ========== 回链验证 ==========
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
export async function runValidation({ owner, repo, pull_number, prHead, prAuthor, runUrl, github, core, baseSha }) {
  const SITE_URL = 'https://blog.945426.xyz';

  // ========== Tag 管理 ==========
  const LABEL_FRIEND = '友链';
  const LABEL_OK = '已互链';
  const LABEL_FAIL = '未通过';

  async function ensureLabel(name, color) {
    try {
      await github.rest.issues.getLabel({ owner, repo, name });
    } catch (e) {
      if (e.status === 404) {
        try {
          await github.rest.issues.createLabel({ owner, repo, name, color });
          core.info(`✓ 创建 label: ${name} (#${color})`);
        } catch (createErr) {
          core.warning(`创建 label ${name} 失败: ${createErr.message}`);
        }
      } else {
        core.warning(`查询 label ${name} 失败: ${e.message}`);
      }
    }
  }

  async function syncLabels({ add = [], remove = [] }) {
    const labelColors = { [LABEL_FRIEND]: '0e8a16', [LABEL_OK]: '0e8a16', [LABEL_FAIL]: 'd73a4a' };
    for (const name of add) {
      await ensureLabel(name, labelColors[name] || 'ededed');
    }

    if (add.length) {
      try {
        await github.rest.issues.addLabels({
          owner, repo, issue_number: pull_number, labels: add,
        });
        core.info(`✓ 打 tag: ${add.join(', ')}`);
      } catch (e) {
        core.warning(`addLabels 失败: ${e.message}`);
      }
    }

    for (const name of remove) {
      try {
        await github.rest.issues.removeLabel({
          owner, repo, issue_number: pull_number, name,
        });
        core.info(`✓ 删除 tag: ${name}`);
      } catch (e) {
        if (e.status !== 404) {
          core.warning(`removeLabel ${name} 失败: ${e.message}`);
        }
      }
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
      '解决后，关闭并重新打开该 PR 会自动触发重新校验。',
      `[查看 Action 运行日志](${runUrl})；[联系moara](mailto:moara@foxmail.com)`,
    ].join('\n');
    try {
      await github.rest.issues.createComment({ owner, repo, issue_number: pull_number, body });
    } catch (e) {
      core.warning(`createComment failed: ${e.message}`);
    }

    await syncLabels({ add: [LABEL_FRIEND, LABEL_FAIL], remove: [LABEL_OK] });
  }

  // ── 0. 合并冲突检查 ──
  try {
    const prInfo = await github.rest.pulls.get({ owner, repo, pull_number });
    core.info(`pr.mergeable=${prInfo.data.mergeable}, pr.mergeable_state=${prInfo.data.mergeable_state}`);
    if (prInfo.data.mergeable === false) {
      await fail('存在合并冲突', [
        '你的 PR 有冲突，可能是文件名和已有友链重复。',
        '',
        '**解决方法**：',
        '1. 改用不同的文件名',
        '2. Sync fork 与本仓库完全同步，重新修改',
      ]);
      return;
    }
  } catch (e) {
    core.warning(`检查 mergeable 失败: ${e.message}`);
  }

  // ── 1. PR 文件变更范围校验 ──
  let files = [];
  try {
    for await (const res of github.paginate.iterator(
      github.rest.pulls.listFiles,
      { owner, repo, pull_number, per_page: 100 }
    )) {
      files.push(...res.data);
    }
  } catch (e) {
    await fail('无法读取文件清单', [`错误：${e.message}`]);
    return;
  }

  if (files.length !== 1) {
    await fail('只能包含一个文件变更', [
      `当前变更数：${files.length}`,
      '请保证每个 PR 仅新增/修改/删除 data/friends/ 下单个 .json 文件',
    ]);
    return;
  }

  const file = files[0];
  const FRIENDS_PREFIX = 'data/friends/';
  if (!file.filename.startsWith(FRIENDS_PREFIX)) {
    await fail('文件路径不合法', [
      `检测到文件：${file.filename}`,
      '只允许更改 data/friends/ 下的文件',
    ]);
    return;
  }

  if (!['added', 'modified', 'removed'].includes(file.status)) {
    await fail('不支持的文件操作', [`status: ${file.status}`]);
    return;
  }

  // ── 2. 修改/删除操作：DNS TXT 域名所有权验证 ──
  // 不依赖 file.status（fork PR 总是 added），而是检查 main 是否已有该文件
  // 如果 main 已有 → 是修改/删除操作 → 需要 DNS 验证
  let fileExistsInMain = false;
  let originalUrl = null;
  try {
    const baseRes = await github.rest.repos.getContent({
      owner, repo, path: file.filename, ref: baseSha,
    });
    if (!Array.isArray(baseRes.data) && baseRes.data.content) {
      fileExistsInMain = true;
      const raw = Buffer.from(baseRes.data.content, baseRes.data.encoding || 'base64').toString('utf-8');
      const parsed = JSON.parse(raw);
      if (parsed.url) originalUrl = parsed.url;
    }
  } catch (e) {
    // 404 = 文件不存在于 main → 新增操作，不需要 DNS 验证
    if (e.status !== 404) {
      core.warning(`检查 base 文件失败: ${e.message}`);
    }
  }

  if (fileExistsInMain) {
    const isDelete = file.status === 'removed' || (file.status === 'added' && !file.patch);
    core.info(`检测到修改/删除操作（已有 ${file.filename}），需要 DNS TXT 域名所有权验证`);

    if (originalUrl) {
      let hostname = null;
      try { hostname = new URL(originalUrl).hostname; } catch {}

      if (hostname) {
        const expected = `moara-friends=${pull_number}`;
        const dns = (await import('node:dns')).promises;
        const domains = [hostname, `_moara-friends.${hostname}`];
        let verified = false;

        for (const d of domains) {
          try {
            const records = await dns.resolveTxt(d);
            const flat = records.flat();
            if (flat.some(t => t.includes(expected))) {
              verified = true;
              core.info(`✓ DNS TXT 验证通过: ${d}`);
              break;
            }
          } catch {}
        }

        if (!verified) {
          await fail('域名所有权验证失败', [
            `你正在修改/删除现有的友链数据。为了防止恶意改动，请完成域名所有权验证：`,
            '',
            `1. 在域名 \`${hostname}\` 或 \`_moara-friends.${hostname}\` 下添加 DNS TXT 记录`,
            `2. 记录内容：\`${expected}\``,
            '',
            `原始文件 URL：\`${originalUrl}\``,
          ]);
          return;
        }
      }
    } else {
      core.warning('无法读取原始文件 URL，跳过 DNS 验证');
    }
  }

  // ── 3. 删除操作：跳过内容校验 ──
  if (file.status === 'removed') {
    core.info('删除操作，跳过校验');
  } else {
    // ── 3. JSON 解析与 schema 校验 ──
    if (!file.filename.endsWith('.json')) {
      await fail('文件类型不合法', [
        `检测到非 .json 文件：${file.filename}`,
        'data/friends/ 下只允许 .json 文件',
      ]);
      return;
    }

    let rawContent = '';
    // 优先用 raw_url 读取完整文件内容
    // file.patch 解析有风险（大文件截断、二进制 diff 等）
    if (file.status === 'added' || file.status === 'modified') {
      try {
        const res = await fetch(file.raw_url, {
          headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        rawContent = await res.text();
      } catch (e) {
        // raw_url 失败时 fallback 到 patch 解析
        if (file.patch) {
          rawContent = file.patch
            .split('\n')
            .filter((line) => !line.startsWith('@@') && !line.startsWith('---') && !line.startsWith('+++'))
            .map((line) => (line.startsWith('+') ? line.slice(1) : line.startsWith(' ') ? line.slice(1) : line))
            .join('\n')
            .trim();
        } else {
          await fail('无法读取文件内容', [`错误：${e.message}`, `raw_url: ${file.raw_url}`]);
          return;
        }
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
        lines.push('**检测到中文全角引号**');
        lines.push('- ❌ 你用了：`"..."`（弯引号，左右配对）');
        lines.push('- ✅ 应改为：`"..."`（直引号，同一个字符）');
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

      lines.push('**解决方法**：');
      lines.push('1. 用 [JSONLint](https://jsonlint.com/) 校验');
      lines.push('2. 把中文符号替换为英文符号');

      await fail('解析失败', lines);
      return;
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      await fail('JSON 类型错误', ['JSON 必须是对象，不能是数组或基本类型']);
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
      await fail('检测到 vip 字段', [
        'vip 字段仅站主直推可用，PR 不可携带',
        `文件：${file.filename}`,
        '请删除 vip 字段',
      ]);
      return;
    }

    if (errs.length) {
      await fail('数据校验未通过', [`文件：${file.filename}`, ...errs]);
      return;
    }

    // ── 5. SSRF 防护 ──
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
      await fail('URL 不合法', [
        '检测到不可访问的地址：',
        '',
        ...ssrfErrors,
        '',
        '禁止使用：localhost、私有 IP、链路本地、云元数据端点等',
      ]);
      return;
    }

    // ── 6. backlink 域名一致性校验 ──
    const urlHost = getHostname(data.url);
    const backlinkHost = getHostname(data.backlink);
    if (urlHost && backlinkHost && urlHost !== backlinkHost) {
      await fail('backlink 域名不一致', [
        `你的 url 域名：\`${urlHost}\``,
        `你的 backlink 域名：\`${backlinkHost}\``,
        '两者必须一致（backlink 必须是你自己网站的友链页）',
      ]);
      return;
    }

    const siteHost = getHostname(SITE_URL);
    if (backlinkHost && siteHost && backlinkHost === siteHost) {
      await fail('backlink 指向本站', [
        'backlink 字段应填写你自己网站的友链页 URL，不能指向本站',
        `本站 URL：\`${SITE_URL}\``,
      ]);
      return;
    }

    // ── 7. URL + avatar 可达性检查（并行）───
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
      await fail('可达性检查未通过', lines);
      return;
    }

    // ── 8. 回链验证 ───
    core.info(`🔗 正在抓取友链页面检查回链：${data.backlink}`);

    const pageRes = await fetchPage(data.backlink);
    if (!pageRes.ok) {
      await fail('回链验证：无法访问友链页面', [
        `backlink URL：\`${data.backlink}\``,
        `抓取失败：${pageRes.errors.join('；')}`,
        '',
        '请确认你的友链页 URL 正确且可公开访问',
      ]);
      return;
    }

    core.info(`✓ 友链页面抓取成功 (HTTP ${pageRes.status}, ${pageRes.text.length} bytes)`);

    let backlinkResult = verifyBacklink(pageRes.text, SITE_URL);
    let usedPlaywright = false;

    if (!backlinkResult.found) {
      core.info(`⚠️ 静态 HTML 未找到回链，尝试用 Playwright 渲染（处理 JS 动态页面）...`);
      const pwRes = await fetchWithPlaywright(data.backlink);
      if (pwRes.ok) {
        core.info(`✓ Playwright 渲染成功 (${pwRes.text.length} bytes)`);
        backlinkResult = verifyBacklink(pwRes.text, SITE_URL);
        usedPlaywright = true;
      } else {
        core.warning(`Playwright 渲染失败：${pwRes.errors.join('；')}`);
      }
    }

    if (!backlinkResult.found) {
      const lines = [
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
        '3. 等待 CDN 刷新',
      ];
      await fail('回链验证未通过', lines);
      return;
    }

    core.info(`✓ 回链验证通过：找到匹配链接 ${backlinkResult.matchedHref}${usedPlaywright ? '（Playwright 渲染）' : '（静态 HTML）'}`);
  }

  // ── 9. 自动合并 ───
  core.info('✅ 所有校验通过，执行自动合并');

  try {
    const mergeRes = await github.rest.pulls.merge({
      owner,
      repo,
      pull_number,
      merge_method: 'squash',
      commit_title: `friends: ${file.status} ${file.filename} (#${pull_number})`,
      commit_message: `由 auto-pr workflow 自动合并\n\nCo-authored-by: ${prAuthor}`,
    });
    core.info(`✅ 合并成功：${mergeRes.data.sha}`);

    await syncLabels({ add: [LABEL_FRIEND, LABEL_OK], remove: [LABEL_FAIL] });

    try {
      await github.rest.actions.createWorkflowDispatch({
        owner, repo, workflow_id: 'build.yml', ref: 'main',
      });
      core.info('✅ build workflow 已触发');
    } catch (e) {
      core.warning(`trigger build workflow failed: ${e.message}`);
    }
  } catch (e) {
    await fail('自动合并失败', [`错误：${e.message}`, '请手动合并此 PR 或联系[moara](mailto:moara@foxmail.com)。']);
  }
}
