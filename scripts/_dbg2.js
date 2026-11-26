const fs=require('fs');
const P=process.argv[2];
const s=fs.readFileSync(P,'utf8');
const oldP5=`        } catch (e4) {
          for (const id of madeHere.reverse()) {
            try { await eda.pcb_PrimitiveLine.delete(id); } catch (e5) { }
          }
          try { await eda.pcb_PrimitiveLine.modify(trackId, { endX: ex, endY: ey }); } catch (e6) { }
          log('trackDoglegRolledBack', { line: trackId, net,
            made: madeHere.length, m: String(e4 && e4.message).slice(0, 100) });
          continue;
        }`;
console.log('  P5 OLD 长度: '+oldP5.length);
console.log('  P5 命中: '+(s.split(oldP5).length-1));
const newP5 = oldP5.replace("log('trackDoglegRolledBack', { line: trackId, net,", "log('trackDoglegFixFail', { line: trackId, net,");
console.log('  newP5 是否含旧键: '+newP5.includes('trackDoglegRolledBack'));
const s2 = s.replace(oldP5, newP5);
console.log('  替换后 旧键次数: '+(s2.split('trackDoglegRolledBack').length-1));
console.log('  替换后 新键次数: '+(s2.split('trackDoglegFixFail').length-1));
console.log('  长度变化: '+s.length+' -> '+s2.length);