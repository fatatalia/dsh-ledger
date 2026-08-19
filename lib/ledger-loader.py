#!/usr/bin/env python3
"""dsh-ledger 官方解析器：beancount.loader.load_file → JSON 交易数据。

只读，不写账本。stdout 输出 JSON：
{
  "ok": true,
  "errorCount": int,
  "errors": [str, ...],           // 官方解析错误（最多 20 条）
  "transactions": [               // 全部交易（含 include 的所有账本文件）
    { "date": "2026-08-19", "description": "...", "postings": [{account, amount, currency}] }
  ]
}

用法：python3 ledger-loader.py <bean_file>
"""
import json
import sys


def main() -> None:
    bean_file = sys.argv[1] if len(sys.argv) > 1 else "/Users/fatatalia/Beancount/main.bean"
    try:
        from beancount import loader
        entries, errors, _ = loader.load_file(bean_file)
    except Exception as exc:  # noqa: BLE001 — 任何异常都转为 JSON 错误返回
        json.dump({"ok": False, "errorCount": 1, "errors": [str(exc)], "transactions": []}, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return

    txns = []
    for entry in entries:
        if entry.__class__.__name__ != "Transaction":
            continue
        postings = []
        for p in entry.postings:
            if p.units:
                postings.append({
                    "account": p.account,
                    "amount": float(p.units.number),
                    "currency": str(p.units.currency) if p.units.currency else "CNY",
                })
        txns.append({
            "date": str(entry.date),
            "description": entry.narration or "",
            "postings": postings,
        })

    json.dump({
        "ok": True,
        "errorCount": len(errors),
        "errors": [str(e) for e in errors[:20]],
        "transactions": txns,
    }, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
