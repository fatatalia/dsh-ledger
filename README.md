# dsh-ledger — 只读记账仪表盘插件

在 dsh web 会话页的 **「记账」Tab**（与「梦境」并排）展示 beancount 账本的月度快照：
本月收支总览、资产结构、支出分类占比、最近交易。**只读**——不在插件里记账，Fava 保留做深度分析。

## 工作原理

```
进入「记账」Tab / 点「刷新」
  → RPC /dsh-ledger/dashboard
  → LedgerEngine：
      1. 解析当月账本文件 Beancount/<year>/<month>.bean（交易/分类/收支）
      2. exec ledger.py balance（全部账户余额）
  → 输出统一 JSON → Tab 渲染
```

数据源复用现有 `ledger.py`（skill 自带），**脚本零改动**；当月交易直接从按月分文件的 `.bean` 解析，不调账本写入。

## 展示内容

- **本月收支总览卡**：本月支出（含笔数）/ 本月收入 / 本月结余 / 活期余额 / 总资产
- **资产结构**：**动态分组**——按账本 `Assets:<类别>` 自动发现（任意 beancount 结构自适应），活期 = 数字尾号卡账户（如 `Assets:CMB:1234` 形态）
- **本月支出分类**：Top 5 分类 + 占比进度条 + 其余合计
- **最近交易**：最近 15 条（日期 / 一级分类 / 描述 / 金额，支出红收入绿），右侧独立栏可滚动

## 目录

```
dsh-ledger/
├── index.js              # host 插件：settings + connection.rpc（/dsh-ledger）
├── client.js             # 浏览器 bundle：conversation.view "记账" Tab
├── lib/ledger-engine.mjs # 解析 .bean + exec ledger.py balance → 仪表盘 JSON
├── cordis.patch.yml
└── package.json
```

## 技术要点（踩过的坑）

- **依赖软链必须建**：`node_modules/@deepseek-ai` → `/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`，否则 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'` 导致整个 profile 起不来
- **inject 必须包含用到的服务**：index.js 用了 `ctx.typert`，inject 列表需含 `"typert"`（曾漏掉）
- **中文账户名**：账本里有 `Assets:TimeDeposit:享定存70007` 等中文账户，正则需允许 `\u4e00-\u9fff`，否则几十万资产解析不到
- 挂载：`~/.dsh/profiles/web/package.json` 的 dependencies（link）+ dsh.profile.bundles 两处

## 验证

```bash
# 引擎单测（真实账本）
node -e "import('./lib/ledger-engine.mjs').then(async m => { const e = new m.LedgerEngine(); console.log(JSON.stringify(await e.buildDashboard(), null, 1).slice(0, 800)); })"

# RPC 实测
curl -s -X POST "http://127.0.0.1:3080/dsh-ledger/dashboard" \
  -H "Content-Type: application/json" \
  -d '{"type":"client-request","rpcId":"v1","method":"dashboard","payload":{}}'
```

改代码后重启 web 生效：`launchctl kickstart -k system/com.dsh.web`
