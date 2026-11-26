# -*- coding: utf-8 -*-
"""修 idea2design.js 的「否定被读成肯定」回归 + 两条同义词补漏 + 降压条目语义收窄。

证据：独立复核（out/_probe/_idea-patch-review.md）实测 20 个候选句，
10 例假拒绝（旧版 0 → 我的补丁 1），其中 9 例同一根因：
「不要 LDO，也不要电感」「不用运放」「不需要升压」「不要数码管也不要光耦」
「no op-amp」「no MOSFET needed」「不用麦克风」「不用比较器」
——都是在**排除**该器件，正则却当成点名。
第 10 例是语义：AMS1117 本身就是降压（线性），`降压` 不该被拒。

只写 .cand，不装盘。
"""
import io, os, sys

ROOT = r"D:\Users\陶鑫旺\Documents\deepseek-harness\default-workspace\pcb-auto"
SRC = os.path.join(ROOT, "scripts", "idea2design.js")
cand = sys.argv[1] if len(sys.argv) > 1 else SRC + ".cand"

raw = io.open(SRC, "rb").read()
crlf = b"\r\n" in raw
text = raw.decode("utf-8")
if crlf:
    text = text.replace("\r\n", "\n")

# ---------- 1. 语义收窄：LDO 不是「需要开关降压」 ----------
A = "  { re: /降压|step-?down/i,                              need: '降压变换' },\n"
B = ("  // LDO/AMS1117 本身就是降压（线性），不该拒；只有开关型才需要目录里没有的器件。\n"
     "  { re: /开关降压|\\bbuck\\b|开关电源|开关稳压|switching\\s+(regulator|converter|step-?down)/i, need: '开关降压变换' },\n")
assert text.count(A) == 1, "降压条目命中 %d 次" % text.count(A)
text = text.replace(A, B)

# ---------- 2. 同义词补漏（复核者实测 exit 0 却无该器件的两个中文本名） ----------
A = "  { re: /光敏|光耦|optocoupler|photodiode|\\bldr\\b/i,      need: '光敏电阻/光耦' },\n"
B = "  { re: /光敏|光耦|光电耦合|optocoupler|photodiode|\\bldr\\b/i, need: '光敏电阻/光耦' },\n"
assert text.count(A) == 1, "光耦条目命中 %d 次" % text.count(A)
text = text.replace(A, B)

A = "  { re: /陀螺|加速度计|mpu-?6050|\\bimu\\b/i,               need: 'IMU' },\n"
B = "  { re: /陀螺|加速度计|姿态传感|六轴|九轴|mpu-?6050|\\bimu\\b/i, need: 'IMU' },\n"
assert text.count(A) == 1, "IMU 条目命中 %d 次" % text.count(A)
text = text.replace(A, B)

A = "  { re: /霍尔|\\bhall\\b/i,                               need: '霍尔传感器' },\n"
B = "  { re: /霍尔|磁场传感|\\bhall\\b/i,                        need: '霍尔传感器' },\n"
assert text.count(A) == 1, "霍尔条目命中 %d 次" % text.count(A)
text = text.replace(A, B)

# ---------- 3. 否定剥离（本次回归的正解） ----------
A = """function auditUnsupported(idea, picked) {
  const out = [];
  for (const u of UNSUPPORTED) {
    if (!u.re.test(idea)) continue;
"""
B = """// 「不要 X / 不用 X / 不需要 X / no X」是在**排除**该器件，不是在点名它。
// 实测：不区分否定会把「不要 LDO，也不要电感」这种正确需求拒掉（10 例假拒绝里 9 例是这条）。
// 做法：把「否定词 + 紧随的短语」整段挖掉，再拿剩下的文本去匹配功能词。
// 只挖紧邻短语（≤10 字 / ≤16 英文字符），不整句删除，避免一个「不」把整句需求抹掉。
const NEG_CN = /(不需要|不用|不要|无需|无须|不含|没有)\\s*([^\\s，,。；;、:：()（）]{1,10})/g;
const NEG_EN = /\\b(?:no|not|without|free-of)\\s+([A-Za-z0-9\\-+.]{2,16})/gi;
function stripNegated(idea) {
  return String(idea || '').replace(NEG_CN, ' ').replace(NEG_EN, ' ');
}

function auditUnsupported(idea, picked) {
  const out = [];
  const eff = stripNegated(idea);
  for (const u of UNSUPPORTED) {
    if (!u.re.test(eff)) continue;
"""
assert text.count(A) == 1, "auditUnsupported 命中 %d 次" % text.count(A)
text = text.replace(A, B)

out = text.replace("\n", "\r\n") if crlf else text
io.open(cand, "wb").write(out.encode("utf-8"))
print("  写出 %s  %d B（原 %d B，%+d）" % (cand, len(out.encode("utf-8")), len(raw),
      len(out.encode("utf-8")) - len(raw)))
print("  换行 %s / BOM %s" % ("CRLF" if crlf else "LF", "有" if raw[:3] == b"\xef\xbb\xbf" else "无"))
