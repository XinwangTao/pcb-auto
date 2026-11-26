const norm = (s) => String(s).toUpperCase().replace(/Ω|OHM|R\b/g, '').replace(/\s+/g, '');
const NOM = /^[\d.]+\s*[KM]?\s*(F|UF|NF|PF|H|MH|UH)?$/i;
const cases = [
  ['1k','1kΩ'], ['5.1k','5.1kΩ'], ['100nF','100nF'], ['10uF','10uF'],
  ['4R7','4.7Ω'], ['1R','1Ω'], ['1k2','1.2kΩ'], ['4.7k','4.7kΩ'],
  ['1k','5.1k'], ['10uF','1uF'], ['LED-Green','KT-0805G'], ['1.2k','1k'],
];
console.log('  declared -> actual      norm(a)   norm(b)   NOM(a) NOM(b)  触发告警?');
for (const [a, b] of cases) {
  const na = norm(a), nb = norm(b);
  const fire = NOM.test(na) && NOM.test(nb) && na !== nb;
  const verdict = fire ? (na === nb ? '?(同值不同串)' : '告警') : '不告警';
  console.log('  ' + (a + ' -> ' + b).padEnd(24) + na.padEnd(9) + nb.padEnd(9) +
    String(NOM.test(na)).padEnd(7) + String(NOM.test(nb)).padEnd(10) + verdict);
}
