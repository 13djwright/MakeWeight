"""Put the showcase robot back to its screenshot state (original profiles, weigh-ins present, no stray lines)."""
import json, urllib.request, time
BASE="http://127.0.0.1:8790/api/"
def api(m,p,b=None):
    req=urllib.request.Request(BASE+p,data=json.dumps(b).encode() if b is not None else None,method=m); req.add_header("Content-Type","application/json"); req.add_header("X-Wake","1")
    return json.loads(urllib.request.urlopen(req,timeout=60).read() or b"null")
ids=json.load(open("ids.json")); P=ids["parts"]; st=api("GET","state"); PR={p["name"]:p["id"] for p in st["profiles"]}
orig={"chassis":"Chassis 5W/2T/4B/15%","upright":"Chassis 5W/2T/4B/15%","pod":"Light 2W/3T/3B/10%","inner":"Light 2W/3T/3B/10%","outer":"Chassis 5W/2T/4B/15%","disk":"Weapon solid 3W/100%"}
for k,v in orig.items(): api("PUT", f"parts/{P[k]['id']}", {"profile_id": PR[v], "force": True})
r=api("GET","robots/1")
for s in r["sections"]:
    for it in s["items"]:
        if it.get("part") and it["part"]["id"] in {P[k]["id"] for k in P}:
            api("PUT", f"items/{it['id']}", {"needs_reweigh": 0})
        if s["name"]=="Weapon" and it["description"].startswith("M3 × 12"): api("DELETE", f"items/{it['id']}")
time.sleep(3); print(api("GET","robots/1")["totals"])
