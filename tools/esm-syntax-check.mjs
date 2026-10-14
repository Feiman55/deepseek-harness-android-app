// ESM 语法闸门：编译我们 overlay 覆盖的每个 .js（按最近的 package.json 判断 ESM/CJS）。
//
// 为什么需要：`node --check` 对 **ESM** 文件是按 CJS 解析的 —— 一个模板字面量里多了个反引号
// 这类错误它可以照样"通过"，但引擎在运行时 `compileSourceTextModule` 会直接抛
// `SyntaxError: Unexpected identifier '…'`。
//
// 真实事故（本仓库）：往 dsh-tool-bash 的工具描述模板里注入的文本含反引号 →
// 模板提前闭合 → tool-bash 永远起不来 → 所有 agent preset 报 "tool-bash: never started"。
//
// 用法: node --experimental-vm-modules tools/esm-syntax-check.mjs <文件…>
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const files = process.argv.slice(2);
if (files.length === 0) { console.log('   ESM 闸门：没有文件要检查'); process.exit(0); }

// Node 的规则：从文件所在目录往上找**第一个声明了 "type" 的 package.json**；
// 找不到（或没有 type 字段）才按 CJS。之前"遇见 package.json 就停"是错的 ——
// 插件自己的 package.json 往往**没有** type 字段，于是被误判成 CJS 而跳过检查，
// 恰好漏掉了真正会炸的那个文件（真实事故）。改为"往上找第一个有 type 的"。
const typeCache = new Map();
function isEsm(file) {
  const start = path.dirname(path.resolve(file));
  if (typeCache.has(start)) return typeCache.get(start);
  const chain = [];
  let dir = start, verdict = false;
  for (;;) {
    if (typeCache.has(dir)) { verdict = typeCache.get(dir); break; }
    chain.push(dir);
    const pj = path.join(dir, 'package.json');
    if (fs.existsSync(pj)) {
      let t;
      try { t = JSON.parse(fs.readFileSync(pj, 'utf8')).type; } catch {}
      if (t !== undefined) { verdict = t === 'module'; break; }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  for (const d of chain) typeCache.set(d, verdict);
  return verdict;
}

let checked = 0, skipped = 0;
const bad = [];
for (const f of files) {
  if (!fs.existsSync(f)) continue;
  if (!/\.(js|mjs)$/.test(f)) continue;
  if (!f.endsWith('.mjs') && !isEsm(f)) { skipped++; continue; }
  checked++;
  const src = fs.readFileSync(f, 'utf8');
  try {
    new vm.SourceTextModule(src, { identifier: path.resolve(f) });
  } catch (e) {
    bad.push({ file: f, err: String((e && e.message) || e).split('\n')[0] });
  }
}

console.log(`   ESM 闸门：检查 ${checked} 个 ESM 文件（跳过 CJS ${skipped} 个）`);
for (const b of bad) console.log(`   !! ${b.file}\n      ${b.err}`);
if (bad.length) { console.log(`   !! ESM 语法闸门未通过：${bad.length} 个文件编译失败`); process.exit(1); }
console.log('   ESM 闸门：全部通过 ✓');
