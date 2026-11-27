#!/usr/bin/env node
/*
 * relayout-formfactor-gate.mjs —— 「板框形状真的驱动摆放」这条依赖的闸门
 *
 * 为什么需要它
 * ------------
 * 用户的批评是：**「你只是选择了一块板子，然后在上面铺满元器件」**。
 * 实测（out/_probe/BOARD-SHAPE-IS-AN-OUTPUT.md §3.0）当时的真相比「摆得不好」更糟：
 * `scripts/relayout.mjs` 把 `boardWidthMil` 读进来，只用在两处 —— 事后判越界。
 * 每一个 x 都是硬编码绝对值。所以把板宽从 1300 改成 1625，**一个器件都不会动**，
 * 只是越界判定变松了。也就是说「根据基板形状决定怎么摆」这条依赖在结构上不存在。
 *
 * 现在补上了 `hz`（水平意图：center / edgeL / edgeR / spreadL / spreadR / {of,dx}）。
 * 但这个补丁自己也需要被钉住，否则下一个人重构 `resolveX` 时把它改回「返回 p.x」，
 * 所有测试仍然全绿，而那条依赖又静悄悄地消失了 —— 这正是它原先存在的方式。
 *
 * 这个闸门钉三个方向
 * ------------------
 *   1) 回归：W 等于设计自身的宽度时，输出必须与设计文件的 `_placement`
 *      **逐器件逐字段相同**。计划表与已建成的板子必须说的是同一件事。
 *      （实测这条曾经不成立：`BANDS` 里 C5 在 IMU 带、设计文件里在 AMP 带，
 *        跑一次 relayout 会把功放的 3V3 去耦挪走 440 mil，而 DRC 一条都不会报。）
 *   2) 属性：加宽板子时，**多数**器件必须移动，且非移动集合必须是「贴边那一簇」，
 *      且两次不同加宽量下的非移动集合必须一致。
 *      判据全部从输出动态读，不写死「28 件里 25 件动」这种数字。
 *   3) 负控：三条能把这条依赖打掉的改动都必须真的打红 ——
 *      只断言「跑通了」是不够的，把 hz 整段关掉也照样「跑通」。
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
const SCRIPT = path.join(ROOT, 'scripts', 'relayout.mjs');
const DESIGN = path.join(ROOT, 'designs', 'mic-esp32s3-v5.json');

function bail(msg) { console.log('  RELAYOUT-FF=ENVSKIP  ' + msg); process.exit(2); }
function contractFail(msg) { console.log('  RELAYOUT-FF=FAIL  ' + msg); process.exit(1); }

const sha12 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12).toUpperCase();

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  [ok] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${extra ? '  ' + extra : ''}`); }
}

if (!fs.existsSync(SCRIPT)) bail('缺 ' + SCRIPT);
if (!fs.existsSync(DESIGN)) bail('缺 ' + DESIGN);

let baseText, base;
try { baseText = fs.readFileSync(DESIGN, 'utf8'); base = JSON.parse(baseText); }
catch (e) { bail('读不到设计文件：' + e.message); }
if (!base._placement || !Object.keys(base._placement).length) bail('设计文件没有 _placement');
const W0 = Number(base.boardWidthMil), H0 = Number(base.boardHeightMil);
if (!(W0 > 0 && H0 > 0)) bail('设计文件缺 boardWidthMil / boardHeightMil');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'relayout-ff-'));
const PARTS = Object.keys(base._placement).sort();
console.log(`  基准：${path.basename(DESIGN)}  ${W0}×${H0} mil  ${PARTS.length} 个器件  mtime=${fs.statSync(DESIGN).mtime.toISOString()}`);
console.log(`  工具：scripts/relayout.mjs  sha=${sha12(SCRIPT)}`);
console.log(`  临时目录：${TMP}`);

/** 写一份只改 boardWidthMil 的基准副本 */
function baseAt(width, name, extraPlacement) {
  const j = JSON.parse(baseText);
  j.boardWidthMil = width;
  if (extraPlacement) Object.assign(j._placement, extraPlacement);
  const p = path.join(TMP, name + '.json');
  fs.writeFileSync(p, JSON.stringify(j, null, 1), 'utf8');
  return p;
}

function runRelayout(scriptPath, basePath, outName) {
  const out = path.join(TMP, outName + '.json');
  return { out, r: spawnSync(process.execPath, [scriptPath, basePath, out], { cwd: ROOT, encoding: 'utf8' }) };
}

const FIELDS = ['x', 'y', 'rot', 'lock'];
function samePlacement(a, b) {
  const bad = [];
  for (const d of Object.keys(a)) {
    if (!(d in b)) { bad.push(`${d} 缺失`); continue; }
    for (const f of FIELDS) {
      const va = a[d][f], vb = b[d][f];
      const num = typeof va === 'number' || typeof vb === 'number';
      if (num ? Math.abs((va ?? 0) - (vb ?? 0)) > 1e-6 : va !== vb) bad.push(`${d}.${f}: ${va} → ${vb}`);
    }
  }
  return bad;
}

// ── 场景 1：W = 设计自身宽度 ⇒ 输出必须与设计文件逐器件逐字段相同 ──────────
const b0 = baseAt(W0, 'base-w0');
const s1 = runRelayout(SCRIPT, b0, 'out-w0');
ok(s1.r.status === 0, `正控：W=${W0}（设计自身宽度）退 0`, `实际 exit=${s1.r.status} ${(s1.r.stderr || '').slice(0, 200)}`);
if (s1.r.status !== 0) contractFail('连基准宽度都跑不出来，后面的断言没有意义');

const got0 = JSON.parse(fs.readFileSync(s1.out, 'utf8'))._placement;
const diff0 = samePlacement(base._placement, got0);
ok(Object.keys(got0).length === PARTS.length, `输出器件数 = 设计器件数`, `${Object.keys(got0).length} / ${PARTS.length}`);
ok(diff0.length === 0, `回归：输出与设计文件 _placement 逐器件逐字段相同（分母=${PARTS.length} 件 × 4 字段）`,
  diff0.slice(0, 6).join('; '));

// ── 场景 2：加宽板子 ⇒ 多数器件必须移动 ────────────────────────────────
const W1 = W0 + 200, W2 = Math.round(W0 * 1.25);
const b1 = baseAt(W1, 'base-w1'), b2 = baseAt(W2, 'base-w2');
const s2 = runRelayout(SCRIPT, b1, 'out-w1');
const s3 = runRelayout(SCRIPT, b2, 'out-w2');
ok(s2.r.status === 0 && s3.r.status === 0, `正控：W=${W1} / W=${W2} 都退 0`,
  `exit=${s2.r.status}/${s3.r.status}`);
if (s2.r.status === 0 && s3.r.status === 0) {
  const p1 = JSON.parse(fs.readFileSync(s2.out, 'utf8'))._placement;
  const p2 = JSON.parse(fs.readFileSync(s3.out, 'utf8'))._placement;

  const moved1 = PARTS.filter((d) => Math.abs(p1[d].x - got0[d].x) > 0.01);
  const moved2 = PARTS.filter((d) => Math.abs(p2[d].x - got0[d].x) > 0.01);
  const still1 = PARTS.filter((d) => !moved1.includes(d));
  const still2 = PARTS.filter((d) => !moved2.includes(d));

  // 判据：移动的必须严格多于不动的。分母是实测器件数，不是写死的数。
  ok(moved1.length > still1.length,
    `属性：W=${W1} 时随板宽移动的器件多于不动的（分母=${PARTS.length} 件）`,
    `移动 ${moved1.length} / 不动 ${still1.length}（${still1.join(',')}）`);
  ok(moved2.length > still2.length,
    `属性：W=${W2} 时随板宽移动的器件多于不动的（分母=${PARTS.length} 件）`,
    `移动 ${moved2.length} / 不动 ${still2.length}（${still2.join(',')}）`);
  ok(still1.join(',') === still2.join(','),
    '非移动集合在两次不同加宽量下相同（说明它是「贴边」而不是「凑巧没动」）',
    `${still1.join(',')} vs ${still2.join(',')}`);

  // 非移动集合里不许有「本该在中线上」的器件 —— 那是「居中件被漏掉了」的典型形态。
  // 中线判据用板宽算，不写死 650。
  const onCenter = still1.filter((d) => Math.abs(got0[d].x - W0 / 2) <= 1);
  ok(onCenter.length === 0, '非移动集合里没有中线件（中线件不动就是漏了）',
    `中线件：${onCenter.join(',') || '无'}`);

  // 方向性：这是 x-only 扩板策略，y 一个都不许动
  const movedY = PARTS.filter((d) => Math.abs(p1[d].y - got0[d].y) > 1e-6 || Math.abs(p2[d].y - got0[d].y) > 1e-6);
  ok(movedY.length === 0, '方向性：加宽板子只改 x，y 一律不变（x-only 策略）',
    movedY.slice(0, 5).join(','));

  // 贴边契约：edgeL 的器件在三个宽度下 x 必须完全相同（它属于「这条边」，不属于「这个位置」）
  const edgeAnchored = still1.filter((d) => Math.abs(p1[d].x - p2[d].x) < 0.01 && Math.abs(p1[d].x - got0[d].x) < 0.01);
  ok(still1.length === 0 || edgeAnchored.length === still1.length,
    '贴边契约：所有不动的器件在 W0/W1/W2 下 x 逐坐标相同（不是「只在某个宽度碰巧一样」）',
    still1.join(','));

  // 跟随关系：hz.of 的语义是「贴着某一颗」，所以被跟随者移动时跟随者必须同向同量移动。
  // 这里用一条可算的性质代替读源码：移动了的器件里，必须存在成对器件 x 差值保持不变。
  const movedParts = moved1.filter((d) => moved2.includes(d));
  let pairKept = 0;
  for (let i = 0; i < movedParts.length; i++) {
    for (let j = i + 1; j < movedParts.length; j++) {
      const a = movedParts[i], b = movedParts[j];
      const d0 = got0[a].x - got0[b].x, d1 = p1[a].x - p1[b].x;
      if (Math.abs(d0 - d1) < 0.01) pairKept++;
    }
  }
  ok(pairKept > 0, `相对关系被保持的器件对 > 0（分母=${movedParts.length} 个移动件全配对）`, `保持 ${pairKept} 对`);
}

// ── 场景 3：负控 —— 把 hz 整段关掉，属性断言必须变红 ─────────────────────
{
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const anchor = '  const hz = p.hz;\n';
  if (src.split(anchor).length - 1 !== 1) contractFail('负控锚点不唯一，闸门自身不能自证');
  const mut = path.join(TMP, 'mut-hz-off.mjs');
  fs.writeFileSync(mut, src.replace(anchor, anchor + '  return { x: p.x, how: \'绝对\' };  // MUTATION\n'), 'utf8');
  const r = runRelayout(mut, b1, 'out-mut1');
  ok(r.r.status === 0, '负控 M1（关掉 hz、全部退回绝对坐标）本身仍能跑通 —— 所以"跑通"不是证据', `exit=${r.r.status}`);
  let mutatedMovers = -1;
  if (r.r.status === 0) {
    const pm = JSON.parse(fs.readFileSync(r.out, 'utf8'))._placement;
    mutatedMovers = PARTS.filter((d) => Math.abs(pm[d].x - got0[d].x) > 0.01).length;
  }
  ok(mutatedMovers === 0, '负控 M1：关掉 hz 后有 0 个器件随板宽移动 ⇒ 上面那条「移动多于不动」会变红',
    `实际移动 ${mutatedMovers} 件`);
}

// ── 场景 4：负控 —— hz.of 前向引用 ⇒ 必须退 2 且说清原因 ────────────────
{
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const anchor = "{ des: 'C5', x: 860, y: -2160, hz: { of: 'U3', dx: 210 } }";
  if (src.split(anchor).length - 1 !== 1) contractFail('负控锚点不唯一（C5 条目），闸门自身不能自证');
  const mut = path.join(TMP, 'mut-fwdref.mjs');
  fs.writeFileSync(mut, src.replace(anchor, "{ des: 'C5', x: 860, y: -2160, hz: { of: 'C10', dx: 210 } }"), 'utf8');
  const r = runRelayout(mut, b1, 'out-mut2');
  ok(r.r.status === 2, '负控 M2（hz.of 指向排在后面的器件）退 2，不是 0 也不是 1', `exit=${r.r.status}`);
  ok(/排在它前面/.test(r.r.stderr || ''), '负控 M2 的报错说明了原因（「被依赖的器件必须在 BANDS 里排在它前面」）',
    (r.r.stderr || '').slice(0, 160));
}

// ── 场景 5：负控 —— 基设计里有计划表没有的器件 ⇒ 退 2，不许静默漏摆 ──────
{
  const bExtra = baseAt(W0, 'base-extra', { X99: { x: 10, y: -10, rot: 0 } });
  const r = runRelayout(SCRIPT, bExtra, 'out-mut3');
  ok(r.r.status === 2, '负控 M3（基设计多出一个计划表里没有的位号）退 2', `exit=${r.r.status}`);
  ok(/计划里没有/.test(r.r.stderr || '') && /X99/.test(r.r.stderr || ''),
    '负控 M3 的报错点名了被漏掉的位号', (r.r.stderr || '').slice(0, 160));
}

// ── 收尾 ────────────────────────────────────────────────────────────────
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { }

console.log('');
const total = pass + fail;
if (fail) {
  console.log(`  RELAYOUT-FF=FAIL  ${fail} / ${total} 条断言未过`);
  process.exit(1);
}
if (total === 0) { console.log('  RELAYOUT-FF=FAIL  一条断言都没跑 —— 这不算通过'); process.exit(1); }
console.log(`  RELAYOUT-FF=PASS  ${total} 条断言全过（5 场景：基准回归 · 板形响应 · 关掉 hz · 前向引用 · 漏摆位号）`);
process.exit(0);
