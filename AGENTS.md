# AGENTS.md - moara-friends 仓库记忆

> 本文件用于 AI 代理跨会话记忆，记录关键决策与配置，防止上下文压缩导致信息丢失。

## 仓库基本信息

- **仓库**：`moaradc/moara-friends`
- **作用**：沫然Blog 的友链数据源
- **分发**：jsDelivr CDN，`https://cdn.jsdelivr.net/gh/moaradc/moara-friends@main/friends.json`
- **主站**：`https://blog.945426.xyz`

## 数据结构

### `data/friends/*.json`（每文件一条友链）

| 字段 | 类型 | 必填（PR） | 必填（站主直推） | 说明 |
|---|---|---|---|---|
| `name` | string | ✅ | ✅ | 站点名称 |
| `url` | string | ✅ | ✅ | 站点 URL（http/https） |
| `backlink` | string | ✅ | ❌ | 申请者的友链页 URL，用于反链验证 |
| `avatar` | string \| null | ❌ | ❌ | 头像 URL，建议正方形 |
| `description` | string | ❌ | ❌ | 一句话简介 |
| `vip` | boolean | ❌（PR 携带会被拒绝） | ❌ | 仅站主直推 main 时可用，排序优先 |

### `friends.json`（build 产物，jsDelivr 读取）

由 `scripts/build.js` 扫描 `data/friends/*.json` 合并生成：
- 排序：`vip: true` 优先，同级按 `name` 拼音（zh-CN）
- **不包含 `backlink` 字段**（仅用于 PR 反链验证）
- 字段顺序：`name` → `url` → `avatar` → `description` → `vip`（若有）

### 示例

```json
[
  {
    "name": "沫然Blog",
    "url": "https://blog.945426.xyz/",
    "avatar": "https://blog.945426.xyz/assets/img/icon/moara.webp",
    "description": "沫然（moara）的个人博客",
    "vip": true
  },
  {
    "name": "其他站点",
    "url": "https://example.com/",
    "avatar": "https://example.com/avatar.png",
    "description": "简介"
  }
]
```

## Workflow 架构

### `auto-pr.yml`（PR 校验 + 自动合并）

触发：`pull_request_target`（opened/synchronize/reopened）

校验维度：
1. 单文件（PR 只能改 `data/friends/` 下单个 .json）
2. JSON schema（name/url/backlink 必填）
3. vip 字段拒绝（PR 携带立即终止）
4. SSRF 防护（拒绝 localhost / 私有 IP / 链路本地 / 云元数据 / IPv4-mapped IPv6）
5. backlink 主域名必须与 url 主域名一致
6. backlink 不能指向本站
7. URL + avatar 可达性检查（多 UA + 重试 + Content-Type）
8. 反链验证：先 fetch 静态 HTML，找不到 fallback 到 Playwright 渲染（处理 JS 动态页面）

**Tag 管理**：
- `友链`（绿色 #0e8a16）：所有友链 PR 固定打
- `已互链`（绿色 #0e8a16）：成功合并后打，删除 `未通过`
- `未通过`（红色 #d73a4a）：校验失败时打，删除 `已互链`

**失败行为**：评论错误清单 + PR 保持打开（不自动关闭，由人工处理）
**成功行为**：自动 squash merge + 触发 build workflow，不评论

### `build.yml`（重建 friends.json）

触发：push 到 main（改 `data/friends/` / `build.js` / 本 workflow）/ `workflow_dispatch` / `schedule: 0 * * * *`

流程：扫描 → 重建 friends.json → commit（若变更）→ **purge jsDelivr 缓存**

### 校验逻辑位置

- `scripts/validate-pr.mjs`：PR 校验核心逻辑（SSRF / 可达性 / 反链验证 / Tag）
- `scripts/build.js`：合并 + 排序脚本
- `SITE_URL` 常量在 `validate-pr.mjs` 里硬编码为 `https://blog.945426.xyz`

## 已知限制

- **fork PR 合并**：`GITHUB_TOKEN` 对 fork PR 是只读的。当前 workflow 用 `github.rest.pulls.merge`，fork PR 会报 `Resource not accessible by integration`。需要 Classic PAT（scope: `repo`）才能合并 fork PR，但目前未配置。
- **静态 HTML 限制**：反链验证已用 Playwright fallback 处理 JS 动态渲染页面。

## 不要做的事

- ❌ DNS 所有权验证
- ❌ 爬虫 / 友链朋友圈
- ❌ feed / RSS 抓取
- ❌ 成功评论 / 欢迎评论 / 进度评论
- ❌ workflow 自定义邮件（依赖 GitHub 默认通知）
- ❌ 评论触发重新校验（/recheck 功能已删除）

## 关键 commit 历史

- `95292c5`：SSRF 防护 + /recheck 评论触发（recheck 后被删除）
- `7098792`：PR 自动打 tag（友链/已互链/未通过）
- `3c839a6`：反链验证加 Playwright fallback
- `7cea8a9`：Playwright 5 项健壮性优化
- `cc64e90`：README 重写为用户向文档
- `5c0ebb7`：build 后自动 purge jsDelivr + 清理注释
