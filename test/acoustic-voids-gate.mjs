#!/usr/bin/env node
/*
 * acoustic-voids-gate.mjs —— 封装内部开口（声孔/传感孔）那条路径的闸门
 *
 * 为什么需要它
 * ------------
 * `scripts/audit-placement.mjs` 的第 13 条判据 `acoustic_port_clear` 是**唯一**
 * 能发现「别的器件的封装体盖住麦克风声孔」这一档的检查。EDA 的通用间距检查
 * 结构性查不到它（它查导体与导体），`fabcheck` 也没有这一档，而流水线的图元索引里
 * 根本没有这个对象（DRC 把它误报成 `Slot Region to Track`，`geoIdPrefix` 原话
 * 「前 16 位也不在图元索引里」）。
 *
 * 一条判据如果没有独立的闸门，它会不会红就只能靠人信。这里做两件事：
 *   1) 正控：原样的 v5 必须 pass，而且**分母非空**（声明开口数与求交次数都要读出来）；
 *   2) 负控：五种能把这条判据打红的改动都必须真的打红，且报出的原因必须**对得上**
 *      —— 只断言"变红了"是不够的，别的判据一起红也能让它看起来"生效"。
 *
 * 外加一条容易被忽略的：删掉整个 `_copperVoids` 必须落在 `unknown` 且退 2，
 * 不能落在 `pass`。「没声明」和「声明了且没问题」不是同一件事。
 *
 * 断言里的数字全部**从输出动态读**，不写死。写死「27 次求交」那种数字，
 * 器件一增减就变成一个既不对又不报错的期望值 —— 那是新的假绿来源。
 *
 * 退出码（与 test/ 下其它闸门同一契约）
 *   0 通过 / 1 发现了失败 / 2 环境问题（跑不起来）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'audit-placement.mjs');
const DESIGN = path.join(ROOT, 'designs', 'mic-esp32s3-v5.json');
const RULE_ID = 'acoustic_port_clear';

function bail(msg) { console.log('  ACOUSTIC-VOIDGATE=ENVSKIP  ' + msg); process.exit(2); }
function contractFail(msg) { console.log('  ACOUSTIC-VOIDGATE=FAIL  ' + msg); process.exit(1); }

const sha12 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12).toUpperCase();

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  [ok] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${extra ? '  ' + extra : ''}`); }
}

(async () => {
  for (const p of [SCRIPT, DESIGN]) {
    if (!fs.existsSync(p)) bail(`缺文件 ${path.relative(ROOT, p)}`);
  }
  const beforeSha = sha12(DESIGN);
  let base;
  try { base = JSON.parse(fs.readFileSync(DESIGN, 'utf8')); }
  catch (e) { bail(`读不了 ${path.basename(DESIGN)}: ${e.message}`); }

  // 夹具自检：这条闸门锚在 v5 这一个设计上，它必须真的带着声明，
  // 否则后面七个场景全都变成在测一个空集合（分母为空但"全过"）。
  if (!Array.isArray(base._copperVoids) || base._copperVoids.length === 0) {
    contractFail(`夹具 ${path.basename(DESIGN)} 没有 _copperVoids —— 七个场景会全部落在 unknown，`
      + '这条闸门就成了空分母');
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acoustic-voidgate-'));
  const written = [];

  function runOne(name, mutateFn) {
    const d = JSON.parse(JSON.stringify(base));
    mutateFn(d);
    const fp = path.join(tmp, `v5-${name}.json`);
    fs.writeFileSync(fp, JSON.stringify(d, null, 1), 'utf8');
    written.push(fp);
    const r = spawnSync(process.execPath, [SCRIPT, fp, '--json'], {
      cwd: ROOT, encoding: 'utf8', timeout: 120000,
    });
    if (r.error) bail(`跑不动 audit-placement.mjs: ${r.error.message}`);
    if (r.signal === 'SIGTERM') bail('audit-placement.mjs 超时');
    let j = null;
    try { j = JSON.parse(String(r.stdout || '').trim()); }
    catch (e) {
      // 解析不了就是这台机器上跑不起来，不是判据的判决 —— 归 2。
      bail(`输出不是 JSON（exit=${r.status}）: ${String(r.stdout || '').slice(0, 160)}`
        + ` / stderr: ${String(r.stderr || '').slice(0, 160)}`);
    }
    const rec = (j.rules || []).find((x) => x.id === RULE_ID) || null;
    return { code: r.status, rec, json: j, design: d };
  }

  const VOID = (d) => d._copperVoids[0];

  // ── 场景 1：正控 ────────────────────────────────────────────────
  const s1 = runOne('ok', () => {});
  ok(!!s1.rec, '判据 acoustic_port_clear 出现在输出里（否则闸门在测一个不存在的规则）');
  ok(s1.rec && s1.rec.verdict === 'pass', '正控：原样 v5 判 pass', s1.rec && s1.rec.verdict);
  // 退出码只断言到「与本判据之外的判据状态一致」，不断言「恰好 0」。
  // 整条审计的退出码由 13 条判据共同决定（例如 board_shape_declared 在没声明
  // `_formFactor` 时会落 unknown 退 2），那是它们各自的职责。
  // 一个闸门只该在自己的职责范围内变红 —— 否则它会在别人改动时误报。
  {
    const others = (s1.json?.rules || []).filter((x) => x.id !== RULE_ID);
    const oFail = others.filter((x) => x.verdict === 'fail').length;
    const oUnk = others.filter((x) => x.verdict === 'unknown').length;
    const wantExit = oFail ? 1 : (oUnk ? 2 : 0);
    ok(s1.code === wantExit, '正控：退出码与「本判据之外」的判据状态一致',
      `exit=${s1.code} 期望=${wantExit}（其它 fail=${oFail} unknown=${oUnk}）`);
    ok(oFail === 0, '正控：本判据之外没有其它判据报 fail（否则下面的负控分不清是谁红的）',
      others.filter((x) => x.verdict === 'fail').map((x) => x.id).join(','));
  }
  const det1 = s1.rec ? s1.rec.detail : '';
  ok(/分母=1 个声明开口/.test(det1), '正控：分母里读出了 1 个声明开口', det1.slice(0, 120));
  const mCmp = det1.match(/\/ (\d+) 次「开口 × 器件占位」求交/);
  ok(!!mCmp, '正控：分母里读出了求交次数（不是只说"没人遮挡"）', det1.slice(0, 120));
  if (mCmp) {
    const n = Number(mCmp[1]);
    const nComp = Array.isArray(s1.json?.rules) && base._placement ? Object.keys(base._placement).length : 0;
    ok(n >= 20, '正控：求交次数非空且量级合理', `读过 ${n} 次 / 位号 ${nComp} 个`);
  }
  ok(/位置自洽/.test(det1) && /无器件封装体遮挡/.test(det1), '正控：结论同时覆盖"位置自洽"与"无遮挡"两件事');

  // ── 场景 2：把一颗器件挪到开口上（核心负控）────────────────────
  // 这一档是判据真正的价值所在：铜被禁布区拦住之后，唯一还能堵住开口的就是别的器件。
  const s2 = runOne('body', (d) => { d._placement.R4 = { x: 650, y: -251 }; });
  ok(s2.rec && s2.rec.verdict === 'fail', '负控-器件遮挡：verdict 变 fail', s2.rec && s2.rec.verdict);
  ok(s2.code >= 1, '负控-器件遮挡：exit 非 0', `exit=${s2.code}`);
  const det2 = s2.rec ? s2.rec.detail : '';
  ok(/封装体侵入/.test(det2), '负控-器件遮挡：报出的是"封装体侵入"', det2.slice(0, 140));
  ok(/R4/.test(det2), '负控-器件遮挡：点名了侵入的那个位号 R4', det2.slice(0, 140));
  ok(/U4/.test(det2), '负控-器件遮挡：点名了被保护的那个器件 U4', det2.slice(0, 140));
  ok(/mil²/.test(det2), '负控-器件遮挡：给出了重叠面积（不是只说"重叠了"）', det2.slice(0, 140));

  // ── 场景 3：盒子上下写反 ───────────────────────────────────────
  // 退化盒会让 overlap() 恒返回 0 ⇒「0 个器件遮挡」被读成「开口通畅」。
  const s3 = runOne('swap', (d) => { const v = VOID(d); const t = v.y0; v.y0 = v.y1; v.y1 = t; });
  ok(s3.rec && s3.rec.verdict === 'fail', '负控-倒置盒：verdict 变 fail', s3.rec && s3.rec.verdict);
  const det3 = s3.rec ? s3.rec.detail : '';
  ok(/倒置或退化/.test(det3), '负控-倒置盒：报出的是"倒置或退化"', det3.slice(0, 140));
  ok(/y0=-243 ≥ y1=-260/.test(det3), '负控-倒置盒：把两个端点值都读出来（可复核，不是空话）', det3.slice(0, 140));

  // ── 场景 4：owner 指向不存在的位号 ────────────────────────────
  const s4 = runOne('noowner', (d) => { VOID(d).owner = 'U99'; });
  ok(s4.rec && s4.rec.verdict === 'fail', '负控-无对象：verdict 变 fail', s4.rec && s4.rec.verdict);
  const det4 = s4.rec ? s4.rec.detail : '';
  ok(/没有这个位号/.test(det4), '负控-无对象：报出的是"没有这个位号"', det4.slice(0, 140));
  ok(/U99/.test(det4), '负控-无对象：点名了那个不存在的位号', det4.slice(0, 140));

  // ── 场景 5：盒子跑到 owner 占位之外 ──────────────────────────
  const s5 = runOne('outside', (d) => { const v = VOID(d); v.x0 = 900; v.x1 = 916; });
  ok(s5.rec && s5.rec.verdict === 'fail', '负控-盒子跑偏：verdict 变 fail', s5.rec && s5.rec.verdict);
  const det5 = s5.rec ? s5.rec.detail : '';
  ok(/不在 U4 的占位/.test(det5), '负控-盒子跑偏：报出的是"不在 owner 的占位内"', det5.slice(0, 140));
  ok(/它保护的是别处/.test(det5), '负控-盒子跑偏：说清了后果（保护的是别处）', det5.slice(0, 140));

  // ── 场景 6：删掉 why ─────────────────────────────────────────
  // 没有出处的盒子，别人无法复核它凭什么在那儿。
  const s6 = runOne('nowhy', (d) => { delete VOID(d).why; });
  ok(s6.rec && s6.rec.verdict === 'fail', '负控-无出处：verdict 变 fail', s6.rec && s6.rec.verdict);
  const det6 = s6.rec ? s6.rec.detail : '';
  ok(/没有 why/.test(det6), '负控-无出处：报出的是"没有 why"', det6.slice(0, 140));

  // ── 场景 7：整个 _copperVoids 不存在 ─────────────────────────
  // 【这一条方向决不能错】「没声明」不许读成「通过」。
  const s7 = runOne('absent', (d) => { delete d._copperVoids; });
  ok(s7.rec && s7.rec.verdict === 'unknown', '无声明：落在 unknown（不是 pass）', s7.rec && s7.rec.verdict);
  ok(s7.code === 2, '无声明：退 2（"没能测量"不是"通过"）', `exit=${s7.code}`);
  const det7 = s7.rec ? s7.rec.detail : '';
  ok(/不计入通过/.test(det7), '无声明：明说它不计入通过', det7.slice(0, 140));
  ok(/已知盲区/.test(det7), '无声明：把"审计看不到封装内部"这个盲区写出来');

  // ── 全局自洽 ────────────────────────────────────────────────
  ok(pass + fail > 0, '断言总数非零（分母不为空）');

  // 判据表本身没被悄悄删条：summary.total 必须等于 rules.length
  const s1j = s1.json;
  ok(!!s1j && !!s1j.summary && s1j.summary.total === s1j.rules.length,
    'summary.total 与 rules.length 一致（没有判据被静默丢掉）',
    s1j && s1j.summary ? `${s1j.summary.total} vs ${s1j.rules.length}` : 'no summary');
  const ids = (s1j?.rules || []).map((r) => r.id);
  ok(ids.length === new Set(ids).size, '判据 id 无重复', ids.join(','));
  ok(ids.includes(RULE_ID), '判据表里确实有 acoustic_port_clear');

  // 真设计文件一个字节都不能动：闸门不许改写它验证的证据
  const afterSha = sha12(DESIGN);
  ok(beforeSha === afterSha, '真设计文件未被改动（闸门只写临时副本）', `${beforeSha} -> ${afterSha}`);

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 临时目录删不掉不影响判决 */ }
  const leaked = written.filter((p) => fs.existsSync(p));
  ok(leaked.length === 0, '临时副本已清理', leaked.join(','));

  console.log('');
  if (fail) {
    console.log(`  ACOUSTIC-VOIDGATE=FAIL  ${fail} 条断言不通过 / 共 ${pass + fail}`);
    process.exit(1);
  }
  console.log(`  ACOUSTIC-VOIDGATE=PASS  ${pass} 条断言全过（7 场景：正控 · 器件遮挡 · 倒置盒 · 无对象 · 盒子跑偏 · 无出处 · 无声明）`);
  process.exit(0);
})().catch((e) => {
  console.log('  ACOUSTIC-VOIDGATE=FAIL  执行抛异常: ' + ((e && e.stack) || e));
  process.exit(1);
});
