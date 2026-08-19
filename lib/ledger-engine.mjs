/**
 * ledger-engine.mjs — dsh-ledger 数据引擎（只读）
 *
 * 数据源（官方解析，只读不写账本）：
 *   `ledger-loader.py`（beancount.loader.load_file，含 include 全部账本文件）——
 *   一次调用输出全部交易 + 资产/负债余额，解析出本月交易、分类汇总、收支合计、最近交易、资产总览。
 *
 * 输出统一 JSON 供 web Tab 渲染。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);

/** beancount 账本根目录。 */
const DEFAULT_BEANCOUNT_DIR = () => join(homedir(), "Beancount");
/** 官方解析器脚本（本插件自带，beancount.loader）。 */
const DEFAULT_LOADER_SCRIPT = () => join(dirname(fileURLToPath(import.meta.url)), "ledger-loader.py");
/** 预算（账本 custom budget 的月度值；解析失败时兜底，展示层可用）。 */
const DEFAULT_MONTHLY_BUDGET = 5000;

/** 本地日期部件。 */
function localDateParts() {
  const now = new Date();
  const tz = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
  const [y, m, d] = tz.format(now).split("-");
  return { year: y, month: m, day: d };
}

/** 从余额列表派生资产总览（动态分组，不写死账户结构）。
 *
 * 分组规则（自适应任意 beancount 账本）：
 * - groups：按 `Assets:<第二段>` 聚合——账本里有哪些一级资产类别就展示哪些
 * - liquid：第三段为纯数字卡号的账户（如 `Assets:CMB:1234`）视为"活期/可直接动用"，
 *   通用规则（数字尾号 = 银行卡），不依赖特定银行名
 */
export function summarizeBalances(accounts) {
  let liquid = 0;
  let totalAssets = 0;
  const groups = new Map(); // 一级类别名 → { amount, accountCount, accounts }
  for (const { account, amount } of accounts) {
    if (!account.startsWith("Assets:")) continue;
    totalAssets += amount;
    const parts = account.split(":");
    const top = parts[1] || "Other";
    const g = groups.get(top) ?? { amount: 0, accountCount: 0, accounts: [] };
    g.amount += amount;
    g.accountCount += 1;
    g.accounts.push({ account, amount: round2(amount) });
    groups.set(top, g);
    if (parts.length === 3 && /^\d+$/.test(parts[2])) liquid += amount; // 数字尾号 = 银行卡
  }
  const groupList = [...groups.entries()]
    .map(([name, g]) => ({ name, amount: round2(g.amount), accountCount: g.accountCount, accounts: g.accounts }))
    .sort((a, b) => b.amount - a.amount);
  return {
    liquid: round2(liquid),
    totalAssets: round2(totalAssets),
    groups: groupList,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

export class LedgerEngine {
  constructor({ beancountDir = DEFAULT_BEANCOUNT_DIR(), loaderScript = DEFAULT_LOADER_SCRIPT(), log = console } = {}) {
    this.beancountDir = beancountDir;
    this.loaderScript = loaderScript;
    this.log = log;
  }

  /**
   * 官方解析器加载账本数据（beancount.loader.load_file，含 include 的所有账本文件）。
   * 返回 { transactions, balances }：
   * - transactions: [{index, date, description, postings:[{account, amount, currency}]}]
   *   index = loader 返回顺序（include 顺序 + 文件内 append 顺序，即记账先后），用于同一天内排序
   * - balances: [{account, amount}]（资产/负债账户余额）
   * 失败抛错。
   */
  async loadLedgerData() {
    const beanFile = join(this.beancountDir, "main.bean");
    const { stdout } = await execFileP("python3", [this.loaderScript, beanFile], { timeout: 30000 });
    const parsed = JSON.parse(stdout);
    if (!parsed.ok) throw new Error(`loader 解析失败: ${(parsed.errors || []).join("; ") || "unknown"}`);
    if (parsed.errorCount > 0) {
      this.log?.warn?.(`ledger: 官方解析 ${parsed.errorCount} 个警告/错误（前 3）: ${parsed.errors.slice(0, 3).join(" | ")}`);
    }
    return {
      transactions: (parsed.transactions || []).map((t, i) => ({ ...t, index: i })),
      balances: parsed.balances || [],
    };
  }

  /**
   * 汇总交易（只统计 {year}-{month} 当月）→ 与 parseMonthFile 同构的 monthly 结构。
   * 最近交易从全量按日期降序取 15（跨月投资/养老/定存也能显示）。
   */
  summarizeTransactions(transactions, year, month) {
    const prefix = `${year}-${month}`;
    const monthTx = transactions.filter((t) => t.date.startsWith(prefix));

    let expenseTotal = 0;
    let incomeTotal = 0;
    const categories = {};
    const accountExpenses = {};
    for (const t of monthTx) {
      for (const p of t.postings) {
        const { account, amount } = p;
        if (account.startsWith("Expenses:")) {
          expenseTotal += amount;
          const parts = account.split(":");
          const top = parts.length >= 2 ? parts[1] : "Other";
          categories[top] = (categories[top] || 0) + amount;
          accountExpenses[account] = (accountExpenses[account] || 0) + amount;
        } else if (account.startsWith("Income:")) {
          incomeTotal += Math.abs(amount);
        }
      }
    }
    const categoryList = Object.entries(categories)
      .map(([name, amount]) => ({ name, amount: round2(amount), pct: expenseTotal > 0 ? Math.round((amount / expenseTotal) * 100) : 0 }))
      .sort((a, b) => b.amount - a.amount);

    return {
      transactionCount: monthTx.length,
      expenseTotal: round2(expenseTotal),
      incomeTotal: round2(incomeTotal),
      net: round2(incomeTotal - expenseTotal),
      categories: categoryList,
      accountExpenses,
      transactions: transactions
        .slice()
        .sort((a, b) => {
          // 跨天：日期降序；同一天：loader 顺序倒序（后记的在前，beancount 无时间戳）
          if (a.date !== b.date) return b.date.localeCompare(a.date);
          return b.index - a.index;
        })
        .slice(0, 15)
        .map((t) => {
          // 交易归类：expense（支出）/ income（收入）/ transfer（纯资产转移，如理财赎回）
          // amount 统一为展示金额：expense/income 取正数，transfer 带符号（第一笔非零 posting）
          const exp = t.postings.find((p) => p.account.startsWith("Expenses:"));
          const inc = t.postings.find((p) => p.account.startsWith("Income:"));
          let type;
          let amount;
          let account;
          if (exp) {
            type = "expense";
            amount = exp.amount;
            account = exp.account;
          } else if (inc) {
            type = "income";
            amount = Math.abs(inc.amount);
            account = inc.account;
          } else {
            const p = t.postings.find((x) => x.amount !== 0) || t.postings[0];
            type = "transfer";
            amount = p ? p.amount : 0;
            account = p ? p.account : "";
          }
          return {
            date: t.date,
            description: t.description,
            type,
            amount: round2(amount),
            account,
            postings: t.postings
              .filter((p) => p.account.startsWith("Expenses:") || p.account.startsWith("Income:"))
              .map((p) => ({ account: p.account, amount: p.amount })),
          };
        }),
    };
  }

  /** 构建完整仪表盘数据。 */
  async buildDashboard() {
    const { year, month } = localDateParts();

    // 官方解析器一次加载：全部交易 + 资产/负债余额
    let monthly = null;
    let balances = [];
    try {
      const { transactions, balances: bal } = await this.loadLedgerData();
      monthly = this.summarizeTransactions(transactions, year, month);
      balances = bal;
    } catch (e) {
      this.log?.warn?.(`ledger: 加载账本失败 ${e instanceof Error ? e.message : e}`);
    }

    return {
      fetchedAt: new Date().toISOString(),
      month: `${year}-${month}`,
      monthly,
      balances,
      summary: summarizeBalances(balances),
      budget: DEFAULT_MONTHLY_BUDGET,
    };
  }
}
