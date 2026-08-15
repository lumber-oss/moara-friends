# moara-friends

MOARA 博客的友链数据源 —— 单文件一条 + GitHub Action 自动校验 + 反链验证 + 自动合并，jsDelivr 分发。

## 工作流程

```
贡献者 → Fork → 在 data/friends/ 新建 JSON（含 backlink 字段）→ PR
                                                              │
                                                    ┌─────────▼──────────┐
                                                    │ auto-pr.yml        │
                                                    │  · 单文件校验       │
                                                    │  · JSON schema      │
                                                    │  · vip 字段拒绝     │
                                                    │  · URL 可达性检查    │
                                                    │  · 反链验证：        │
                                                    │    fetch backlink  │
                                                    │    页面，找本站 URL │
                                                    └─────┬───────┬──────┘
                                                          │       │
                                        ┌──── 失败 ───────┘       └──── 通过 ────┐
                                        │                                         │
                             ┌──────────▼──────────┐               ┌────────────▼────────────┐
                             │ 评论失败原因 + 关闭 PR │               │ 自动 squash merge        │
                             │ 贡献者收到 closed 邮件 │               │ 触发 build workflow      │
                             └─────────────────────┘               │ friends.json 自动更新    │
                                                                   └─────────────────────────┘
```

## 目录结构

```
moara-friends/
├── data/
│   └── friends/              # 每文件一条友链
│       └── moara.json        # 示例（站主自己）
├── scripts/
│   └── build.js              # 合并 + 排序脚本
├── .github/workflows/
│   ├── build.yml             # main 分支 push 触发，重建 friends.json
│   └── auto-pr.yml           # PR 校验 + 反链验证 + 自动合并
├── friends.json              # build 产物，jsDelivr 直接读取
├── package.json
└── README.md
```

## 添加友链

### 步骤

1. **先在你的网站友链页添加本站链接**（必须，否则反链验证会失败）：

   ```html
   <a href="https://blog.945426.xyz/">沫然Blog</a>
   ```

   或 Markdown：
   ```markdown
   [沫然Blog](https://blog.945426.xyz/)
   ```

   ⚠️ href 必须是 `https://blog.945426.xyz` 或 `https://blog.945426.xyz/`（带不带尾斜杠都行，workflow 会归一化）

2. **Fork** 本仓库
3. 在 `data/friends/` 目录下新建一个 JSON 文件（文件名随意，建议用站点名，如 `example.json`）
4. 按下面模板填写（**`backlink` 字段填你自己网站的友链页 URL**）
5. 提交代码，创建 Pull Request
6. workflow 自动校验 + 反链验证，通过后自动合并，数分钟后 jsDelivr 缓存刷新

### 站主直推 main（仅站主）

站主可直接 commit 到 main 分支，可以给特定友链加 `vip: true`。直推 main 不需要 `backlink` 字段。

> ⚠️ 通过 PR 提交时**不能**携带 `vip` 字段，会被 workflow 拒绝。

## 数据格式

### 完整模板

```json
{
  "name": "你的站点名",
  "avatar": "https://.../头像.png",
  "description": "一句话简介",
  "url": "https://你的站点/",
  "backlink": "https://你的站点/friends/"
}
```

### 最小可用

```json
{
  "name": "你的站点名",
  "url": "https://你的站点/",
  "backlink": "https://你的站点/friends/"
}
```

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | ✅ | 站点名称 |
| `url` | string | ✅ | 站点 URL，必须以 `http://` 或 `https://` 开头 |
| `backlink` | string | ✅（PR） | **你的友链页 URL**，必须与 `url` 主域名一致。workflow 会抓取此页面检查是否包含本站链接 |
| `avatar` | string \| null | ❌ | 头像 URL，建议正方形。缺失时前端可用 favicon 服务兜底 |
| `description` | string | ❌ | 一句话简介 |
| `vip` | boolean | ❌ | **仅站主直推 main 时可用**。PR 携带会被自动拒绝 |

> 📝 `backlink` 字段只用于 PR 反链验证，不会写入输出的 `friends.json`（前端不需要这个字段）。

## 校验规则

PR 提交后，`auto-pr.yml` 会执行以下校验：

1. **单文件**：PR 只能修改 `data/friends/` 下**一个** `.json` 文件
2. **schema**：`name`/`url`/`backlink` 必填、`url`/`backlink` 必须是 http(s)、`avatar` 必须是字符串或 null
3. **vip 拒绝**：PR 中检测到 `vip` 字段立即终止
4. **域名一致性**：`backlink` 的主域名必须与 `url` 主域名一致（防伪造）
5. **backlink 不能指向本站**：防止填错
6. **SSRF 防护**：拒绝 localhost / 私有 IP（10.x / 172.16-31.x / 192.168.x）/ 链路本地（169.254.x，含云元数据）/ IPv6 回环 / IPv4-mapped IPv6 等
7. **URL 可达性**：多 UA 轮换 + 3 次重试 + Content-Type 校验（avatar 必须是 image/*）
8. **反链验证**：fetch `backlink` 页面 HTML，用正则提取所有 `href`，检查是否包含 `https://blog.945426.xyz`

### 失败时

- 评论错误清单 + 修复指引 + Action 日志链接
- 自动关闭 PR（PR 事件触发时）
- 贡献者收到 closed 邮件 + 评论邮件

### 成功时

- 自动 squash merge 到 main
- 触发 build workflow 重建 friends.json
- jsDelivr CDN 缓存数分钟内刷新
- 不发评论（GitHub 默认会发 merged 邮件给贡献者）

## 评论触发重新校验

如果 PR 因为反链验证失败（比如对方友链页 CDN 缓存还没刷新），可以在 PR 评论：

```
/recheck
```

或中文：

```
/重新校验
```

workflow 会重新拉取最新 commit SHA 重新校验。

**权限**：
- ✅ PR 作者可以评论触发
- ✅ 仓库协作者（admin/maintain/write）可以评论触发
- ❌ 其他用户评论会被拒绝并提示

**与 push 触发的区别**：
- push 触发（`synchronize` 事件）：失败会关闭 PR
- 评论触发（`/recheck`）：失败**不关闭** PR，方便用户继续修复

## 反链验证细节

### 工作原理

1. workflow fetch 贡献者提供的 `backlink` URL（多 UA + 3 次重试 + 15s 超时）
2. 从 HTML 中用正则提取所有 `href="..."` 链接
3. 归一化处理（小写、去尾斜杠、处理 `\/` 转义、`&amp;` 实体等）
4. 检查是否有链接等于 `https://blog.945426.xyz`（或带尾斜杠）
5. 找到 → 通过；未找到 → 失败并告知原因

### 静态 HTML 限制

workflow 只抓取静态 HTML，**不执行 JavaScript**。如果友链页是 SPA 或 JS 动态渲染的，反链验证可能失败。解决方案：

- 用 SSR / SSG（推荐）
- 或在静态 HTML 中预渲染友链链接（如构建时生成）
- 或在 HTML 中放一个隐藏的 `<a href="https://blog.945426.xyz/" style="display:none">沫然Blog</a>`

## 邮件通知机制

依赖 GitHub 默认通知行为，workflow 不发额外邮件：

| 事件 | 接收者 | 机制 |
|---|---|---|
| 贡献者开 PR | watch 仓库的人 | GitHub PR 创建通知 |
| 校验失败 | 贡献者 | PR 作者自动 participating + 评论 + closed |
| 校验通过 + 自动合并 | 贡献者 | PR 作者自动 participating + merged |

> ⚠️ 2025-05-18 起 GitHub 默认关闭"自动 watch 自己创建的仓库"。如果 owner 没手动 watch 本仓库，PR 创建时可能收不到邮件——但反链验证 + 自动合并的流程不依赖 owner 通知。

## 排序规则

构建时按以下顺序排序：

1. `vip: true` 的条目优先
2. 同级按 `name` 的拼音排序（`zh-CN` locale）

排序稳定，保证 jsDelivr 缓存命中率。

## 不做的事

- ❌ DNS 所有权验证
- ❌ Playwright 渲染（用纯 fetch 静态 HTML）
- ❌ 爬虫 / 友链朋友圈
- ❌ feed / RSS 抓取
- ❌ 成功评论 / 欢迎评论 / 进度评论
- ❌ workflow 自定义邮件（依赖 GitHub 默认通知）

## jsDelivr 缓存

jsDelivr CDN 缓存约 12 小时。强制刷新：

```
https://purge.jsdelivr.net/gh/moaradc/moara-friends@main/friends.json
```

或在 URL 后加版本号绕过缓存：

```
https://cdn.jsdelivr.net/gh/moaradc/moara-friends@<commit-sha>/friends.json
```

## 前端集成

主站只需在 `vercel.json` 加一条 rewrite，或在 JS 中直接 fetch：

```js
fetch('https://cdn.jsdelivr.net/gh/moaradc/moara-friends@main/friends.json')
  .then(r => r.json())
  .then(friends => { /* 渲染卡片 */ });
```
