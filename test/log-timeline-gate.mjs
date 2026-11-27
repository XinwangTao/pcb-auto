#!/usr/bin/env node
/**
 * log-timeline-gate.mjs · 遥测必须带时刻，否则「总耗时」无法归因
 *
 * 为什么需要它
 * ------------
 * 流水线把总耗时当**一个数**报出来（`_run.json.elapsedMs`），而项目里所有
 * 「这个修复阶段值不值得留」的问题都只能靠**归因**回答：
 *   · `clearanceRound` 修了几条、花了多少秒？
 *   · `patchDrc` 53/53 个构建都 `patchTotal=0`，它到底占了多少时间？
 * 实测 2026-11-27：绿色那一轮 `_log.json` 有 136 条遥测，**0 条带时间戳**。
 * `T0` 和 `phase()` 早就在，但通用的 `log()` 把时刻丢掉了 —— 数据本来就在手边。
 *
 * 现在 `log()` 给每条都打 `ms`（相对 T0）。这道闸门钉三件事：
 *   1) 每一条都有 `ms`；
 *   2) `ms` 单调不减（回退说明有人在别处用了另一个 T0）；
 *   3) 末尾一条的时刻不能超过 `elapsedMs`（超了说明两个时钟不同源）。
 *
 * 判据用**构造的样本**双向验证，再拿真实产物复核。构造样本这一步是必须的：
 * 不然「真实产物恰好合规」只能证明这一次，证明不了这条判据会失败。
 *
 * 退出码（与 test/ 下其它闸门同一契约）
 *   0 通过 / 1 发现了失败 / 2 环境问题（没有样本）
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'out');

function bail(msg) { console.log('  LOGTIMELINE=ENVSKIP  ' + msg); process.exit(2); }

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  [ok] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${extra ? '  ' + extra : ''}`); }
}

/**
 * 判据本体。返回 { problems: string[], top: [{s, ms, dur}] }
 * 纯函数：既能喂构造样本，也能喂真实产物。
 */
function analyze(entries, elapsedMs) {
  const problems = [];
  if (!Array.isArray(entries) || entries.length === 0) {
    return { problems: ['遥测为空 —— 空集合不是「没有时间倒退」'], top: [] };
  }
  const missing = entries.filter((e) => !Number.isFinite(e.ms));
  if (missing.length) {
    problems.push(`${missing.length}/${entries.length} 条没有 ms（第一条：${missing[0].s}）`);
  }
  const withMs = entries.filter((e) => Number.isFinite(e.ms));
  let back = 0;
  for (let i = 1; i < withMs.length; i++) if (withMs[i].ms < withMs[i - 1].ms) back++;
  if (back) problems.push(`ms 倒退 ${back} 次 —— 说明存在第二个 T0`);
  if (withMs.length) {
    const last = withMs[withMs.length - 1].ms;
    if (last <= 0) problems.push(`末尾 ms=${last} 不为正`);
    if (Number.isFinite(elapsedMs) && elapsedMs > 0 && last > elapsedMs * 1.05) {
      problems.push(`末尾 ms=${last} 超过 elapsedMs=${elapsedMs}（两个时钟不同源）`);
    }
  }
  // 阶段归因：相邻两条之间的间隔算到**前一条**头上
  const top = [];
  for (let i = 1; i < withMs.length; i++) {
    const dur = withMs[i].ms - withMs[i - 1].ms;
    if (dur > 0) top.push({ s: withMs[i - 1].s, ms: withMs[i - 1].ms, dur });
  }
  top.sort((a, b) => b.dur - a.dur);
  return { problems, top };
}

// ── 场景 1：构造样本 —— 合规样本必须过 ──────────────────────────────
{
  const good = [
    { s: 'budget', v: { totalMs: 530000 }, ms: 0 },
    { s: 'resolvedParts', v: {}, ms: 120 },
    { s: 'PHASE', v: { n: 'connect' }, ms: 4000 },
    { s: 'drcResult', v: { n: 0 }, ms: 400000 },
  ];
  const r = analyze(good, 410000);
  ok(r.problems.length === 0, '正控：合规样本必须通过', r.problems.join('; '));
  ok(r.top.length === 3, `正控：能算出 3 个阶段间隔（分母=${good.length} 条 → ${good.length - 1} 个间隔）`, `实际 ${r.top.length}`);
  ok(r.top[0].s === 'drcResult' || r.top[0].dur === 396000, '正控：最长的那个间隔必须被认出来', JSON.stringify(r.top[0]));
}

// ── 场景 2：缺 ms 必须红 ───────────────────────────────────────────
{
  const bad = [{ s: 'a', ms: 0 }, { s: 'b' }, { s: 'c', ms: 20 }];
  const r = analyze(bad, 100);
  ok(r.problems.some((p) => /没有 ms/.test(p)), '负控：有一条缺 ms 必须报出来', r.problems.join('; '));
}

// ── 场景 3：ms 倒退必须红 ─────────────────────────────────────────
{
  const bad = [{ s: 'a', ms: 0 }, { s: 'b', ms: 50 }, { s: 'c', ms: 30 }];
  const r = analyze(bad, 100);
  ok(r.problems.some((p) => /倒退/.test(p)), '负控：ms 倒退必须报出来', r.problems.join('; '));
}

// ── 场景 4：末尾 ms 超过 elapsedMs 必须红 ─────────────────────────
{
  const bad = [{ s: 'a', ms: 0 }, { s: 'b', ms: 900 }];
  const r = analyze(bad, 100);
  ok(r.problems.some((p) => /不同源/.test(p)), '负控：末尾 ms 超过 elapsedMs 必须报出来', r.problems.join('; '));
}

// ── 场景 5：空集合不是通过 ────────────────────────────────────────
{
  const r = analyze([], 100);
  ok(r.problems.length > 0, '负控：空遥测必须红（空集合不是「没有倒退」）', r.problems.join('; '));
}

// ── 场景 6：真实产物复核 ──────────────────────────────────────────
{
  // 【没有 out/ 不是错误，是「这台机器上没有现场样本」】CI 与全新克隆都是这种情况。
  // 原来这里直接 bail 了，于是下面的快照兜底永远走不到。
  const dirs = fs.existsSync(OUT)
    ? fs.readdirSync(OUT, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(OUT, d.name))
        .filter((p) => fs.existsSync(path.join(p, '_log.json')))
    : [];

  const scored = dirs.map((p) => {
    const st = fs.statSync(path.join(p, '_log.json'));
    return { p, m: st.mtimeMs };
  }).sort((a, b) => b.m - a.m);

  // 找**最新一个带 ms 的**产物；一个都没有就说明这一轮改动还没被任何构建验证过
  let picked = null;
  for (const c of scored) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(c.p, '_log.json'), 'utf8'));
      const es = Array.isArray(j.entries) ? j.entries : [];
      if (es.some((e) => Number.isFinite(e.ms))) { picked = { ...c, entries: es }; break; }
    } catch (e) { /* 读不动就跳过，不当成样本 */ }
  }
  // 【回退到随仓库提交的真实快照】实测 2026-11-27：CI 与全新克隆里没有 out/ 产物，
  // 这道闸门会 ENVSKIP(2) ⇒ npm test 在 CI 上整条断掉。而「跑不了」不该被读成「通过」，
  // 也不该让一道闸门把整个链条拖下去。所以给一份随仓库提交的快照
  // （test/fixtures/log-with-ms.json，原样拷贝、未裁剪）做兜底，并在标签里**写清楚它是快照**。
  let pickedLabel = null;
  if (!picked) {
    const FX = path.join(ROOT, 'test', 'fixtures', 'log-with-ms.json');
    if (fs.existsSync(FX)) {
      try {
        const j = JSON.parse(fs.readFileSync(FX, 'utf8'));
        const es = Array.isArray(j.entries) ? j.entries : [];
        if (es.some((e) => Number.isFinite(e.ms))) {
          picked = { p: path.dirname(FX), entries: es, elapsedMs: Number(j.elapsedMs) };
          pickedLabel = '仓库快照';
        }
      } catch (e) { /* 读不动就当没有 */ }
    }
  }
  if (!picked) {
    bail(`语料里有 ${dirs.length} 个 _log.json，也没有可用的仓库快照夹具 —— 这一维没有读数`);
  }

  const runFile = path.join(picked.p, '_run.json');
  let elapsedMs = Number.isFinite(picked.elapsedMs) ? picked.elapsedMs : NaN;
  if (!Number.isFinite(elapsedMs) && fs.existsSync(runFile)) {
    try { elapsedMs = Number(JSON.parse(fs.readFileSync(runFile, 'utf8')).elapsedMs); } catch (e) { }
  }
  const r = analyze(picked.entries, elapsedMs);
  const rel = pickedLabel ? `${pickedLabel}（test/fixtures/log-with-ms.json）` : path.relative(ROOT, picked.p);
  ok(r.problems.length === 0, `真实产物：${rel}（${picked.entries.length} 条遥测）`, r.problems.slice(0, 3).join('; '));
  ok(r.top.length > 0, '真实产物：能算出阶段归因表', `间隔数 ${r.top.length}`);

  // 把归因表打出来 —— 这道闸门的产出不只是「过/不过」，还有「时间花在哪」
  console.log('');
  console.log('  ── 本轮耗时归因（间隔算给前一条）──');
  for (const t of r.top.slice(0, 8)) {
    const sec = (t.dur / 1000).toFixed(1);
    const pct = elapsedMs > 0 ? ((t.dur / elapsedMs) * 100).toFixed(1) : '?';
    console.log(`     ${String(sec).padStart(7)}s  ${String(pct).padStart(5)}%  @${String(t.ms).padStart(6)}ms  ${t.s}`);
  }
  console.log('');
}

console.log('');
const total = pass + fail;
if (fail) { console.log(`  LOGTIMELINE=FAIL  ${fail} / ${total} 条断言未过`); process.exit(1); }
if (!total) { console.log('  LOGTIMELINE=FAIL  一条断言都没跑 —— 这不算通过'); process.exit(1); }
console.log(`  LOGTIMELINE=PASS  ${total} 条断言全过（6 场景：合规样本 · 缺 ms · 倒退 · 时钟不同源 · 空集合 · 真实产物）`);
process.exit(0);
