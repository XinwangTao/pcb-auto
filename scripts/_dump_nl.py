import json,sys
j=json.load(open(sys.argv[1],encoding="utf-8"))
for uid,c in j["components"].items():
    props=c.get("props",{})
    des=props.get("Designator")
    lcsc=props.get("Supplier Part")
    print("--- %s (%s) ---" % (des,lcsc))
    for k,pi in sorted((c.get("pinInfoMap") or {}).items(), key=lambda x: str(x[1].get("number"))):
        print("   pin %s %s -> %s" % (pi.get("number"), pi.get("name"), pi.get("net")))
