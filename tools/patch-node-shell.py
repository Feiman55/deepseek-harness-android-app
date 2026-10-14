#!/usr/bin/env python3
"""把内置 node 里**硬编码的 Termux shell 路径**改成设备上真实存在的 shell（本版）。

## 问题（安卓 agent 实测 + 我们的复现）

内置 node 是 **Termux 构建**，它在 `child_process` 里给 Android 打了补丁，把默认 shell 写死成

    file = '/data/data/com.termux/files/usr/bin/sh';

该路径在非 Termux 设备上不存在 → 任何 `execSync` / `spawnSync(..., {shell:true})` 都报

    spawnSync /data/data/com.termux/files/usr/bin/sh ENOENT

而 `SHELL` / `DSH_BASH_PATH` 环境变量**救不了它**（这段是源码级默认值，晚于 env 判断）。

## 做法

这段 JS 源码是**以明文嵌在 node 二进制里**的，所以可以做**等长字节替换**：

    原： '/data/data/com.termux/files/usr/bin/sh'      （38 字符 + 2 引号 = 40 字节）
    新： '/system/bin/sh'/*<padding>*/                 （17 字节 + 23 字节注释 = 40 字节）

- 新路径用 `/system/bin/sh`（14 字符，任何人都能执行，Android 全部版本都有）；
- 剩余长度用一段**闭合的 JS 块注释**补齐 → 源码仍合法、长度不变、不影响后续字节；
- 幂等：已替换过就直接返回；找不到原串则**不动**并报警（node 换版本时提醒我们复核）。

用法：
  python tools/patch-node-shell.py <node 二进制>          # 就地打补丁（会先备份 .orig）
  python tools/patch-node-shell.py <node> --check         # 只检查状态
"""
from __future__ import annotations

import argparse
import pathlib
import shutil
import sys

OLD = b"'/data/data/com.termux/files/usr/bin/sh'"
NEW_PATH = "/system/bin/sh"


def make_replacement() -> bytes:
    lit = b"'" + NEW_PATH.encode() + b"'"
    pad = len(OLD) - len(lit)
    if pad < 4:
        sys.exit(f"!! 新路径太长（{len(lit)} 字节），放不进 {len(OLD)} 字节")
    body = pad - 4
    return lit + b"/*" + b"p" * body + b"*/"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("node", help="node 二进制路径")
    ap.add_argument("--check", action="store_true", help="只检查，不改")
    ap.add_argument("--backup", action="store_true",
                    help="保留 <node>.orig 备份（默认不保留 —— 实测踩过：备份被一起打进 payload，"
                         "产物虚增约 15 MB）")
    a = ap.parse_args()

    p = pathlib.Path(a.node)
    if not p.is_file():
        sys.exit(f"!! 找不到 {p}")
    data = p.read_bytes()
    repl = make_replacement()
    assert len(repl) == len(OLD), (len(repl), len(OLD))

    n_old = data.count(OLD)
    n_new = data.count(repl)

    if a.check:
        patched = (n_old == 0 and n_new == 1)
        print(f"   {p.name}: 旧串 {n_old} 处 · 新串 {n_new} 处 -> {'已打补丁' if patched else '未打补丁'}")
        # 退出码给构建脚本用（比 grep 中文输出稳）
        sys.exit(0 if patched else 1)

    if n_new == 1 and n_old == 0:
        print(f"   {p.name}: 已是 /system/bin/sh（幂等跳过）")
        return
    if n_old != 1:
        # 不动：可能是新版 node 改了这段，需要人来复核
        print(f"   !! {p.name}: 预期旧串出现 1 次，实际 {n_old} 次 —— 不改动，请复核 node 版本")
        return

    note = ""
    if a.backup:
        bak = p.with_suffix(p.suffix + ".orig")
        if not bak.exists():
            shutil.copy2(p, bak)
        note = f"；备份 {bak.name}"
    p.write_bytes(data.replace(OLD, repl, 1))
    print(f"   {p.name}: 已把 child_process 默认 shell 改为 {NEW_PATH}"
          f"（等长替换 {len(OLD)} 字节{note}）")


if __name__ == "__main__":
    main()
