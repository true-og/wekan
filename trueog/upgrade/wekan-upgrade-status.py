"""Reads WeKan's /schema-upgrade-status?json on stdin. Usage: wekan-upgrade-status.py <version, e.g. 13.06>
Exit 0: the upgrade steps of that version ran and finished clean; 1: not finished yet (or no answer); 2: not clean."""
import json, sys
try:
    s = json.load(sys.stdin)
except Exception:
    sys.exit(1)
if s.get("running") or not s.get("finishedAt"):
    sys.exit(1)
want = "v" + sys.argv[1] + ".0"
steps = s.get("steps") or {}
for name, st in steps.items():
    line = "  upgrade step {}: {}, fixed {}, unresolved {}".format(name, st.get("status"), st.get("fixed", 0), st.get("unresolved", 0))
    if st.get("error"):
        line += ", error " + str(st.get("error"))
    print(line)
last = (s.get("lastCheck") or {}).get("version")
print("  version {}, finished {}, gated {}, clean re-check recorded for {}".format(s.get("appVersion"), s.get("finishedAt"), s.get("gated"), last))
problems = []
if s.get("appVersion") != want:
    problems.append("version is {}, expected {}".format(s.get("appVersion"), want))
if s.get("gated"):
    problems.append("the upgrade steps were skipped (gated), not run")
if any(st.get("status") == "error" for st in steps.values()):
    problems.append("a step failed")
if any(st.get("unresolved") for st in steps.values()):
    problems.append("a step left unresolved items")
if last != want:
    problems.append("no clean re-check was recorded for " + want)
if problems:
    print("  NOT CLEAN: " + "; ".join(problems))
    sys.exit(2)
sys.exit(0)
