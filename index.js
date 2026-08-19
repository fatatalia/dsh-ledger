/**
 * dsh-ledger — host 半部分
 *
 * 只读记账仪表盘：LedgerEngine 用官方 beancount.loader 解析账本（交易 + 余额），
 * web 端经 connection.rpc 读取仪表盘数据（"/dsh-ledger" 通道）在会话页
 * "记账" Tab 展示。只读，不写账本；Fava 保留做深度分析。
 * 设置页可修改账本目录（beancountDir），保存后热生效。
 */
import z from "@deepseek-ai/schemastery";
import { homedir } from "node:os";
import { join } from "node:path";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { LedgerEngine } from "./lib/ledger-engine.mjs";

export const name = "dsh-ledger";

export const inject = ["typert", "settings", "connection"];

/** `ledger` settings namespace：账本根目录。 */
const LedgerSchema = z.object({
  beancountDir: z.string(),
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
const setPayloadSchema = parseObj();
const setResultSchema = parseObj();

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
    {
      id: "dsh-ledger#ledger/setConfig",
      service: "ledger",
      namespace: "ledger",
      method: "setConfig",
      invocation: { kind: "direct" },
      parameters: [
        { name: "payload", wire: "payload", source: "json", codec: { mode: "strict", typeSymbol: "dsh-ledger#SetPayload", schema: setPayloadSchema } },
      ],
      result: { mode: "strict", typeSymbol: "dsh-ledger#SetResult", schema: setResultSchema },
    },
  ],
  model: { services: [], events: [], objects: [] },
};

/** Remote service：读写记账配置（设置页）。 */
class LedgerService extends TypertRemoteService {
  constructor(ctx, scope) {
    super(ctx, "ledger");
    this.scope = scope;
  }
  getConfig() {
    const snap = this.scope.get();
    return { beancountDir: snap?.beancountDir ?? "", writable: true };
  }
  async setConfig(payload) {
    if (payload?.beancountDir !== undefined) await this.scope.update({ beancountDir: payload.beancountDir });
    return { ok: true };
  }
}

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
    },
  });

  const engine = new LedgerEngine({
    beancountDir: scope.get()?.beancountDir,
    log,
  });

  // 配置热更新：设置页修改 beancountDir 后引擎跟随。
  ctx.effect(() => scope.watch((value) => {
    if (value?.beancountDir && value.beancountDir !== engine.beancountDir) {
      engine.beancountDir = value.beancountDir;
      log.info(`账本目录已更新 → ${engine.beancountDir}`);
    }
  }), "dsh-ledger: settings watch");

  // Typert manifest + service（设置页读写配置）。
  const service = new LedgerService(ctx, scope);
  ctx.effect(() => ctx.typert.register(MANIFEST), "dsh-ledger: typert manifest");

  // web 端数据通道：记账 Tab 查询仪表盘数据。
  ctx.connection.rpc.handle("/dsh-ledger", async (endpoint, payload, signal) => {
    try {
      if (signal?.aborted) throw new Error("The request was cancelled.");
      switch (endpoint) {
        case "dashboard":
          return { ok: true, value: await engine.buildDashboard() };
        case "status":
          return { ok: true, value: { beancountDir: engine.beancountDir } };
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
