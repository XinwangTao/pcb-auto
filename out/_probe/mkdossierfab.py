# -*- coding: utf-8 -*-
"""给 make-dossier.py 加一节「能不能直接下单」+ 给 ③ 层加已知缺陷注记。

只写 .cand。
"""
import io
import os

ROOT = r"D:\Users\陶鑫旺\Documents\deepseek-harness\default-workspace\pcb-auto"
SRC = os.path.join(ROOT, "out", "_probe", "make-dossier.py")
cand = SRC + ".cand"

raw = io.open(SRC, "rb").read()
crlf = b"\r\n" in raw
text = raw.decode("utf-8")
if crlf:
    text = text.replace("\r\n", "\n")

# ---- 1) 加读取函数 ----
A1 = "def load_idea_sources():"
B1 = '''def load_fab_census():
    p = os.path.join(ROOT, "out", "_probe", "fab-census.json")
    if not os.path.exists(p):
        return None
    try:
        return readjson(p)
    except Exception:
        return None


def load_idea_sources():'''
assert text.count(A1) == 1, "A1 命中 %d" % text.count(A1)
text = text.replace(A1, B1)

# ---- 2) 给 ③ 层加已知缺陷注记（交付页必须自己说清哪一层不可信）----
A2 = '''<tr><td>\u2462 \u72ec\u7acb\u9a8c\u6536</td><td>\u4e0d\u91c7\u4fe1\u81ea\u8ff0\uff0c\u91cd\u7b97\u4ea7\u7269\u5e76\u9010\u9879 PASS/FAIL</td>
    <td><code>accept.ps1</code></td></tr>'''
B2 = '''<tr><td>\u2462 \u72ec\u7acb\u9a8c\u6536</td><td>\u4e0d\u91c7\u4fe1\u81ea\u8ff0\uff0c\u91cd\u7b97\u4ea7\u7269\u5e76\u9010\u9879 PASS/FAIL\u3002
    <b>\u5df2\u77e5\u7f3a\u9677</b>\uff1a\u5b83\u53ea\u68c0\u67e5\u300c\u5df2\u51fa\u73b0\u7684\u300d\u5224\u636e\uff0c\u7f3a\u5931\u7684\u5224\u636e\u7b49\u4e8e\u901a\u8fc7\uff0c
    \u6240\u4ee5<b>\u672c\u9875\u7ed3\u8bba\u4e0d\u4f9d\u8d56\u5b83</b></td>
    <td><code>accept.ps1</code></td></tr>'''
assert text.count(A2) == 1, "A2 命中 %d" % text.count(A2)
text = text.replace(A2, B2)

# ---- 3) 插入 DFM 普查一节 ----
A3 = "    # \u8bbe\u8ba1\u6e05\u5355\n"
B3 = '''    # \u80fd\u4e0d\u80fd\u76f4\u63a5\u4e0b\u5355
    fab = load_fab_census()
    H.append("<\u00682>\u80fd\u4e0d\u80fd\u76f4\u63a5\u62ff\u53bb\u4e0b\u5355\uff1a\u79bb\u7ebf DFM \u666e\u67e5</h2>")
    if fab:
        a = fab["all"]
        t = fab["self_ok_true"]
        H.append('<p class="sub">\u7528 <code>scripts/fabcheck.js</code> \u5bf9<b>\u5168\u90e8 %d \u4e2a\u4ea7\u7269\u76ee\u5f55</b>'
                 '\u9010\u4e2a\u590d\u7b97\uff08\u7eaf\u79bb\u7ebf\uff1a\u81ea\u5df1\u89e3 ZIP\u3001\u8bfb Gerber\u3001\u8bfb Excellon\uff0c'
                 '\u4e0d\u8054\u7f51\u4e5f\u4e0d\u5f00 EDA\uff09\u3002\u5b83\u6b64\u524d\u6ca1\u6709\u63a5\u8fdb\u6d41\u6c34\u7ebf\u95f8\u95e8\uff0c'
                 '\u6240\u4ee5\u8fd9\u4e00\u5c42\u662f<b>\u4e8b\u540e\u72ec\u7acb\u666e\u67e5</b>\uff0c\u4e0d\u662f\u6d41\u6c34\u7ebf\u7684\u81ea\u8ff0\u3002</p>'
                 % a["n"])
        H.append('<div class="row">')
        H.append('<div><div class="lbl">\u81ea\u8ff0 ok=true</div><div class="big">%d</div></div>' % t["n"])
        H.append('<div><div class="lbl">\u5176\u4e2d\u53ef\u6253\u6837</div><div class="big">%d</div></div>' % t["fab_ok"])
        H.append('<div><div class="lbl">\u6bd4\u4f8b</div><div class="big">%.1f%%</div></div>'
                 % (100.0 * t["fab_ok"] / t["n"] if t["n"] else 0))
        H.append('<div><div class="lbl">\u6709\u963b\u65ad</div><div class="big">%d</div></div>' % t["fab_blocked"])
        H.append('</div>')
        H.append('<table><tr><th>\u6279\u6b21</th><th class="num">\u81ea\u8ff0 ok=true</th>'
                 '<th class="num">\u53ef\u6253\u6837</th><th class="num">\u6bd4\u4f8b</th></tr>')
        for k, v in fab["by_batch"].items():
            s = v["self_ok_true"]
            if not s["n"]:
                continue
            pct = 100.0 * s["fab_ok"] / s["n"]
            cls = "ok" if s["fab_ok"] == s["n"] else "bad"
            H.append('<tr><td>%s</td><td class="num">%d</td><td class="num %s">%d</td>'
                     '<td class="num %s">%.1f%%</td></tr>'
                     % (e(k if k != "\uff08\u65e0\uff09" else "\u65e7\u76ee\u5f55\uff08\u65e0\u65e5\u671f\uff09"),
                        s["n"], cls, s["fab_ok"], cls, pct))
        H.append('</table>')
        bl = fab.get("blocker_ids") or {}
        if bl:
            H.append('<p class="sub">\u963b\u65ad\u7c7b\u578b\uff1a' + "\u3001".join(
                '<code>%s</code>\u00d7%d' % (e(k), v) for k, v in bl.items()) + '\u3002</p>')
        bad = fab.get("blocked_but_self_ok") or []
        if bad:
            H.append('<p class="sub">\u81ea\u8ff0\u901a\u8fc7\u4f46\u4e0d\u80fd\u4e0b\u5355\u7684\u76ee\u5f55\uff08\u5168\u90e8\u6765\u81ea\u65e9\u671f\u6279\u6b21\uff09\uff1a</p>')
            H.append('<table><tr><th>\u76ee\u5f55</th><th>\u963b\u65ad\u539f\u56e0</th></tr>')
            for b in bad:
                H.append('<tr><td><code>%s</code></td><td>%s</td></tr>'
                         % (e(b["dir"]),
                            e("\uff1b".join(x.get("msg") or x.get("id") or "?" for x in b["blockers"]))))
            H.append('</table>')
        H.append('<p class="sub">\u666e\u67e5\u539f\u59cb\u6570\u636e <code>out/_probe/fab-census.json</code>\uff0c'
                 '\u53ef\u7528 <code>python out/_probe/fab-census.py</code> \u91cd\u7b97\uff08217 \u76ee\u5f55\u7ea6 21 \u79d2\uff09\u3002</p>')
    else:
        H.append("<p>\u672a\u627e\u5230 <code>out/_probe/fab-census.json</code>\u3002</p>")

    # \u8bbe\u8ba1\u6e05\u5355
'''
assert text.count(A3) == 1, "A3 命中 %d" % text.count(A3)
text = text.replace(A3, B3)

out = text.replace("\n", "\r\n") if crlf else text
io.open(cand, "wb").write(out.encode("utf-8"))
print("  \u5199\u51fa %s  %d B\uff08\u539f %d B\uff0c%+d\uff09\u6362\u884c=%s"
      % (cand, len(out.encode("utf-8")), len(raw),
         len(out.encode("utf-8")) - len(raw), "CRLF" if crlf else "LF"))
