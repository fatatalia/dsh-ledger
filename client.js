/**
 * dsh-ledger — client 半部分（浏览器 bundle）
 *
 * 在会话页面注册 "记账" Tab（conversation.view 槽位，同 dsh-dreaming 模式）：
 * 只读仪表盘——本月收支总览卡、资产概览、支出分类占比、最近交易。
 * 数据经 connection.rpc 走 "/dsh-ledger" 通道，进入 Tab 时自动刷新一次，
 * 支持手工刷新。不提供记账操作（只读），Fava 保留做深度分析。
 */
window.__ModuleLoader__.load({
  id: "dsh-ledger",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const S = require("react/jsx-runtime");

    const CHANNEL = "/dsh-ledger";

    function createLedgerRuntime(rpc, sessionId) {
      const call = async (endpoint, payload) => {
        const response = await rpc.call(CHANNEL, endpoint, payload || {});
        if (!response || !response.ok) {
          throw new Error(response?.error?.message || `${endpoint} failed`);
        }
        return response.value;
      };
      return {
        dashboard: () => call("dashboard", {}),
      };
    }

    const fmt = (n) => (n == null ? "—" : n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

    // 资产分组展示名（仅影响显示，不影响分组逻辑；账本自动发现的分组不在表里则显示原名）
    const GROUP_LABELS = {
      CMB: "招行卡",
      Invest: "理财",
      TimeDeposit: "定期存款",
      Pension: "养老金",
      Checking: "活期",
      Savings: "储蓄",
      Brokerage: "证券",
      Crypto: "加密资产",
    };

    const card = {
      background: "var(--dsw-alias-bg-base)",
      border: "1px solid var(--dsw-alias-border-l2)",
      borderRadius: 10,
      padding: "14px 16px",
      marginBottom: 12,
    };
    const statCard = {
      ...card,
      flex: 1,
      minWidth: 120,
      marginBottom: 0,
    };
    const statLabel = { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, marginBottom: 4 };
    const statValue = { fontWeight: 700, fontSize: 18, lineHeight: 1.3 };
    const statSub = { color: "var(--dsw-alias-label-tertiary)", fontSize: 11, marginTop: 3 };
    const title = { fontWeight: 600, fontSize: 13, marginBottom: 10 };
    const row = { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.12))", fontSize: 13 };
    const rowLast = { ...row, borderBottom: "none" };
    const txDesc = { color: "var(--dsw-alias-label-primary)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginRight: 10 };
    const txMeta = { color: "var(--dsw-alias-label-tertiary)", fontSize: 11, flex: "0 0 70px" };
    const empty = { color: "var(--dsw-alias-label-tertiary)", padding: "24px 0", textAlign: "center" };

    function LedgerView({ runtime }) {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [tick, setTick] = React.useState(0);

      // 进入 Tab 自动刷新一次；手工刷新按钮触发 tick。
      React.useEffect(() => {
        let current = true;
        setBusy(true);
        runtime.dashboard()
          .then((d) => { if (current) { setData(d); setError(""); } })
          .catch((e) => { if (current) setError(e.message); })
          .finally(() => { if (current) setBusy(false); });
        return () => { current = false; };
      }, [runtime, tick]);

      if (error && !data) return S.jsx("div", { style: { maxWidth: 760, padding: "24px 20px" }, children: [
        S.jsx("p", { style: { color: "var(--dsw-alias-state-error-primary)" }, children: `加载失败：${error}` }),
        S.jsx("button", { onClick: () => setTick((t) => t + 1), style: { marginTop: 8, padding: "5px 12px", borderRadius: 8, cursor: "pointer" }, children: "重试" }),
      ] });

      const monthly = data?.monthly;
      const summary = data?.summary;

      // 分类占比条：取 Top 5 + 其余
      const topCategories = (monthly?.categories || []).slice(0, 5);
      const restAmount = monthly ? monthly.categories.slice(5).reduce((s, c) => s + c.amount, 0) : 0;

      return S.jsxs("div", {
        style: { maxWidth: 1240, padding: "24px 20px", fontFamily: "var(--dsw-font-family,system-ui)", color: "var(--dsw-alias-label-primary)" },
        children: [
          S.jsxs("div", { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }, children: [
            S.jsx("span", { style: { fontSize: 17, fontWeight: 700 }, children: "📒 记账" }),
            S.jsx("span", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12 }, children: data ? `${data.month} 月 · 更新于 ${new Date(data.fetchedAt).toLocaleTimeString("zh-CN")}` : "" }),
            S.jsx("button", {
              type: "button",
              disabled: busy,
              onClick: () => setTick((t) => t + 1),
              style: { marginLeft: "auto", padding: "6px 14px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-base)", cursor: busy ? "default" : "pointer", fontWeight: 500 },
              children: busy ? "刷新中…" : "刷新",
            }),
          ]}),
          error ? S.jsx("p", { style: { color: "var(--dsw-alias-state-error-primary)", marginBottom: 12, fontSize: 13 }, children: error }) : null,
          !data ? S.jsx("p", { style: empty, children: "加载中…" }) : S.jsxs("div", { style: { display: "flex", gap: 12, alignItems: "flex-start" }, children: [

            // ── 左栏（总览 + 资产 + 分类）──
            S.jsxs("div", { style: { flex: 1, minWidth: 0 }, children: [
              // 本月收支总览
              S.jsxs("div", { style: { display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }, children: [
                S.jsxs("div", { style: statCard, children: [
                  S.jsx("div", { style: statLabel, children: "本月支出" }),
                  S.jsx("div", { style: { ...statValue, color: "var(--dsw-alias-state-error-primary, #e5484d)" }, children: `¥${fmt(monthly?.expenseTotal)}` }),
                  S.jsx("div", { style: statSub, children: `${monthly?.transactionCount ?? 0} 笔` }),
                ] }),
                S.jsxs("div", { style: statCard, children: [
                  S.jsx("div", { style: statLabel, children: "本月收入" }),
                  S.jsx("div", { style: { ...statValue, color: "var(--dsw-alias-state-success-primary, #30a46c)" }, children: `¥${fmt(monthly?.incomeTotal)}` }),
                ] }),
                S.jsxs("div", { style: statCard, children: [
                  S.jsx("div", { style: statLabel, children: "本月结余" }),
                  S.jsx("div", { style: statValue, children: `¥${fmt(monthly?.net)}` }),
                ] }),
                S.jsxs("div", { style: statCard, children: [
                  S.jsx("div", { style: statLabel, children: "活期余额" }),
                  S.jsx("div", { style: statValue, children: `¥${fmt(summary?.liquid)}` }),
                ] }),
                S.jsxs("div", { style: statCard, children: [
                  S.jsx("div", { style: statLabel, children: "总资产" }),
                  S.jsx("div", { style: statValue, children: `¥${fmt(summary?.totalAssets)}` }),
                ] }),
              ] }),

              // 资产结构（动态分组，来自账本自动发现）
              summary && summary.groups.length > 0 && S.jsxs("div", { style: card, children: [
                S.jsx("div", { style: title, children: "资产结构" }),
                S.jsxs("div", { children: [
                  // 活期单独一行（引擎动态识别），其余组按金额降序展示
                  S.jsx("div", { style: row, children: [S.jsx("span", { children: "活期（可直接动用）" }), S.jsx("span", { style: { fontWeight: 600 }, children: `¥${fmt(summary.liquid)}` })] }),
                  ...summary.groups.map((g, i) => {
                    const last = i === summary.groups.length - 1;
                    return S.jsx("div", { key: g.name, style: last ? rowLast : row, children: [
                      S.jsx("span", { children: `${GROUP_LABELS[g.name] || g.name}${g.accountCount > 1 ? `（${g.accountCount} 个账户）` : ""}` }),
                      S.jsx("span", { style: { fontWeight: 600 }, children: `¥${fmt(g.amount)}` }),
                    ] });
                  }),
                ] }),
              ] }),

              // 本月支出分类占比
              monthly && monthly.categories.length > 0 && S.jsxs("div", { style: card, children: [
                S.jsx("div", { style: title, children: "本月支出分类" }),
                S.jsx("div", { style: { marginBottom: 10 } },),
                ...topCategories.map((c) => S.jsxs("div", { key: c.name, children: [
                  S.jsxs("div", { style: { display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 3 }, children: [
                    S.jsx("span", { children: `${c.name}（${c.pct}%）` }),
                    S.jsx("span", { style: { color: "var(--dsw-alias-label-secondary)" }, children: `¥${fmt(c.amount)}` }),
                  ] }),
                  S.jsx("div", { style: { height: 6, borderRadius: 3, background: "var(--dsw-alias-border-l1, rgba(128,128,128,.15))", overflow: "hidden", marginBottom: 8 }, children: [
                    S.jsx("div", { style: { height: "100%", width: `${Math.max(2, c.pct)}%`, borderRadius: 3, background: "var(--dsw-alias-state-business-primary, #3b82f6)" } }),
                  ] }),
                ] })),
                restAmount > 0 ? S.jsx("div", { style: { display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }, children: [
                  S.jsx("span", { children: "其他" }),
                  S.jsx("span", { children: `¥${fmt(restAmount)}` }),
                ] }) : null,
              ] }),
            ] }),

            // ── 右栏（最近交易，固定宽度可滚动）──
            S.jsxs("div", { style: { flex: "0 0 380px", ...card, maxHeight: 560, overflowY: "auto" }, children: [
              S.jsx("div", { style: title, children: "最近交易" }),
              !monthly || monthly.transactions.length === 0 ? S.jsx("div", { style: empty, children: "本月暂无交易。" }) :
                monthly.transactions.map((t, i) => {
                  // type/amount 由引擎算好：expense（-¥）/ income（+¥）/ transfer（带符号）
                  const isExpense = t.type === "expense";
                  const sign = isExpense ? "-" : (t.amount < 0 ? "-" : "+");
                  const amount = Math.abs(t.amount);
                  const color = isExpense ? "var(--dsw-alias-state-error-primary, #e5484d)"
                    : t.type === "transfer" ? "var(--dsw-alias-label-secondary)"
                      : "var(--dsw-alias-state-success-primary, #30a46c)";
                  const last = i === monthly.transactions.length - 1;
                  return S.jsxs("div", { key: `${t.date}-${i}`, style: last ? rowLast : row, children: [
                    S.jsx("span", { style: txMeta, children: t.date.slice(5) }),
                    S.jsxs("span", { style: { flex: "0 0 60px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--dsw-alias-label-tertiary)", fontSize: 11, marginRight: 6 }, children: [
                      (t.account || "").replace("Expenses:", "").replace("Income:", "").split(":")[0],
                    ] }),
                    S.jsx("span", { style: txDesc, title: t.description, children: t.description }),
                    S.jsx("span", { style: { fontWeight: 600, color }, children: `${sign}¥${fmt(amount)}` }),
                  ] });
                }),
            ] }),

            !monthly ? S.jsx("p", { style: empty, children: "本月暂无账本数据。" }) : null,
          ] }),
        ],
      });
    }

    const inject = ["slots", "connection"];

    function apply(ctx) {
      // 记账 Tab（conversation.view，与梦境并排）。
      const runtimes = new Map();
      ctx.effect(() => () => { runtimes.clear(); }, "dsh-ledger: runtimes");
      ctx.slots.inject("conversation.view", () =>
        ctx.slots.register(
          {
            name: "conversation.view",
            id: "ledger",
            order: 51,
            label: () => "记账",
            inject: (sessionId) => {
              let runtime = runtimes.get(sessionId);
              if (runtime === void 0) {
                runtime = createLedgerRuntime(ctx.connection.rpc, sessionId);
                runtimes.set(sessionId, runtime);
              }
              return { runtime };
            },
          },
          LedgerView,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
