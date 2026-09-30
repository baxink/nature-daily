# nature-daily

每天北京时间早上 6 点自动抓取 Nature 文章，用 Cloudflare Workers AI 生成中文摘要，并以报纸式首页在 GitHub Pages 展示。

🔗 [baxink.github.io/nature-daily](https://baxink.github.io/nature-daily/)

## 功能

- 抓取 Nature 7 个版面（main / news / opinion / research-analysis / research-articles / careers / Nature Reviews Bioengineering）
- 每天每个版面各精选 1 篇，组成 7 篇日报首页
- **Cloudflare Workers AI 免费内置模型** 生成中文标题与摘要
- 前端固定主刊头条 + 6 个栏目分栏，每个版面都支持 **换一篇** 单独刷新
- GitHub Pages 静态页面实时读取

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | HTML / CSS / JS → GitHub Pages |
| 后端 | Cloudflare Workers (TypeScript) |
| 翻译 | Cloudflare Workers AI (`llama-3.1-8b-instruct-fast`) |
| 数据库 | Cloudflare D1 |
| 定时 | Workers Cron Triggers (`0 22 * * *` UTC = 北京时间 6:00) |

## 项目结构

```
nature-daily/
  docs/           # GitHub Pages 前端
  worker/         # Cloudflare Worker
  shared/         # Nature 来源配置 (JSON)
  db/             # D1 schema 与 seed
```

## 部署

说明：来源配置以 `shared/media-sources.json` 为准。若你新增或调整版面，除了部署 Worker，还需要重新执行一次 `db/seed.sql`，让远端 `media_sources` 表与代码配置保持一致。

### 1. 创建 D1 数据库

```bash
cd worker
npx wrangler d1 create nature-daily-db
```

把输出的 `database_id` 写入 `worker/wrangler.toml`。

### 2. 初始化数据库

```bash
cd worker
npm run db:init
npm run db:seed
```

### 3. 部署 Worker

```bash
cd worker
npx wrangler deploy
```

### 4. 配置手动抓取密钥

`/api/ingest` 是运维接口，需要 Bearer token。手动调用前先设置 Worker secret；未设置时接口会 fail closed，定时抓取仍可正常运行。

```bash
cd worker
npx wrangler secret put INGEST_TOKEN
```

按提示输入一段随机密钥，并将其保存在安全位置。

### 5. 手动触发一次抓取

```bash
curl -X POST https://<your-worker>.workers.dev/api/ingest \
  -H "Authorization: Bearer $INGEST_TOKEN"
```

手动调用前，将刚才设置的同一个密钥放入本地环境变量 `INGEST_TOKEN`。前端公开的日报和“换一篇”功能不需要这个密钥。

翻译模型通过 Worker 变量 `AI_MODEL` 配置，默认值为 `@cf/meta/llama-3.1-8b-instruct-fast`。ingest 会补译缺失或仍为英文的日报卡片；失败时保留原卡片，并在响应的 `translationFailed` 和 `errors` 字段中记录简短原因，后续 ingest 会重试。

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/daily` | 获取当日 7 卡日报 |
| POST | `/api/daily/refresh` | **换一篇**：按 `sourceId` 单独刷新一个版面 |
| GET | `/api/meta` | 数据库统计信息 |
| POST | `/api/ingest` | 手动触发抓取与选文 |

翻译模型由 `worker/wrangler.toml` 的 `AI_MODEL` 配置。模型停用或翻译失败后，定时任务与手动 ingest 会重试已有卡片的缺失中文，并保留原选文。返回结果提供 translationAttempted、translationSucceeded、translationFailed 及错误简述。没有原始摘要时只翻译标题，不生成推测性摘要。
