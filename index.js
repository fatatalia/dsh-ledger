/**
 * dsh-ledger — host 半部分
 *
 * 只读记账仪表盘：LedgerEngine 解析 beancount 账本（当月 .bean + ledger.py balance），
 * web 端经 connection.rpc 读取仪表盘数据（"/dsh-ledger" 通道）在会话页
 * "记账" Tab 展示。只读，不写账本；Fava 保留做深度分析。
 */
import z from "@deepseek-ai/schemastery";
import { homedir } from "node:os";
import { join } from "node:path";
import { LedgerEngine } from "./lib/ledger-engine.mjs";

export const name = "dsh-ledger";

export const inject = ["typert", "settings", "connection"];

/** `ledger` settings namespace：账本路径等（默认值即可，几乎无需配置）。 */
const LedgerSchema = z.object({
  beancountDir: z.string(),
  ledgerScript: z.string(),
});

function parseObj() {
  return {
    parse(value) {
      if (typeof value !== "object" || value === null) throw new Error("expected object");
      return value;
    },
  };
}
const getResultSchema = parseObj();

const MANIFEST = {
  package: "dsh-ledger",
  face: "host",
  schemas: [],
  invocations: [
    {
      id: "dsh-ledger#ledger/getConfig",
      service: "ledger",
      namespace: "ledger",
      method: "getConfig",
      invocation: { kind: "direct" },
      parameters: [],
      result: { mode: "strict", typeSymbol: "dsh-ledger#LedgerConfig", schema: getResultSchema },
    },
  ],
  model: { services: [], events: [], objects: [] },
};

export function apply(ctx, config) {
  const Logger = ctx.logger;
  const log = {
    info: (m) => { console.log(`[lg] ${m}`); try { Logger?.info?.(m); } catch {} },
    warn: (m) => { console.warn(`[lg:warn] ${m}`); try { Logger?.warn?.(m); } catch {} },
    error: (m) => { console.error(`[lg:err] ${m}`); try { Logger?.error?.(m); } catch {} },
  };

  const scope = ctx.settings.register("ledger", LedgerSchema, {
    base: {
      beancountDir: join(homedir(), "Beancount"),
      ledgerScript: join(homedir(), ".dsh", "skills", "beancount-ledger", "scripts", "ledger.py"),
    },
  });

  const engine = new LedgerEngine({
    beancountDir: scope.get()?.beancountDir,
    ledgerScript: scope.get()?.ledgerScript,
    log,
  });

  // Typert manifest（设置页可读配置；实际无 UI 需要，主要为完整性）。
  ctx.effect(() => ctx.typert.register(MANIFEST), "dsh-ledger: typert manifest");

  // web 端数据通道：记账 Tab 查询仪表盘数据。
  ctx.connection.rpc.handle("/dsh-ledger", async (endpoint, payload, signal) => {
    try {
      if (signal?.aborted) throw new Error("The request was cancelled.");
      switch (endpoint) {
        case "dashboard":
          return { ok: true, value: await engine.buildDashboard() };
        case "status":
          return { ok: true, value: { beancountDir: engine.beancountDir, ledgerScript: engine.ledgerScript } };
        default:
          throw new Error(`unknown endpoint: ${endpoint}`);
      }
    } catch (e) {
      return { ok: false, error: { code: "ERR", message: e instanceof Error ? e.message : String(e) } };
    }
  }, { authority: "trusted" });
  log.info("记账数据 RPC 已注册（/dsh-ledger）");

  ctx.on("dispose", () => {});
  log.info(`记账仪表盘引擎已启动（账本 ${engine.beancountDir}）`);
}
