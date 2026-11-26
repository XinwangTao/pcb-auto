// 给 stitch 补线的日志加上 primitive id。
//
// 动机（测量缺口，不是功能缺陷）：
//   stitch 用 pcb_PrimitiveLine.create(net, layer, ...) 直接补一条 12mil 的线，
//   **完全不检查这条线会不会压到异网焊盘**。它是 `Clearance Error | SMD Pad to Track`
//   （全库 61 条，第二大类别）的一个可能来源，但是：
//   日志里只有 from/to 坐标，没有 primitive id ⇒ 事后拿到一条违规的 obj1（Track id）时，
//   无法回答"这条线是不是我自己补出来的"。于是"缝合是否制造间距违规"这个问题
//   从来没有被测量过，只能靠猜。
//   先记 id，再看有多少条违规命中它，然后才决定要不要加预检查。
//   —— 先测量，再设闸门。
//
// 同时给 stitchNoObj 补 from/to：create 返回 undefined（失败但不抛）时，
//   只知道"哪条网、差多少"，不知道"想画在哪"，等于无法复查。
const fs = require('fs');
const F = process.argv[2];
let s = fs.readFileSync(F, 'utf8');

function rep(name, from, to) {
  const n = s.split(from).length - 1;
  if (n === 0) { console.error('x 锚点缺失: ' + name); process.exit(3); }
  if (n > 1) { console.error('x 锚点不唯一(' + n + '): ' + name); process.exit(4); }
  s = s.replace(from, to);
  console.log('OK ' + name);
}

// 1) stitch 成功日志补 id
//    用单行字符串拼接，避免模板字面量把原始代码里的引号/反引号搅进来（已踩过一次）。
//    缩进是**实测**的（不是照抄）：L1 前导 10 空格，后续参数行前导 12 空格。
const from1 =
  "          log('stitch', { net, layer, gap: Math.round(otherD), islands: islands.length,\n" +
  "            from: [Math.round(myAnchor.x), Math.round(myAnchor.y)],\n" +
  "            to: [Math.round(other.x), Math.round(other.y)] });";
const to1 =
  "          log('stitch', { net, layer, gap: Math.round(otherD), islands: islands.length,\n" +
  "            // ★ 补线的 primitive id。没有它，事后拿到一条 `SMD Pad to Track` 违规时，\n" +
  "            //   无法判断那条 Track 是布线器画的还是本函数补的 —— 于是\n" +
  "            //   \"缝合有没有制造间距违规\" 这个问题从来没被测量过。\n" +
  "            id: String(mId),\n" +
  "            from: [Math.round(myAnchor.x), Math.round(myAnchor.y)],\n" +
  "            to: [Math.round(other.x), Math.round(other.y)] });";
rep('stitch 补 id', from1, to1);

// 2) stitchNoObj 补 from/to（实测前导 12 空格）
const from2 =
  "            log('stitchNoObj', { net, layer, gap: Math.round(otherD) });";
const to2 =
  "            log('stitchNoObj', { net, layer, gap: Math.round(otherD),\n" +
  "              // create 失败时 resolve(undefined) 而不抛。只知道\"差多少\"、\n" +
  "              // 不知道\"想画在哪\"，等于无法复查这一段为什么没成。\n" +
  "              from: [Math.round(myAnchor.x), Math.round(myAnchor.y)],\n" +
  "              to: [Math.round(other.x), Math.round(other.y)] });";
rep('stitchNoObj 补坐标', from2, to2);

fs.writeFileSync(F, s, 'utf8');
console.log('  ' + fs.statSync(F).size + ' B');
