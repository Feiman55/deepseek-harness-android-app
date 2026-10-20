"""payload 体积裁剪 B：跨目录重复文件去重（同内容只存一份 + LINKS-DEDUP.txt）。

背景：内核 0.2.1 起 zod 被复制 54 份（v3/v4 版本冲突 → npm 无法提升），
每份都带 dist + src，光 zod 就 200 MB。同版本副本**内容完全相同**，
所以可以只保留一份，其余在设备端用硬链重建（解压器已支持硬链→软链→复制）。

用法: python tools/dedup-payload.py <staging 目录>   # 期望 <staging>/dshroot/lib 存在
产物: <staging>/dshroot/lib/LINKS-DEDUP.txt   （每行 相对路径 \t 目标相对路径）
"""
import hashlib
import pathlib
import sys

STAGING = pathlib.Path(sys.argv[1]).resolve()
LIB = STAGING / "dshroot" / "lib"
if not LIB.is_dir():
    print("   [skip] 找不到 dshroot/lib")
    sys.exit(0)

MIN_SIZE = 32 * 1024          # 小于 32KB 的文件不值得为它建链接（链接本身也有开销）
roots = [LIB / "node_modules"]
if not roots[0].is_dir():
    print("   [skip] 找不到 node_modules")
    sys.exit(0)


def sha256(p: pathlib.Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


groups = {}
count = 0
for root in roots:
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        try:
            st = p.stat()
        except OSError:
            continue
        if st.st_size < MIN_SIZE:
            continue
        count += 1
        groups.setdefault((st.st_size, sha256(p)), []).append(p)

links = []
saved = 0
for (size, _digest), paths in groups.items():
    if len(paths) < 2:
        continue
    paths.sort()
    keep = paths[0]
    keep_rel = keep.relative_to(LIB).as_posix()
    for dup in paths[1:]:
        links.append((dup.relative_to(LIB).as_posix(), keep_rel))
        saved += size
        dup.unlink()

print(f"  裁剪 B: 参与去重的文件 {count} 个；去重 {len(links)} 个副本，省 {saved/1024/1024:.1f} MB")

if links:
    out = LIB / "LINKS-DEDUP.txt"
    lines = ["# 跨目录去重表（构建期生成；设备端按 硬链→软链→复制 重建）",
             "# 每行：副本相对路径 <TAB> 目标相对路径（都相对 dshroot/lib）"]
    lines += [f"{a}\t{b}" for a, b in links]
    out.write_bytes(("\n".join(lines) + "\n").encode("utf-8"))
    print(f"         写 {out.name}：{len(links)} 行")
