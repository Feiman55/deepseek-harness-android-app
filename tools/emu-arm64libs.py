#!/usr/bin/env python3
"""把 arm64 运行时库装进模拟器的 **guest 库目录**，让 x86_64 模拟器也能跑引擎。

## 为什么需要这个脚本

x86_64 模拟器靠 `ndk_translation`（`ro.dalvik.vm.native.bridge=libndk_translation.so`）跑 arm64 的
node。实测（本仓库踩了很久）：

- 转译进程里的 **guest（arm64）加载器完全不看 `LD_LIBRARY_PATH`**
  —— 往 `LD_LIBRARY_PATH` 指一个目录，无论放垃圾文件、真 ELF 还是什么都不放，
  报错都是同一句 `library "libz.so.1" not found`；
- guest 加载器只在 **`/system/lib64/arm64/`**（该模拟器镜像里的 guest 库目录）里找；
  那里有 `libz.so`，但**没有** `libz.so.1`、`libc++_shared.so`、`libicu*.so.78` 等；
- 于是 node 起不来 → App 的引擎启动超时（`engine start timeout on port 3086`）。

结论：模拟器上要把 node 需要的 **arm64 库按 soname 放进 `/system/lib64/arm64/`**。
真机（arm64 原生）不需要这一步，也不该跑这个脚本。

## 用法

    python tools/emu-arm64libs.py                      # 用默认 arm64 APK，推到 /system/lib64/arm64
    python tools/emu-arm64libs.py --apk path/to.apk
    python tools/emu-arm64libs.py --dest /system/lib64 # 后备目标
    python tools/emu-arm64libs.py --dry-run            # 只列出会推哪些文件

前置：`adb root` 可用、系统分区可 remount（userdebug/eng 模拟器镜像可；`adb remount` 失败时
脚本会退化为 `mount -o rw,remount /`）。脚本是**幂等**的，重复执行只会覆盖同名文件。
"""
from __future__ import annotations

import argparse
import io
import pathlib
import shutil
import subprocess
import sys
import tempfile
import zipfile

REPO = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_APK = REPO / "android-app" / "DeepSeekHarness-community-1.19.3-arm64.apk"


def find_adb() -> str:
    for c in (shutil.which("adb"),
              str(pathlib.Path.home() / "AppData/Local/Android/Sdk/platform-tools/adb.exe"),
              "/usr/bin/adb"):
        if c and pathlib.Path(c).exists():
            return c
    sys.exit("!! 找不到 adb（用 PATH 或 --adb 指定）")


def sh(adb: str, *args: str, check: bool = False):
    r = subprocess.run([adb, *args], capture_output=True, text=True, errors="replace")
    if check and r.returncode != 0:
        sys.exit(f"!! adb {' '.join(args)} 失败：{(r.stdout + r.stderr).strip()[:200]}")
    return (r.stdout + r.stderr)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apk", default=str(DEFAULT_APK))
    ap.add_argument("--dest", default="/system/lib64/arm64")
    ap.add_argument("--adb", default=None)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    adb = a.adb or find_adb()
    apk = pathlib.Path(a.apk)
    if not apk.is_file():
        sys.exit(f"!! 找不到 arm64 APK：{apk}\n   先跑：bash tools/build-apk.sh")

    # 1) 从 APK 的 payload.zip 里取出 runtime/lib 的全部**实体文件**（键用 basename —— 后续按 soname 查）
    z = zipfile.ZipFile(apk)
    pz = zipfile.ZipFile(io.BytesIO(z.read("assets/payload.zip")))
    libs = {pathlib.Path(n).name: pz.read(n) for n in pz.namelist()
            if n.startswith("runtime/lib/") and n.count("/") == 2 and not n.endswith("/")}
    print(f"1) 载荷 runtime/lib：{len(libs)} 个实体文件")

    # 2) 按 LINKS.txt 补出 soname 别名（guest 要的是 libz.so.1 这种名字）
    links = pz.read("runtime/lib/LINKS.txt").decode("utf-8", "replace")
    aliases = {}
    for line in links.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        name, target = parts[0], parts[1]
        if target in libs and name not in libs:
            aliases[name] = libs[target]
    print(f"   按 LINKS.txt 补出别名：{len(aliases)} 个（{'、'.join(list(aliases)[:6])} …）")

    # 3) 只推 node 真正需要的那些（+ 别名），避免把 40+ MB 的 ICU 全塞进系统分区
    import struct

    def dt_needed(data: bytes):
        """node/库的 DT_NEEDED 列表（先扫 .dynamic 找 DT_STRTAB，再解析名字 —— 顺序不能反）。"""
        e_shoff = struct.unpack_from("<Q", data, 0x28)[0]
        es = struct.unpack_from("<H", data, 0x3A)[0]
        en = struct.unpack_from("<H", data, 0x3C)[0]
        dyn = None
        for i in range(en):
            off = e_shoff + i * es
            if struct.unpack_from("<I", data, off + 4)[0] == 6:
                dyn = (struct.unpack_from("<Q", data, off + 0x18)[0],
                       struct.unpack_from("<Q", data, off + 0x20)[0])
                break
        if not dyn:
            return []
        off, size = dyn
        entries, strtab = [], None
        for p in range(off, off + size, 16):
            tag, val = struct.unpack_from("<qQ", data, p)
            if tag == 0:
                break
            if tag == 5:
                strtab = val
            entries.append((tag, val))
        if strtab is None:
            return []
        out = []
        for tag, val in entries:
            if tag == 1:
                out.append(data[strtab + val:data.index(b"\0", strtab + val)].decode())
        return out

    node = pz.read("runtime/bin/node")
    want = set()
    queue = dt_needed(node)
    all_libs = dict(libs)
    all_libs.update(aliases)
    while queue:
        n = queue.pop()
        if n in want:
            continue
        want.add(n)
        data = all_libs.get(n)
        if data:
            queue += dt_needed(data)
    # guest 系统自带的这些不用推
    for syslib in ("libc.so", "libm.so", "libdl.so", "liblog.so", "libstdc++.so",
                   "libandroid.so", "libz.so"):
        want.discard(syslib)
    todo = {n: all_libs[n] for n in sorted(want) if n in all_libs}
    print(f"2) node 需要且要补进 guest 目录的库：{len(todo)} 个")
    for n in sorted(todo):
        print(f"     {n:26} {len(todo[n])/1024:8.1f} KB")

    if a.dry_run:
        print("（--dry-run：不推送）")
        return

    # 4) 准备系统分区写权限
    print("3) 准备 /system 可写")
    sh(adb, "root")
    subprocess.run([adb, "wait-for-device"], capture_output=True)
    if "remount succeeded" not in sh(adb, "remount"):
        sh(adb, "shell", "su 0 mount -o rw,remount /")
    probe = sh(adb, "shell", f"touch {a.dest}/.dsh-wtest && rm -f {a.dest}/.dsh-wtest && echo OK")
    if "OK" not in probe:
        sys.exit(f"!! {a.dest} 不可写（模拟器镜像需要 userdebug/eng，或先 adb root && adb remount）")

    # 5) 推上去
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        for n, data in todo.items():
            (tdp / n).write_bytes(data)
        out = sh(adb, "push", str(tdp) + "/.", a.dest)
        print("4) 推送：", out.strip().splitlines()[-1] if out.strip() else "（无输出）")

    ls = sh(adb, "shell", f"ls {a.dest} | grep -E 'libz|libc\\+\\+|libicu|libsqlite3|libssl|libcrypto|libcares|libffi' | head -14")
    print("5) guest 目录现状：")
    for l in ls.splitlines():
        print("   ", l.strip())
    print("\n完成。现在启动引擎（控制台点「启动引擎」）应能就绪；真机不需要这一步。")


if __name__ == "__main__":
    main()
