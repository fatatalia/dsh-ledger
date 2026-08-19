/**
 * ledger-engine.mjs — dsh-ledger 数据引擎（只读）
 *
 * 数据源（零脚本改动）：
 *   1. 当月账本文件 `Beancount/<year>/<month>.bean`（beancount 复式记账）——
 *      解析出本月交易、分类汇总、收支合计
 *   2. `ledger.py balance`——所有账户余额（资产/负债）
 *
 * 输出统一 JSON 供 web Tab 渲染。全部只读，不写账本。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const execFileP = promisify(execFile);

/** beancount 账本根目录。 */
const DEFAULT_BEANCOUNT_DIR = () => join(homedir(), "Beancount");
/** ledger.py 脚本（skill 自带，绝对路径）。 */
const DEFAULT_LEDGER_SCRIPT = () => join(homedir(), ".dsh", "skills", "beancount-ledger", "scripts", "ledger.py");
/** 预算（账本 custom budget 的月度值；解析失败时兜底，展示层可用）。 */
const DEFAULT_MONTHLY_BUDGET = 5000;

/** 交易行正则：日期 + 描述。 */
const TX_RE = /^(\d{4})-(\d{2})-(\d{2})\s+\*\s+"(.+)"\s*$/;
/** posting 行正则：账户（允许中文） 金额 [货币]。 */
const POSTING_RE = /^\s{2}([A-Z][A-Za-z0-9:\u4e00-\u9fff]+)\s+(-?[\d,]+\.?\d*)\s+([A-Z]{3})?\s*$/;

/** 本地日期部件。 */
function localDateParts() {
  const now = new Date();
  const tz = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
  const [y, m, d] = tz.format(now).split("-");
  return { year: y, month: m, day: d };
}

/** 当月账本文件路径。 */
function monthlyFile(beancountDir, year, month) {
  return join(beancountDir, String(year), `${month}.bean`);
}

/**
 * 当月账本文件列表：主文件 {month}.bean + 分类文件（invest/pension/timedeposit 等），
 * 排除年度 include 文件（{year}.bean）与其他月份主文件（XX.bean）。
 * 记账按分类路由到不同文件（ledger.py add_transaction），只读主文件会漏掉投资/养老/定存交易。
 */
async function monthlyFiles(beancountDir, year, month) {
  const dir = join(beancountDir, String(year));
  let entries = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const monthMainRe = /^\d{2}\.bean$/; // 08.bean 这类月份主文件
  return entries
    .filter((f) => f.endsWith(".bean"))
    .filter((f) => f === `${month}.bean` || (!monthMainRe.test(f) && f !== `${year}.bean`))
    .sort();
}

/**
 * 解析一个月的 .bean：返回交易列表 + 收支/分类汇总。
 * @param {object} [opts] 传入 {year, month} 时，收支/分类汇总与交易数只统计当月交易
 * （多文件拼接后跨月交易会被过滤掉）；不传则统计全部（向后兼容单文件调用）。
 */
export function parseMonthFile(content, { year, month } = {}) {
  const transactions = [];
  let current = null;
  for (const raw of content.split("\n")) {
    const line = raw.trimEnd();
    const tx = line.match(TX_RE);
    if (tx) {
      if (current) transactions.push(current);
      current = { date: `${tx[1]}-${tx[2]}-${tx[3]}`, description: tx[4].trim(), postings: [] };
      continue;
    }
    const posting = line.match(POSTING_RE);
    if (posting && current) {
      current.postings.push({
        account: posting[1],
        amount: parseFloat(posting[2].replace(/,/g, "")),
        currency: posting[3] || "CNY",
      });
    }
  }
  if (current) transactions.push(current);

  // 月份过滤：多文件拼接时只统计当月交易（跨月分类文件不影响本月汇总）
  const inMonth = year && month ? (t) => t.date.startsWith(`${year}-${month}`) : () => true;
  const monthTx = transactions.filter(inMonth);

  // 汇总
  let expenseTotal = 0;
  let incomeTotal = 0;
  const categories = {}; // Expenses:* 顶层分类 → 合计
  const accountExpenses = {}; // 每个支出账户 → 合计（用于分类明细）

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
        incomeTotal += Math.abs(amount); // 收入记负数，取绝对值
      }
    }
  }

  // 分类排序（降序），附占比
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
    // 最近交易：跨文件全部交易按日期降序取 15（投资/养老/定存交易也能显示）
    transactions: transactions
      .slice()
      .sort((a, b) => b.date.localeCompare(a.date)) // 日期降序（多文件拼接后文件内顺序不可靠）
      .slice(0, 15) // 只保留最近 15 条供展示
      .map((t) => ({
        date: t.date,
        description: t.description,
        postings: t.postings
          .filter((p) => p.account.startsWith("Expenses:") || p.account.startsWith("Income:"))
          .map((p) => ({ account: p.account, amount: p.amount })),
      })),
  };
}

/** 解析 ledger.py balance 输出 → 账户余额列表（账户名允许中文）。 */
export function parseBalanceOutput(output) {
  const lines = output.split("\n");
  const accounts = [];
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z][A-Za-z0-9:\u4e00-\u9fff]+)\s+(-?[\d,]+\.?\d*)\s*$/);
    if (m) {
      accounts.push({ account: m[1], amount: parseFloat(m[2].replace(/,/g, "")) });
    }
  }
  return accounts;
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
  constructor({ beancountDir = DEFAULT_BEANCOUNT_DIR(), ledgerScript = DEFAULT_LEDGER_SCRIPT(), log = console } = {}) {
    this.beancountDir = beancountDir;
    this.ledgerScript = ledgerScript;
    this.log = log;
  }

  /** 执行 ledger.py 并返回 stdout。 */
  async runLedger(...args) {
    const { stdout } = await execFileP("python3", [this.ledgerScript, ...args], { timeout: 30000 });
    return stdout;
  }

  /** 构建完整仪表盘数据。 */
  async buildDashboard() {
    const { year, month } = localDateParts();

    // 1. 当月账本文件（主文件 + 分类文件，拼接解析；汇总只统计当月交易）
    const file = monthlyFile(this.beancountDir, year, month);
    let monthly = null;
    try {
      const files = await monthlyFiles(this.beancountDir, year, month);
      const contents = [];
      for (const f of files) {
        try {
          contents.push(await readFile(join(this.beancountDir, String(year), f), "utf8"));
        } catch {
          // 单文件读取失败跳过（如临时文件）
        }
      }
      if (contents.length === 0) await access(file); // 触发 catch 记录警告
      monthly = parseMonthFile(contents.join("\n"), { year, month });
    } catch (e) {
      this.log?.warn?.(`ledger: 读取当月账本失败 ${file}: ${e instanceof Error ? e.message : e}`);
    }

    // 2. 全部账户余额
    let balances = [];
    try {
      const out = await this.runLedger("balance");
      balances = parseBalanceOutput(out);
    } catch (e) {
      this.log?.warn?.(`ledger: balance 查询失败 ${e instanceof Error ? e.message : e}`);
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
