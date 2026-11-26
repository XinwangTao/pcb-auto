// 静态守卫：禁止"丢弃 EDA 图元 API 的返回值"。
//
// 为什么需要它（不是风格问题，是正确性问题）：
//   pcb_PrimitiveLine.delete  → Promise<boolean>        失败时 resolve(false)，**不抛**
//   pcb_PrimitiveLine.modify  → Promise<IPCB_PrimitiveLine|undefined>  失败时 resolve(undefined)，**不抛**
//   pcb_PrimitiveVia.delete / .modify 同上。
// 所以 `try { await ...delete(id) } catch { }` 这种写法对**最常见的失败方式完全免疫**：
// 它不抛，catch 永远不进，"没抛就算成功"于是把静默失败记成成功。
//
// 2026-11-25 的审计在 pipeline3.js 里找到 7 处这种写法（rollbackLineFix、delObj、
// snapEnds.modify、dogleg/L 的 modify、整轮回滚计数、via 缩/删、track 缩窄），
// 全部只影响日志与板况，不影响 ok 判定 —— 正因如此它们能活很久：
// 没有任何断言会失败，只是"以为修了其实没修"。
//
// 本脚本把这一整类变成可自动检查的不变式：
//   凡是 pcb_Primitive* 的 delete/modify 调用，其结果**必须**被使用
//   （赋值给 const/let、参与比较、或作为 if 条件），不允许裸 await 语句。
//
// 用法：node lint-retval.js <pipeline3.js>
// 退出码：0 = 干净；1 = 有裸调用（缺陷）；2 = 用法/读文件错误

const fs = require('node:fs');

const P = process.argv[2];
if (!P) { console.error('用法：node lint-retval.js <pipeline3.js>'); process.exit(2); }
let src;
try { src = fs.readFileSync(P, 'utf8'); } catch (e) {
  console.error('读不到文件：' + P + '：' + e.message); process.exit(2);
}

// 只关心这些图元类；create 不在范围内（create 失败返回 undefined，
// 而现有代码一律用 `?.getState_PrimitiveId?.()` 判空后 throw / continue，已正确）。
const TARGET = /pcb_Primitive(?:Line|Via|Pad|Pour|Region|Polyline|Fill)\b/;

// 【判据要按"调用点"看，不能按"整行"看】
// 第一版按整行判断，于是 `if (c.kind === 'via') await ...delete(id);` 因为行内
// 有 `===` 被误判成"已比较"，反向对照时漏报了这个形状 —— 守卫自己也得能被证伪。
// 正确做法：定位到调用点前面的那个 `await`，看紧邻它的**前文**是什么：
//   以 `=` 结尾（且不是 ==/===/!=）        → 赋值接住了
//   行内调用之后出现 === / !==            → 参与比较，接住了
//   以 return 结尾                        → 返回值交出去了
//   其它（行首、`{`、`;`、`else`、`)`）    → **丢弃**，就是缺陷
function isConsumed(line, callIdx) {
  const before = line.slice(0, callIdx);
  const after = line.slice(callIdx);
  if (/(^|[^=!<>])=(?!=)/.test(before)) return true;   // 赋值
  if (/===|!==/.test(after)) return true;              // 比较
  if (/\breturn\s*$/.test(before)) return true;        // 交出
  // 多行三元的分支：值会流到外层那个赋值/return 上，不能算丢弃。
  // （本行的 `?` / `:` 单独出现，赋值在上一行，按行看拿不到。）
  if (/[?:]\s*$/.test(before)) return true;
  return false;
}

const lines = src.split('\n');
const bad = [];
for (let i = 0; i < lines.length; i++) {
  const raw = lines[i];
  const t = raw.trim();
  if (!t || t.startsWith('//')) continue;
  if (!TARGET.test(t)) continue;

  // 找出该行所有 `await ... .delete(` / `.modify(` 的调用起点
  const re = /await\s+eda\b[A-Za-z0-9_.]*\s*\.\s*(?:delete|modify)\s*\(/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    if (!isConsumed(raw, m.index)) {
      bad.push({ line: i + 1, text: t, call: m[0].replace(/\s+/g, ' ') });
    }
  }
}

if (bad.length === 0) {
  console.log('OK：没有丢弃 delete/modify 返回值的调用（' + P + '）');
  process.exit(0);
}

console.log('FAIL：发现 ' + bad.length + ' 处丢弃返回值的调用 —— ' +
  '这些调用的失败方式是 resolve(false/undefined)，不抛异常，try/catch 抓不到：');
for (const b of bad) console.log('  L' + b.line + ': ' + b.text);
console.log('');
console.log('修法：把结果接住并判定，例如');
console.log('  if ((await eda.pcb_PrimitiveLine.delete(id)) === true) ok++; else log(...);');
console.log('  const r = await eda.pcb_PrimitiveVia.modify(id, patch);');
console.log('  if (r === undefined) log(\'viaModifyUnconfirmed\', { id });');
process.exit(1);
