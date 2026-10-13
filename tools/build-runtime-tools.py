#!/usr/bin/env python3
"""把 Termux(aarch64) 的 GNU 工具链解出来，供"并入 arm64 运行时资产"使用（W3/W5）。

为什么这么写：
  · Termux 的 .deb 内容根是 `./data/data/com.termux/files/usr/...`（不是 `./bin/...`）；
  · coreutils 之类是**一个多调用二进制 + 一堆符号链接**（实测 coreutils = 1 个 1.30 MB 文件 +
    100 个 symlink，dpkg 口径 2.79 MB）。用 `tarfile.extract` 会把这些链接**解引用成副本**，
    体积从 ~38 MB 虚增到 ~154 MB（实测踩过）——所以这里**显式**处理 symlink / hardlink；
  · 索引里的 SHA256 当场校验（Termux 自带完整性），不额外信任传输。

用法：
  python tools/build-runtime-tools.py --resolve            # 拉索引、算闭包、写 .cache/termux/closure.txt
  python tools/build-runtime-tools.py --extract            # 下载 + 校验 + 解包到 .cache/termux/root
  python tools/build-runtime-tools.py --size               # 打印（按真实类型计权的）体积报告
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import lzma
import os
import pathlib
import shutil
import sys
import tarfile
import urllib.request

REPO = pathlib.Path(__file__).resolve().parent.parent
TM = REPO / ".cache" / "termux"
DEBS = TM / "debs"
ROOTFS = TM / "root"
BASE = "https://packages.termux.dev/apt/termux-main"
PREFIX = "data/data/com.termux/files/usr/"

# 目标包（维护者清单：15 个 GNU 工具 + W5 的设备内最小构建链 3 个）
WANT = [
    "grep", "sed", "gawk", "coreutils", "findutils", "diffutils", "patch",
    "less", "tar", "zip", "unzip", "xz-utils", "zstd", "jq", "openssl",
    "aapt2", "ecj", "dx",
]


def deb_path(fn: str) -> pathlib.Path:
    """Termux 的版本号常带冒号（openssl_1:3.6.5_aarch64.deb），Windows 上文件名非法 → 统一替换。"""
    return DEBS / pathlib.Path(fn).name.replace(":", "_")


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "dsh-build"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return r.read()


def load_index() -> dict:
    index = None
    for name in ("Packages", "Packages.xz", "Packages.gz"):
        url = f"{BASE}/dists/stable/main/binary-aarch64/{name}"
        try:
            raw = fetch(url)
        except Exception:
            continue
        if name.endswith(".xz"):
            raw = lzma.decompress(raw)
        elif name.endswith(".gz"):
            raw = gzip.decompress(raw)
        index = raw.decode("utf-8", "replace")
        print(f"   索引：{url}（{len(index)} 字节，sha256 {hashlib.sha256(index.encode()).hexdigest()[:16]}）")
        break
    if index is None:
        sys.exit("!! 拿不到 Termux Packages 索引")
    pkgs, cur = {}, {}
    for line in index.splitlines():
        if not line.strip():
            if cur.get("Package"):
                pkgs[cur["Package"]] = cur
            cur = {}
            continue
        if line[0] in " \t":
            continue
        k, _, v = line.partition(":")
        cur[k.strip()] = v.strip()
    if cur.get("Package"):
        pkgs[cur["Package"]] = cur
    return pkgs


def deps_of(rec: dict) -> list[str]:
    out = []
    for part in (rec.get("Depends") or "").split(","):
        part = part.split("(")[0].strip()
        first = part.split("|")[0].strip()
        if first:
            out.append(first)
    return out


def resolve() -> None:
    TM.mkdir(parents=True, exist_ok=True)
    pkgs = load_index()
    closure, stack = set(), list(WANT)
    missing = []
    while stack:
        n = stack.pop()
        if n in closure:
            continue
        rec = pkgs.get(n)
        if not rec:
            missing.append(n)
            continue
        closure.add(n)
        stack.extend(deps_of(rec))
    rows = []
    for n in sorted(closure):
        rec = pkgs[n]
        rows.append((n, rec.get("Version", ""), int(rec.get("Installed-Size") or 0),
                     rec.get("Filename", ""), rec.get("SHA256", "")))
    (TM / "closure.txt").write_text(
        "\n".join("\t".join(str(x) for x in r) for r in rows), encoding="utf-8")
    print(f"   闭包 {len(closure)} 个包（目标 {len(WANT)}）；索引里缺失：{missing or '无'}")
    print(f"   dpkg 口径合计：{sum(r[2] for r in rows)/1024:.1f} MB · 清单：{TM / 'closure.txt'}")


def extract() -> None:
    if not (TM / "closure.txt").is_file():
        sys.exit("!! 先跑 --resolve")
    DEBS.mkdir(parents=True, exist_ok=True)
    if ROOTFS.exists():
        shutil.rmtree(ROOTFS)
    ROOTFS.mkdir(parents=True, exist_ok=True)
    devhome = REPO / ".cache" / "devhome"
    existing = set()
    for sub in ("runtime/bin", "runtime/lib", "bin", "lib"):
        d = devhome / sub
        if d.is_dir():
            for f in d.iterdir():
                existing.add(f"{sub.split('/')[-1]}/{f.name}")

    files = links = skipped = 0
    problems = []
    aliases: dict[str, list[tuple[str, str]]] = {"bin": [], "lib": []}
    for line in (TM / "closure.txt").read_text(encoding="utf-8").splitlines():
        n, ver, size, fn, sha = line.split("\t")
        deb = deb_path(fn)
        if not deb.is_file() or hashlib.sha256(deb.read_bytes()).hexdigest() != sha:
            deb.write_bytes(fetch(f"{BASE}/{fn}"))
        if hashlib.sha256(deb.read_bytes()).hexdigest() != sha:
            problems.append(f"{n}: sha256 不符")
            continue
        raw = deb.read_bytes()
        off, data = 8, None
        while off + 60 <= len(raw):
            hdr = raw[off:off + 60]
            name = hdr[:16].decode("ascii", "replace").strip().rstrip("/")
            try:
                size_f = int(hdr[48:58].decode("ascii").strip())
            except ValueError:
                break
            if name.startswith("data.tar"):
                data = raw[off + 60: off + 60 + size_f]
            off += 60 + size_f + (size_f % 2)
        if data is None:
            problems.append(f"{n}: 无 data.tar.*")
            continue
        tmp = TM / f"{n}.data.tar"
        tmp.write_bytes(data)
        with tarfile.open(tmp) as tf:
            by_name = {m.name: m for m in tf.getmembers()}
            members = []
            for m in tf.getmembers():                      # 按 tar 顺序，链接目标先落地
                rel = m.name.lstrip("./")
                if not rel.startswith(PREFIX):
                    continue
                inner = rel[len(PREFIX):]
                parts = inner.split("/")
                if not inner or parts[0] not in ("bin", "lib", "share"):
                    continue
                if len(parts) >= 2 and f"{parts[0]}/{parts[1]}" in existing:
                    skipped += 1
                    continue
                members.append((m, inner))
            for m, inner in members:
                parts = inner.split("/")          # 必须就地重算：过滤循环里的 parts 是上一个成员的
                dst = ROOTFS / inner
                if m.isdir():
                    dst.mkdir(parents=True, exist_ok=True)
                    continue
                dst.parent.mkdir(parents=True, exist_ok=True)
                if dst.exists() or dst.is_symlink():
                    continue
                if m.issym():
                    # 符号链接一律**不物化**（Windows 建链接要特权：实测 WinError 1314；
                    # 且 payload.zip 存不了链接）。分两种情况：
                    #   a) 同目录兄弟链接（如 bin/[ -> coreutils）→ 记进该目录的 LINKS.txt，
                    #      设备端 applyLinks 重建（与既有 soname 别名机制同构，不增加字节）；
                    #   b) 跨目录 / 指向绝对路径（如 bin/dx -> ../share/dx/bin/dx）→ 直接把
                    #      tar 内目标成员的内容写成真实文件（这类是包装脚本，很小）。
                    tgt = m.linkname.rstrip("/")
                    if "/" not in tgt and len(parts) == 2 and parts[0] in aliases:
                        aliases[parts[0]].append((parts[1], tgt))
                        links += 1
                        continue
                    cand = tgt if tgt.startswith("/") is False else ""
                    names = []
                    if cand:
                        names.append(os.path.normpath(os.path.join(os.path.dirname(m.name), cand)).replace("\\", "/"))
                    if "/usr/" in tgt:
                        names.append(PREFIX + tgt.split("/usr/", 1)[1])
                    src_m = next((by_name[n] for n in names if n in by_name), None)
                    if src_m is not None:
                        data_b = tf.extractfile(src_m)
                        dst.write_bytes(data_b.read() if data_b else b"")
                        files += 1
                    else:
                        problems.append(f"{n}: 链接目标找不到（{inner} -> {tgt}）")
                    links += 1
                elif m.islnk():
                    tgt = ROOTFS / m.linkname.lstrip("./").removeprefix(PREFIX)
                    if tgt.exists():
                        os.link(tgt, dst)                  # 硬链接：Windows 上无需特权
                    else:
                        src = tf.extractfile(m)
                        dst.write_bytes(src.read() if src else b"")
                    links += 1
                else:
                    src = tf.extractfile(m)
                    dst.write_bytes(src.read() if src else b"")
                    files += 1
                    # 保留执行位（tar 里有；Windows 上没有，构建期会统一 chmod）
        tmp.unlink()
    for top, pairs in aliases.items():
        if not pairs:
            continue
        out = ROOTFS / top / "LINKS.txt"
        out.parent.mkdir(parents=True, exist_ok=True)
        existing_lines = out.read_text(encoding="utf-8").splitlines() if out.is_file() else []
        merged = sorted(set(existing_lines) | {f"{n} {t}" for n, t in pairs})
        out.write_text("\n".join(merged) + "\n", encoding="utf-8")
        print(f"   {top}/LINKS.txt: {len(merged)} 条别名（不物化，设备端重建）")
    print(f"   普通文件 {files} · 链接(记入别名表) {links} · 因 devhome 同名跳过 {skipped} · 异常 {len(problems)}")
    for p in problems[:10]:
        print("   !!", p)


def size_report() -> None:
    reg = reg_bytes = 0
    lnks = []
    for dirpath, _dn, filenames in os.walk(ROOTFS, followlinks=False):
        for fn in filenames:
            p = pathlib.Path(dirpath) / fn
            if p.is_symlink():
                lnks.append((str(p.relative_to(ROOTFS)), os.readlink(p)))
            elif p.is_file():
                reg += 1
                reg_bytes += p.stat().st_size
    print(f"   普通文件 {reg} 个 = {reg_bytes/1024/1024:.1f} MB（资产实际要携带的数据量）")
    print(f"   符号链接 {len(lnks)} 个（不额外占体积；payload.zip 存不了链接，构建期会物化成副本）")
    for sub in ("bin", "lib", "share"):
        d = ROOTFS / sub
        if d.is_dir():
            f = [x for x in d.rglob("*") if x.is_file() and not x.is_symlink()]
            print(f"     {sub}/: 普通文件 {len(f)} = {sum(x.stat().st_size for x in f)/1024/1024:.1f} MB")
    canary = ["grep", "sed", "gawk", "awk", "find", "xargs", "diff", "patch", "less", "tar",
              "zip", "unzip", "xz", "zstd", "jq", "openssl", "aapt2", "ecj", "dx"]
    print("   关键工具：")
    for t in canary:
        p = ROOTFS / "bin" / t
        if p.is_symlink():
            print(f"     {t:9} symlink -> {os.readlink(p)}")
        elif p.is_file():
            print(f"     {t:9} file {p.stat().st_size} B")
        else:
            print(f"     {t:9} （缺失）")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--resolve", action="store_true")
    ap.add_argument("--extract", action="store_true")
    ap.add_argument("--size", action="store_true")
    a = ap.parse_args()
    if a.resolve:
        resolve()
    if a.extract:
        extract()
    if a.size:
        size_report()
    if not (a.resolve or a.extract or a.size):
        ap.print_help()
