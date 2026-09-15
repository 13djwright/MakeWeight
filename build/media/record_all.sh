#!/bin/bash
# Re-record every GIF from a clean demo state. Usage: ./record_all.sh [tour|lib|mesh|opt ...]
set -e -o pipefail
export NODE_PATH=/opt/node-tools/node_modules
OUT=/home/claude/sb/docs/media
fix() { python3 - "$1" <<'PY'
import re,sys; d=sys.argv[1]; s=open(d+'/list.txt').read(); open(d+'/list.txt','w').write(re.sub(r"file '([^']*/)?", "file '", s))
PY
}
rec() { # name route out
  node rig.js rec "$2" "video/$1.gif" "$(cat gif_$1.json)" | grep -i "frames\|errors"; fix "video/${1}_frames"; ./mkgif.sh "video/${1}_frames" "$OUT/$3" 1100; }
reset_chassis() { python3 - <<'PY'
import sqlite3
c=sqlite3.connect('/tmp/show/data/makeweight.db')
rows=c.execute("select id, mesh_id from part_mesh_history where part_id=1 order by id").fetchall(); first=rows[0]
c.execute("delete from part_mesh_history where part_id=1 and id>?", (first[0],)); c.execute("update printed_parts set mesh_id=? where id=1", (first[1],)); c.commit()
PY
curl -s -m 10 -X PUT localhost:8790/api/parts/1 -H 'Content-Type: application/json' -H 'X-Wake: 1' -d '{"notes":null}' >/dev/null; }
for n in ${@:-tour lib mesh opt}; do
  case $n in
    tour) rec tour '#/' tour.gif ;;
    lib)  rec lib '#/sheet' library-typeahead.gif
          python3 - <<'PY'
import json, urllib.request
BASE="http://127.0.0.1:8790/api/"
def api(m,p,b=None):
    req=urllib.request.Request(BASE+p,data=json.dumps(b).encode() if b is not None else None,method=m); req.add_header("Content-Type","application/json"); req.add_header("X-Wake","1")
    return json.loads(urllib.request.urlopen(req,timeout=60).read() or b"null")
for s in api("GET","robots/1")["sections"]:
    if s["name"]=="Weapon":
        for it in s["items"]:
            if it["description"].startswith("M3 × 12"): api("DELETE", f"items/{it['id']}")
PY
          ;;
    mesh) rec mesh '#/parts' mesh-history.gif; reset_chassis ;;
    opt)  rec opt '#/optimizer/2' optimizer.gif ;;   # leaves the plan applied — run reset_demo.py afterwards if needed
  esac
done
