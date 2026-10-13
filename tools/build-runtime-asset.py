#!/usr/bin/env python3
"""把 Termux GNU 工具集合并进 arm64 运行时资产，并打出新的 .tar.gz（W3）。

流程：
  1. 以 `.cache/devhome` 为基线**复制**一份到暂存目录（不就地改 devhome，保证可重复）；
  2. 把 `.cache/termux/root/{bin,lib,share}` 覆盖进 `stage/runtime/`：
     · **同名文件跳过**（保护 node 自己的 libz/libcrypto 等，实测 devhome 已有 23 个同名）；
     · `LINKS.txt` 是别名清单，与既有内容**合并**（不物化符号链接：payload.zip 存不了链接）；
  3. 按与旧资产相同布局（`runtime/ python/ npm/ pnpm/ git/ bash/ bin/ rish/ .dsh/`）打 tar.gz；
  4. 打印体积、成员数与 sha256（发布用）。

用法：
  python tools/build-runtime-asset.py --out .cache/dsh-android-runtime-arm64-tools1.tar.gz
  python tools/build-runtime-asset.py --out X --keep-stage      # 保留暂存目录便于排查
"""
from __future__ import annotations

import argparse
import hashlib
import pathlib
import shutil
import sys
import tarfile

REPO = pathlib.Path(__file__).resolve().parent.parent
TOP_DIRS = ["runtime", "python", "npm", "pnpm", "git", "bash", "bin", "rish", ".dsh"]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--devhome", default=str(REPO / ".cache" / "devhome"))
    ap.add_argument("--tools", default=str(REPO / ".cache" / "termux" / "root"))
    ap.add_argument("--out", required=True)
    ap.add_argument("--keep-stage", action="store_true")
    a = ap.parse_args()

    devhome = pathlib.Path(a.devhome)
    tools = pathlib.Path(a.tools)
    out = pathlib.Path(a.out)
    if not devhome.is_dir():
        sys.exit(f"!! devhome 不存在：{devhome}")
    if not tools.is_dir():
        sys.exit(f"!! 工具集不存在（先跑 tools/build-runtime-tools.py --extract）：{tools}")

    stage = REPO / ".cache" / "asset-stage"
    if stage.exists():
        shutil.rmtree(stage)
    print(f"1) 复制 devhome → {stage}（{devhome}）")
    stage.mkdir(parents=True)
    for d in TOP_DIRS:
        src = devhome / d
        if src.is_dir():
            shutil.copytree(src, stage / d, symlinks=False)
        elif src.is_file():
            shutil.copy2(src, stage / d)

    # 2) 覆盖工具集
    added = skipped = 0
    for top in ("bin", "lib", "share"):
        src_top = tools / top
        if not src_top.is_dir():
            continue
        dst_top = stage / "runtime" / top
        dst_top.mkdir(parents=True, exist_ok=True)
        for f in src_top.rglob("*"):
            if not f.is_file():
                continue
            rel = f.relative_to(src_top)
            dst = dst_top / rel
            if dst.exists():
                skipped += 1
                continue
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, dst)
            added += 1
    print(f"   新增 {added} 个文件 · 同名跳过 {skipped} 个（保护运行时自己的库）")

    # 3) 合并别名清单（bin/lib 各一份；设备端 applyLinks 重建，不占 APK 字节）
    for top in ("bin", "lib"):
        src_links = tools / top / "LINKS.txt"
        if not src_links.is_file():
            continue
        dst_links = stage / "runtime" / top / "LINKS.txt"
        old = dst_links.read_text(encoding="utf-8").splitlines() if dst_links.is_file() else []
        new = src_links.read_text(encoding="utf-8").splitlines()
        merged = sorted({ln.strip() for ln in old + new if ln.strip()})
        dst_links.write_text("\n".join(merged) + "\n", encoding="utf-8")
        print(f"   {top}/LINKS.txt 合并后 {len(merged)} 条（原 {len(old)} + 新 {len(new)}）")

    # 4) 打包（布局与旧资产一致：成员以 runtime/… 开头）
    out.parent.mkdir(parents=True, exist_ok=True)
    print(f"4) 打包 → {out}")
    with tarfile.open(out, "w:gz") as tf:
        for d in TOP_DIRS:
            p = stage / d
            if p.exists():
                tf.add(p, arcname=d)
    size = out.stat().st_size
    sha = hashlib.sha256(out.read_bytes()).hexdigest()
    with tarfile.open(out) as tf:
        n = sum(1 for _ in tf.getmembers())
    print(f"\n完成：{out}")
    print(f"   体积 {size/1024/1024:.1f} MB · 成员 {n} 个")
    print(f"   sha256 {sha}")
    if not a.keep_stage:
        shutil.rmtree(stage)
        print("   （暂存目录已删；加 --keep-stage 可保留）")


if __name__ == "__main__":
    main()
