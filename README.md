# moara-friends

MOARA 博客的友链数据源 —— 单文件一条 + GitHub Action 自动校验 / 人工审核 / 自动构建，jsDelivr 分发。

## 工作流程

```
贡献者 → Fork → 在 data/friends/ 新建一个 JSON 文件 → PR
                                                    │
                                          ┌─────────▼──────────┐
                                          │ auto-pr.yml        │
                                          │  · 单文件校验       │
                                          │  · JSON schema      │
                                          │  · vip 字段拒绝     │
                                          │  · URL 可达性检查    │
                                          └─────┬───────┬──────┘
                                                │       │
                              ┌───── 失败 ──────┘       └───── 通过 ──────┐
                              │                                           │
                   ┌──────────▼──────────┐               ┌────────────────▼────────────────┐
                   │ 评论错误清单 + 关闭 PR │               │ 评论 @owner 请求人工审核          │
                   │ 贡献者收到 closed 邮件 │               │ owner 收到 mention 邮件          │
                   └─────────────────────┘               └────────────────┬────────────────┘
                                                                          │
                                                              ┌───────────▼───────────┐
                                                              │ owner 手动审核         │
                                                              │  · 确认对方已互挂友链   │
                                                              │  · 确认后 merge PR     │
                                                              └───────────┬───────────┘
                                                                          │
                                                              ┌───────────▼───────────┐
                                                              │ build.yml             │
                                                              │  · 扫描 data/friends   │
                                                              │  · 排序（vip + 拼音）  │
                                                              │  · 生成 friends.json   │
                                                              │  · commit 回 main      │
                                                              └───────────┬───────────┘
                                                                          │
                                                              ┌───────────▼───────────┐
                                                              │ jsDelivr CDN          │
                                                              │ https://cdn.jsdelivr.net/gh/moaradc/moara-friends@main/friends.json │
                                                              └───────────────────────┘
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
│   └── auto-pr.yml           # PR 校验 + 请求人工审核
├── friends.json              # build 产物，jsDelivr 直接读取
├── package.json
└── README.md
```

## 添加友链

### 方式一：通过 PR（外部贡献者）

1. **Fork** 本仓库
2. 在 `data/friends/` 目录下新建一个 JSON 文件（文件名随意，建议用站点名，如 `example.json`）
3. 按下面模板填写
4. 提交代码，创建 Pull Request
5. 自动校验通过后，会评论 @owner 请求人工审核
6. owner 确认对方已互挂友链后手动 merge，jsDelivr 缓存数分钟内刷新

### 方式二：直推 main（仅站主）

站主可直接 commit 到 main 分支。可以给特定友链加 `vip: true`，让它在 `friends.json` 中排序靠前。

> ⚠️ 通过 PR 提交时**不能**携带 `vip` 字段，会被 workflow 拒绝。

## 数据格式

### 最小可用

```json
{
  "name": "你的站点名",
  "url": "https://你的站点/"
}
```

### 完整

```json
{
  "name": "你的站点名",
  "avatar": "https://.../头像.png",
  "description": "一句话简介",
  "url": "https://你的站点/"
}
```

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | ✅ | 站点名称 |
| `url` | string | ✅ | 站点 URL，必须以 `http://` 或 `https://` 开头 |
| `avatar` | string \| null | ❌ | 头像 URL，建议正方形。缺失时前端可用 favicon 服务兜底 |
| `description` | string | ❌ | 一句话简介 |
| `vip` | boolean | ❌ | **仅站主直推 main 时可用**。PR 携带会被自动拒绝 |

## 校验规则

PR 提交后，`auto-pr.yml` 会执行以下校验：

1. **单文件**：PR 只能修改 `data/friends/` 下**一个** `.json` 文件
2. **schema**：`name`/`url` 必填、`url` 必须是 http(s)、`avatar` 必须是字符串或 null
3. **vip 拒绝**：PR 中检测到 `vip` 字段立即终止
4. **URL 可达性**：多 UA 轮换 + 3 次重试 + Content-Type 校验，详见 workflow 注释

### 失败时

- 评论错误清单 + Action 日志链接
- 自动关闭 PR
- 贡献者收到 closed 邮件 + 评论邮件

### 成功时

- 评论 @owner 请求人工审核（@mention 触发 GitHub participating 通知，owner 必收到邮件）
- **不自动合并**，等 owner 手动确认对方已互挂友链后 merge
- owner merge 后，贡献者自动收到 merged 邮件
- merge 触发 build workflow 重建 friends.json

修改后重新 push 到同一 PR 会触发重新校验。

## 邮件通知机制

依赖 GitHub 默认通知行为，workflow 不发额外邮件：

| 事件 | 接收者 | 机制 |
|---|---|---|
| 贡献者开 PR | watch 仓库的人 + owner（通过 @mention） | GitHub PR 创建通知 + @mention participating |
| 校验失败 | 贡献者 | PR 作者自动 participating + 评论 + closed |
| 校验通过 | owner | @mention participating |
| owner merge | 贡献者 | PR 作者自动 participating + merged |
| owner close | 贡献者 | PR 作者自动 participating + closed |

> ⚠️ 2025-05-18 起 GitHub 默认关闭"自动 watch 自己创建的仓库"。如果 owner 没手动 watch 本仓库，PR 创建时可能收不到邮件——但 @mention 评论一定会触发邮件通知。

## 排序规则

构建时按以下顺序排序：

1. `vip: true` 的条目优先
2. 同级按 `name` 的拼音排序（`zh-CN` locale）

排序稳定，保证 jsDelivr 缓存命中率。

## 不做的事

按设计明确不做以下功能（避免架构膨胀）：

- ❌ 双向链接验证（不爬贡献者友链页，改为 owner 人工确认）
- ❌ DNS 所有权验证
- ❌ Playwright 渲染
- ❌ 爬虫 / 友链朋友圈
- ❌ feed / RSS 抓取
- ❌ 自动合并（改为人工审核）
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
