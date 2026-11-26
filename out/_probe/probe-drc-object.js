// 探测 DRC 里那个「几何读不到」的对象到底是什么。
// 目标：pcb_Primitive.getPrimitiveTypeByPrimitiveId / getPrimitiveByPrimitiveId 都是 @alpha，
// help 查不到签名 —— 本文件就是为了用实际调用把签名和返回值形状问出来。
// 约束：绝不对可能不 settle 的 Promise 做无超时 await（getPrimitiveBoardLine 有前科）。

const OUT = { tried: [], hit: null, byType: {} };
const T = (p, ms, tag) => Promise.race([
  Promise.resolve(p).then(v => ({ tag, ok: true, v }), e => ({ tag, ok: false, e: String(e && e.message).slice(0, 200) })),
  new Promise(r => setTimeout(() => r({ tag, ok: false, e: 'TIMEOUT ' + ms }), ms)),
]);

const IDS = [
  '2c5c43decd6f36f0e37',   // 本轮 slotGeoCmp / uniGeo 报的 child id
  '2c5c43decd6f36f0',      // 它报的 parentId
  '4e0fd676c06a1f29e37',   // 上一轮 DRC 里那 3 条 Slot Region to Track 的对象
  '4e0fd676c06a1f29',
];

const brief = (x, depth) => {
  if (x === null || x === undefined) return x;
  if (typeof x !== 'object') return x;
  if (Array.isArray(x)) return x.length > 6 ? x.slice(0, 6).concat(['…+' + (x.length - 6)]) : x.map(v => brief(v, depth + 1));
  if (depth > 2) return '[obj]';
  const o = {};
  for (const k of Object.keys(x)) {
    const v = x[k];
    o[k] = (typeof v === 'function') ? '[fn]' : brief(v, depth + 1);
  }
  return o;
};

for (const id of IDS) {
  const r1 = await T(eda.pcb_Primitive.getPrimitiveTypeByPrimitiveId(id), 15000, 'type:' + id);
  OUT.tried.push({ id, method: 'getPrimitiveTypeByPrimitiveId', ok: r1.ok, res: brief(r1.ok ? r1.v : r1.e, 0) });
  if (r1.ok && r1.v !== undefined && r1.v !== null) OUT.byType[id] = r1.v;

  const r2 = await T(eda.pcb_Primitive.getPrimitiveByPrimitiveId(id), 15000, 'byId:' + id);
  OUT.tried.push({ id, method: 'getPrimitiveByPrimitiveId', ok: r2.ok, res: brief(r2.ok ? r2.v : r2.e, 0) });
  if (r2.ok && r2.v) OUT.hit = { id, value: brief(r2.v, 0) };
}

// 同一族里的 plurals：给数组是不是另一条路？
const r3 = await T(eda.pcb_Primitive.getPrimitivesByPrimitiveId(IDS), 15000, 'plural');
OUT.tried.push({ method: 'getPrimitivesByPrimitiveId', ok: r3.ok, res: brief(r3.ok ? r3.v : r3.e, 1) });

// BBox 查询：能拿到盒子就至少知道它在哪一层、多大
const r4 = await T(eda.pcb_Primitive.getPrimitivesBBox(IDS), 15000, 'bbox');
OUT.tried.push({ method: 'getPrimitivesBBox', ok: r4.ok, res: brief(r4.ok ? r4.v : r4.e, 1) });

// 板框线：它是「区域」的话这条应该能拿到轮廓（带超时）
const r5 = await T(eda.pcb_Primitive.getPrimitiveBoardLine(IDS[0]), 15000, 'boardline');
OUT.tried.push({ method: 'getPrimitiveBoardLine', ok: r5.ok, res: brief(r5.ok ? r5.v : r5.e, 1) });

// 枚举取值表：EPCB_PrimitiveType，把类型数字翻成名字
OUT.tried.push({
  method: 'EPCB_PrimitiveType',
  ok: true,
  res: brief(eda.EPCB_PrimitiveType, 1),
});

return OUT;
