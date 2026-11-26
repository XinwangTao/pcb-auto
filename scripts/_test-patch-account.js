// patchDrc 逐条对账的离线对照测试。
// 目的：证明"补线成功 ≠ 断连消失"这条新机制真的会触发，而不是只写在代码里。
// 被测表达式与本文件**逐字相同**（从 pipeline3.js L2138-2168 抄出），
// 因此这里通过等于逻辑通过；真实板上会打印 patchPerErr / patchRoundNet 作二次证据。
// 用法：node scripts\_test-patch-account.js

const eNet = (n) => String(n.net || (n.explanation?.errData || {}).net || '').toUpperCase();
const eIds = (n) => { const d = n.explanation?.errData || {};
  return [String(d.obj1 || ''), String(d.obj2 || '')].sort().join('|'); };
const ePos = (n) => { const p = (n.explanation?.errData || {}).position;
  return p ? { x: Number(p.x) * 10, y: Number(p.y) * 10 } : null; };

function reconcile(connErrs, targets, afterConn) {
  const beforeKeys = new Set(connErrs.map(n => eNet(n) + '#' + eIds(n)));
  let stillBroken = 0;
  const per = [];
  for (const t of targets) {
    const tid = t.ids.map(String).sort().join('|');
    const tNet = String(t.net).toUpperCase();
    const hit = afterConn.some(n => {
      if (eNet(n) !== tNet) return false;
      if (eIds(n) === tid) return true;
      const p = ePos(n);
      return !!p && Number.isFinite(p.x) && Math.hypot(p.x - t.pos.x, p.y - t.pos.y) <= 30;
    });
    if (hit) stillBroken++;
    per.push({ net: t.net, cleared: !hit, obj: tid });
  }
  const actuallyFixed = targets.length - stillBroken;
  const newConn = afterConn.filter(n => !beforeKeys.has(eNet(n) + '#' + eIds(n))).length;
  return { actuallyFixed, stillBroken, newConn, per };
}

// 造一个 DRC 违规叶子（形状与真实 flat 节点一致）。
// 【单位陷阱】真实 errData.position 是**画布单位** = mil/10（pipeline3.js 里有多处 ×10），
// 而 target.pos 已经是 mil。所以这里入参用 mil，写进 position 时 /10，
// 与生产代码 `pos = edPos.x * 10` 严格互逆。第一版夹具忘了这一步，
// 导致"同网同位置"判成"位置很远"，是好测试抓到的夹具 bug。
const err = (net, obj1, obj2, xMil, yMil) => ({
  errorType: 'Connection Error',
  explanation: { errData: { net, obj1, obj2, position: { x: xMil / 10, y: yMil / 10 } } },
});

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

console.log('=== 情形 A：补了线，同一处断连复检仍在 → 不能算修好（旧代码会算 1）===');
{
  const before = [err('SDA', '6a999d227738f18f', '', 2105.97, 100)];
  const targets = [{ net: 'SDA', ids: ['6a999d227738f18f', ''], pos: { x: 2105.97, y: 100 } }];
  const after = [err('SDA', '6a999d227738f18f', '', 2105.97, 100)];
  const r = reconcile(before, targets, after);
  check('actuallyFixed', r.actuallyFixed, 0);
  check('stillBroken', r.stillBroken, 1);
  check('patchPerErr.cleared', r.per[0].cleared, false);
}

console.log('\n=== 情形 B：补了线，该处断连确实消失 → 算修好 ===');
{
  const before = [err('GND', 'aaa', 'bbb', 500, 500)];
  const targets = [{ net: 'GND', ids: ['aaa', 'bbb'], pos: { x: 500, y: 500 } }];
  const r = reconcile(before, targets, []);
  check('actuallyFixed', r.actuallyFixed, 1);
  check('stillBroken', r.stillBroken, 0);
  check('newConn', r.newConn, 0);
}

console.log('\n=== 情形 C：复检换了 obj id 但同网同位置 → 仍判未修好（宁少算不多算）===');
{
  const before = [err('SDA', 'old1', 'old2', 800, 400)];
  const targets = [{ net: 'SDA', ids: ['old1', 'old2'], pos: { x: 800, y: 400 } }];
  // 新补的线成了参与者，id 全变；位置只挪了 12mil
  const after = [err('SDA', 'newLine99', 'pad7', 812, 412)];
  const r = reconcile(before, targets, after);
  check('actuallyFixed', r.actuallyFixed, 0);
  check('stillBroken', r.stillBroken, 1);
}

console.log('\n=== 情形 D：修好了 A，但在别处造出 B → A 算修好，B 必须被记成新增 ===');
{
  const before = [err('SDA', 'a1', 'a2', 300, 300)];
  const targets = [{ net: 'SDA', ids: ['a1', 'a2'], pos: { x: 300, y: 300 } }];
  const after = [err('SDA', 'b1', 'b2', 1500, 1200)]; // 同网，但位置远
  const r = reconcile(before, targets, after);
  check('actuallyFixed', r.actuallyFixed, 1);
  check('newConn（别处新增）', r.newConn, 1);
}

console.log('\n=== 情形 E：两处目标，只修好一处 → 只计 1（旧代码计 2）===');
{
  const before = [err('SDA', 'p', 'q', 100, 100), err('SCL', 'r', 's', 900, 900)];
  const targets = [
    { net: 'SDA', ids: ['p', 'q'], pos: { x: 100, y: 100 } },
    { net: 'SCL', ids: ['r', 's'], pos: { x: 900, y: 900 } },
  ];
  const after = [err('SCL', 'r', 's', 900, 900)];
  const r = reconcile(before, targets, after);
  check('actuallyFixed', r.actuallyFixed, 1);
  check('stillBroken', r.stillBroken, 1);
}

console.log('\n=== 情形 F：目标位置落在 30mil 容差边界外 → 视为已清（变远的不算同一处）===');
{
  const before = [err('GND', 'x', 'y', 1000, 1000)];
  const targets = [{ net: 'GND', ids: ['x', 'y'], pos: { x: 1000, y: 1000 } }];
  const after = [err('GND', 'z', 'w', 1300, 1000)]; // 距目标 300mil，远超 30mil 容差
  const r = reconcile(before, targets, after);
  check('actuallyFixed', r.actuallyFixed, 1);
  check('newConn', r.newConn, 1);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
