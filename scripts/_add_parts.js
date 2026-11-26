const fs=require('fs');
const p='designs/_catalog.json';
const c=JSON.parse(fs.readFileSync(p,'utf8'));
const add=[
 {lcsc:'C16581',name:'TP4056-42-ESOP8',class:'Basic Part',trusted:true,designator:'U',
  role:'锂电池充电管理 IC',package:'ESOP-8',
  tags:['charger','battery','lipo','li-ion','充电','锂电','电池','充电管理','tp4056','power'],
  pins:{TEMP:'1',PROG:'2',GND:'3',VCC:'4',BAT:'5',STDBY:'6',CHRG:'7',CE:'8',EP:'9'},
  netHints:'VCC=5V 输入，BAT 接电池，PROG 接 1.2k 定 1A 充电电流，CE 接 VCC 使能，CHRG#/STDBY# 接状态灯'},
 {lcsc:'C5248080',name:'HS96L03W2C03',class:'Extended Part',trusted:true,designator:'DS',
  role:'0.96 寸 OLED 显示屏 (I2C)',package:'4P 排针模组',
  tags:['oled','display','screen','ssd1306','ssd1315','i2c','显示','屏幕','显示屏'],
  pins:{GND:'1',VCC:'2',SCL:'3',SDA:'4'},
  netHints:'I2C 显示，VCC 3V3，SCL/SDA 与主控同总线，需上拉'},
 {lcsc:'C191023',name:'1N5819WS',class:'Basic Part',trusted:true,designator:'D',
  role:'肖特基二极管 40V/1A',package:'SOD-323',
  tags:['diode','schottky','rectifier','二极管','肖特基','整流','防反接'],
  pins:{K:'1',A:'2'},
  netHints:'太阳能板防反接串在输入，或作续流二极管'},
 {lcsc:'C131337',name:'B2B-PH-K-S(LF)(SN)',class:'Basic Part',trusted:true,designator:'H',
  role:'锂电池接口 2P 2.0mm',package:'PH-2P',
  tags:['battery','connector','battery-holder','电池','电池座','锂电接口','连接器'],
  pins:{'1':'1','2':'2'},
  netHints:'1=电池正，2=电池负（GND）'},
];
for(const a of add){
  if(c.parts.some(x=>x.lcsc===a.lcsc)) { console.log('skip '+a.lcsc); continue; }
  c.parts.push(a); console.log('add  '+a.lcsc+' '+a.name);
}
fs.writeFileSync(p, JSON.stringify(c,null,2)+'\n','utf8');
console.log('total parts = '+c.parts.length);
