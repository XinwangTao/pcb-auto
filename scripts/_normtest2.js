// 新归一化：µ->u、R/K/M/N/P 作小数点占位、裸前缀补 F、除尾 R
const norm = (s) => {
  let t = String(s).replace(/µ/g, 'u').toUpperCase().replace(/Ω|OHM/g, '').replace(/\s+/g, '');
  const m = t.match(/^(\d+)([RKMNPV])(\d+)(.*)$/);
  if (m) t = m[1] + '.' + m[3] + m[2] + m[4];
  t = t.replace(/R$/, '');
  t = t.replace(/^(\d+(?:\.\d+)?)([NPU])$/, '$1$2F');
  return t;
};
const NOM = /^\d+(\.\d+)?(M|K|U|N|P|F|H|MF|UF|NF|PF|MH|UH)?$/;
const cases = [
  ['1k','1kΩ',false], ['5.1k','5.1kΩ',false], ['10uF','10µF',false], ['1uF','1µF',false],
  ['1k2','1.2kΩ',false], ['4R7','4.7Ω',false], ['2n2','2.2nF',false], ['1R','1Ω',false],
  ['100nF','100nF',false], ['4.7k','4.7kΩ',false], ['10uH','10µH',false],
  ['1k','5.1k',true], ['10uF','1uF',true], ['1.2k','1k',true], ['100nF','10nF',true],
];
let bad = 0;
console.log('  declared -> actual            norm(a)   norm(b)   触发   期望   判定');
for (const [a, b, want] of cases) {
  const na = norm(a), nb = norm(b);
  const fire = NOM.test(na) && NOM.test(nb) && na !== nb;
  const ok = fire === want;
  if (!ok) bad++;
  console.log('  ' + (a + ' -> ' + b).padEnd(28) + na.padEnd(9) + nb.padEnd(10) +
    String(fire).padEnd(6) + String(want).padEnd(6) + (ok ? 'OK' : '*** 不符'));
}
console.log('  ' + (bad === 0 ? '全部通过（15/15）' : '有 ' + bad + ' 条不符合预期'));
