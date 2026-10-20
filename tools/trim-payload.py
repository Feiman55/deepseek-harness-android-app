"""payload 体积裁剪 A：node_modules 里的"运行期不需要"文件。

保留原则（只动**包根**下的东西）：
  · LICENSE* / NOTICE / COPYING / AUTHORS 一律保留
  · SKILL.md 与 skills/ 下内容一律保留（运行时真读）
  · @noble/* 这类把 src/ 当运行时代码的包：只删 src 里的 *.ts，js/json 保留
删除项：
  · 包根的 .bin / __pycache__ / .github / test(s) / __tests__ / example(s) / docs
  · *.map / *.d.ts / *.d.mts / *.d.cts / *.pyc
  · src/**/*.ts|tsx|mts|cts
  · 包根的 *.md（README/CHANGELOG），保留 SKILL.md 与许可证类
"""
import pathlib
import shutil
import sys

ROOT = pathlib.Path(sys.argv[1]).resolve()
DROP_DIRS = {".bin", "__pycache__", ".github", "test", "tests", "__tests__", "example", "examples", "docs"}
DROP_SUFFIX = (".map", ".d.ts", ".d.mts", ".d.cts", ".pyc")
KEEP_MD = ("skill.md", "license", "notice", "copying", "authors", "third_party")


def package_roots():
    for nm in ROOT.rglob("node_modules"):
        if not nm.is_dir():
            continue
        for child in list(nm.iterdir()):
            if not child.is_dir():
                continue
            if child.name.startswith("@"):
                for sub in list(child.iterdir()):
                    if sub.is_dir():
                        yield sub
            else:
                yield child


removed_files = removed_dirs = 0
saved = 0

for pkg in package_roots():
    if not pkg.is_dir():
        continue
    for sub in list(pkg.iterdir()):
        if sub.is_dir() and sub.name in DROP_DIRS:
            saved += sum(f.stat().st_size for f in sub.rglob("*") if f.is_file())
            shutil.rmtree(sub, ignore_errors=True)
            removed_dirs += 1
    for f in list(pkg.rglob("*")):
        if not f.is_file():
            continue
        n = f.name.lower()
        if n.startswith(("license", "notice", "copying", "authors")):
            continue
        drop = False
        if f.name.endswith(DROP_SUFFIX):
            drop = True
        elif "/src/" in f.as_posix() and f.suffix.lower() in (".ts", ".tsx", ".mts", ".cts"):
            drop = True
        elif f.suffix.lower() in (".md", ".markdown") and not any(k in n for k in KEEP_MD):
            drop = True
        if drop:
            try:
                saved += f.stat().st_size
                f.unlink()
                removed_files += 1
            except OSError:
                pass

print(f"   裁剪 A: 删除 {removed_files} 文件 / {removed_dirs} 目录，省 {saved/1024/1024:.1f} MB")
