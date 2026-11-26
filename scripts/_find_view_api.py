import csv
import re

rows = list(csv.DictReader(open('api/methods.csv', encoding='utf-8')))
pat = re.compile(r'zoom|fit|frame|viewport|scroll|center|focus|select|highlight', re.I)
seen = set()
for r in rows:
    m = r['method']
    if pat.search(m) and m not in seen:
        seen.add(m)
        print('%-30s %s.%s' % (r['class'], r['callPath'], m))
