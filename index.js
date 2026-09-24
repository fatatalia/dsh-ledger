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

export const inject = ["typert", "connection", "webServer"];

// 插件 config。2026-09-24 适配 dsh 0.1.7：ctx.settings.register() 已移除，
// 原 `ledger` settings namespace 并入插件 Config；.volatile() 字段可在设置页热改，
// 改动由 loader 提交进运行中的引用并广播 loader/volatile-update。
export const Config = z.object({
  /** 账本根目录。默认 ~/Beancount。 */
  beancountDir: z.string().default(join(homedir(), "Beancount")).volatile(),
});

function parseObj() {
  // 0.1.7：typert strict codec 必须有 create() 工厂（gateway 走 codec.create().parse(v)）。
  const parse = (value) => {
    if (typeof value !== "object" || value === null) throw new Error("expected object");
    return value;
  };
  return { parse, create: () => ({ parse }) };
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
      result: { mode: "strict", typeSymbol: "dsh-ledger#LedgerConfig", schema: getResultSchema, create: () => getResultSchema },
    },
    {
      id: "dsh-ledger#ledger/setConfig",
      service: "ledger",
      namespace: "ledger",
      method: "setConfig",
      invocation: { kind: "direct" },
      parameters: [
        { name: "payload", wire: "payload", source: "json", codec: { mode: "strict", typeSymbol: "dsh-ledger#SetPayload", schema: setPayloadSchema, create: () => setPayloadSchema } },
      ],
      result: { mode: "strict", typeSymbol: "dsh-ledger#SetResult", schema: setResultSchema, create: () => setResultSchema },
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
  // 本地时间戳（时区跟随系统，Asia/Shanghai +08）。dsh 无自动加时间的 logger，
  // 惯例是插件自己格式化（同 dsh-imessage 的 ts() 模式）。
  const ts = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const log = {
    info: (m) => { console.log(`[${ts()}] [lg] ${m}`); try { Logger?.info?.(m); } catch {} },
    warn: (m) => { console.warn(`[${ts()}] [lg:warn] ${m}`); try { Logger?.warn?.(m); } catch {} },
    error: (m) => { console.error(`[${ts()}] [lg:err] ${m}`); try { Logger?.error?.(m); } catch {} },
  };

  // 0.1.7：配置即插件 Config 的 volatile 字段，这里适配出等价的 scope 外壳。
  const scope = {
    get: () => ({ beancountDir: config.beancountDir.get() }),
    async update(patch) {
      const editor = ctx.get("configEditor");
      const entry = ctx.fiber?.entry;
      if (!editor || entry === undefined) return;
      await editor.edit(entry, (current) => ({ ...current, ...patch }));
    },
    watch(cb) {
      ctx.on("loader/volatile-update", () => { cb(scope.get()); });
    },
  };

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
