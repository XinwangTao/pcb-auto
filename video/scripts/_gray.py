import sys
W,H = 240,427
n = W*H
data = open(r'out\gray.raw','rb').read()
frames = len(data)//n
print("frames:", frames)
blank = []
for i in range(frames):
    f = data[i*n:(i+1)*n]
    mean = sum(f)/n
    var = sum((b-mean)**2 for b in f)/n
    sd = var**0.5
    if sd < 19:
        blank.append((i, round(sd,1)))
print("blank frames (sd<19):", len(blank))
for i,sd in blank: print("  t=%ds sd=%s" % (i, sd))
