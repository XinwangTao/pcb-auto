# 从 Board.pdf 提取页面图给视频用。d6 是新板子（16 器件双面板），需重出。
# 输出：video/public/board/pageN.png（缩略）+ hi_pageN.png（高清关键页）
import sys, os, glob
import fitz

pdf = sys.argv[1]
outdir = sys.argv[2]
os.makedirs(outdir, exist_ok=True)

# 清掉旧图，避免 d3 的残图混入
for f in glob.glob(os.path.join(outdir, '*.png')):
    os.remove(f)

doc = fitz.open(pdf)
print('页数:', doc.page_count)
for i, page in enumerate(doc):
    # 缩略图：宽 900
    r = page.rect
    zoom = 900.0 / r.width
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
    p1 = os.path.join(outdir, 'page%d.png' % i)
    pix.save(p1)
    # 高清：宽 2200（仅前 4 页，控制体积）
    if i < 4:
        zoom2 = 2200.0 / r.width
        pix2 = page.get_pixmap(matrix=fitz.Matrix(zoom2, zoom2))
        p2 = os.path.join(outdir, 'hi_page%d.png' % i)
        pix2.save(p2)
        print('  page%d  缩略 %dx%d  %.1fKB | 高清 %dx%d  %.1fKB' % (
            i, pix.width, pix.height, os.path.getsize(p1) / 1024,
            pix2.width, pix2.height, os.path.getsize(p2) / 1024))
    else:
        print('  page%d  缩略 %dx%d  %.1fKB' % (i, pix.width, pix.height, os.path.getsize(p1) / 1024))
doc.close()
print('完成 ->', outdir)
