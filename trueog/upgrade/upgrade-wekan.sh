#!/bin/sh
# WeKan upgrade in steps (operator, 2026-11-10: "13.06 is the latest. update in steps if you have to for my data
# to be safe"): 11.87 -> 11.99 -> 12.99 -> 13.06, one step per run, each backed up, rehearsed and verified.
#   doas sh /home/system/gitea-upgrade/upgrade-wekan.sh check                 read-only: where things stand
#   doas sh /home/system/gitea-upgrade/upgrade-wekan.sh step <version>        the next step only
#   doas sh /home/system/gitea-upgrade/upgrade-wekan.sh restore <backup dir>  put a step's backup back (data and release)
# Complete output and UPGRADE_WEKAN_EXIT=<status> go to logs/upgrade-wekan-<phase>-<time>.log.
#
# A step:
#   1. checks that <version> is the next one, its zip matches the pinned sha256, Node 26 exists, WeKan answers
#   2. STOPS WeKan, so the backup is one consistent moment
#   3. snapshots the database (every collection's count, the _ids of documents that must survive) and backs up into
#      /opt/wekan/backups/pre-<version>-<time>: a mongodump of the whole `wekan` database, a pg_dump of PostgreSQL's
#      ferretdb database (read back in full), /opt/wekan/data, wekan.env and /etc/conf.d/wekan
#   4. rehearses the restore: the mongodump is restored into a scratch database and compared with the snapshot,
#      then the scratch database is dropped
#   5. unpacks and checks the release; for 13.06 also applies TrueOG's setBoardTeams patch (app.js.orig-13.06 kept)
#   6. points /etc/conf.d/wekan at Node 26 and /opt/wekan/current at the release, and starts it; from this moment the
#      new release may change the data (its one-time upgrade steps)
#   7. waits for /schema-upgrade-status?json to report the upgrade steps finished with no error (up to 30 minutes)
#   7b. requires that report to be for <version>, with no failed step, nothing unresolved, a clean re-check recorded
#   8. verifies: no user, board, card, swimlane, custom field, comment, checklist, attachment, team, org or setting
#      is gone; no more broken references (card->board/list/swimlane, list/swimlane->board, comment/checklist->card,
#      checklist item->checklist) than before; lists may only vanish by 13.06's duplicate-list merge
# Any failure BEFORE step 6 starts the old release again unchanged. A failure AFTER it stops WeKan and leaves it
# stopped: the old release must not run on data the new one already changed. Then run `restore <backup dir>`
# (the command is printed), which checks the backup's files, drops the database, restores it, puts files, conf.d
# and the previous release back and verifies every collection's count and the surviving kinds' _ids exactly.
SRC=/home/system/gitea-upgrade
[ "$(id -u)" = 0 ] || { echo "run as root: doas sh $0 check|step <version>|restore <backup dir>" >&2; exit 1; }
phase=${1:-}; arg=${2:-}
case "$phase" in
	check) [ "$#" = 1 ] || { echo "usage: $0 check" >&2; exit 2; } ;;
	step|restore) [ "$#" = 2 ] || { echo "usage: $0 $phase <$( [ "$phase" = step ] && echo version || echo 'backup dir')>" >&2; exit 2; } ;;
	*) echo "usage: doas sh $0 check|step <version>|restore <backup dir>" >&2; exit 2 ;;
esac
if [ -z "${UPGRADE_WEKAN_LOGGED:-}" ]; then
	mkdir -p "$SRC/logs"
	LOG=$SRC/logs/upgrade-wekan-$phase-$(basename "${arg:-x}")-$(date +%F_%H-%M-%S).log
	: > "$LOG"; chmod 644 "$LOG"; chown system:system "$LOG"
	echo "started $(date -Is): sh $0 $*" >> "$LOG"
	UPGRADE_WEKAN_LOGGED=1 sh "$0" "$@" >> "$LOG" 2>&1
	rc=$?
	echo "finished $(date -Is)" >> "$LOG"
	echo "UPGRADE_WEKAN_EXIT=$rc" >> "$LOG"
	cat "$LOG"
	exit "$rc"
fi
set -eu
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
W=/opt/wekan
INCOMING=$W/incoming
CONFD=/etc/conf.d/wekan
PIDFILE=/run/wekan/wekan.pid
NODE26=/home/system/.nvm/versions/node/v26.13.0/bin/node
STEPS="11.87 11.99 12.99 13.06"
REHEARSAL_DB=wekan_restore_rehearsal
sha_for() {
	case "$1" in
		11.99) echo 9176473ac61a8abc63224c3aa202729bec583c493ad2458964f085c62ced35f4 ;;
		12.99) echo 76468004391d4e643631691f20f786131753f41578885dc93a52accf7480cb0c ;;
		13.06) echo 83873c53362d47160e3fb9a7623460647800af6a799d7e9faae5fb3f19ef4836 ;;
		*) return 1 ;;
	esac
}
commit_for() {
	case "$1" in
		11.99) echo e09307cda128 ;;
		12.99) echo 1f12b20291dc ;;
		13.06) echo 77239ee100aa ;;
		*) return 1 ;;
	esac
}
as_system() { runuser -u system -- "$@"; }
current_version() { basename "$(readlink "$W/current")"; }
next_after() { echo "$STEPS" | tr ' ' '\n' | awk -v c="$1" 'f { print; exit } $0 == c { f = 1 }'; }
answering() { [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:3001/)" = 200 ]; }
db() {  # db <bundle dir> <wekan-db.js arguments...>: as system, with wekan.env loaded, the URI never in argv
	b=$1; shift
	as_system /bin/sh -c 'set -a; . /opt/wekan/wekan.env; set +a; exec "$0" "$@"' "$NODE26" "$SRC/wekan-db.js" "$b" "$@"
}
wekan_pids() {  # every running WeKan server process (node <...>/bundle/main.js run as system)
	for p in $(pgrep -u system -f 'bundle/main\.js' || true); do
		case "$(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null)" in */bin/node\ current/bundle/main.js*) echo "$p" ;; esac
	done
}
stop_wekan() {
	rc-service wekan stop >/dev/null 2>&1 || true
	n=0
	while [ -n "$(wekan_pids)" ]; do
		if [ "$n" -eq 30 ]; then for p in $(wekan_pids); do kill -TERM "$p" 2>/dev/null || true; done; fi
		if [ "$n" -eq 45 ]; then for p in $(wekan_pids); do kill -KILL "$p" 2>/dev/null || true; done; fi
		[ "$n" -lt 60 ] || { echo "WeKan did not stop" >&2; return 1; }
		sleep 1; n=$((n + 1))
	done
	rm -f "$PIDFILE"
	rc-service wekan zap >/dev/null 2>&1 || true
}
start_wekan() { rc-service wekan start; }
set_node() {  # set_node <path>: change only node= in /etc/conf.d/wekan, keep anything else
	tmp=$(mktemp "$CONFD.XXXXXX")
	{ [ ! -e "$CONFD" ] || sed '/^node=/d' "$CONFD"; printf 'node="%s"\n' "$1"; } > "$tmp"
	chmod 644 "$tmp"; mv -f "$tmp" "$CONFD"
}
upgrade_done() {  # upgrade_done <version>: 0 = its upgrade steps ran and finished clean, 1 = still running, 2 = not clean
	curl -s --max-time 10 'http://127.0.0.1:3001/schema-upgrade-status?json' | /usr/bin/python3 -I "$SRC/wekan-upgrade-status.py" "$1"
}
CFG=
WORKDB=
cleanup() {
	[ -z "$CFG" ] || rm -f "$CFG"
	if [ -n "$WORKDB" ]; then db "$W/current/bundle" drop "$WORKDB" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
write_cfg() {  # a 0600 mongo tools config holding the URI, readable by system only
	CFG=$(mktemp /run/wekan-tools.XXXXXX); chmod 600 "$CFG"; chown system:system "$CFG"
	as_system /bin/sh -c 'set -a; . /opt/wekan/wekan.env; set +a; exec /usr/bin/python3 -I /home/system/gitea-upgrade/wekan-tools-uri.py' > "$CFG"
}

echo "== state"
cur=$(current_version)
echo "current release: $cur"
echo "WeKan processes: $(wekan_pids | tr '\n' ' ')"
echo "WeKan answers on 127.0.0.1:3001: $(answering && echo yes || echo NO)"
echo "FerretDB: $(rc-service ferretdb status 2>&1 | tail -1)"
echo "Node 26: $($NODE26 --version 2>/dev/null || echo MISSING)"
echo "/etc/conf.d/wekan node: $(grep '^node=' "$CONFD" 2>/dev/null || echo 'not set (Node 24 from the init script)')"
for v in 11.99 12.99 13.06; do
	got=$(sha256sum "$INCOMING/wekan-$v-amd64.zip" 2>/dev/null | cut -d' ' -f1 || true)
	echo "zip $v: $([ "$got" = "$(sha_for "$v")" ] && echo verified || echo "MISSING OR WRONG")"
done
echo "next step: $(next_after "$cur" || true)"
if [ "$phase" = check ]; then
	echo "UPGRADE_WEKAN_CHECK_DONE"
	exit 0
fi

if [ "$phase" = restore ]; then
	B=$arg
	[ -s "$B/manifest.json" ] && [ -d "$B/mongodump" ] && [ -s "$B/previous-release" ] && [ -s "$B/data.tar" ] || { echo "not a complete backup: $B" >&2; exit 1; }
	prev=$(cat "$B/previous-release")
	dbname=$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["database"])' "$B/manifest.json")
	[ -d "$W/releases/$prev/bundle" ] || { echo "release $prev is missing" >&2; exit 1; }
	echo "== restore $B: database $dbname, files, release $prev"
	rm -rf "$W/data.restore-tmp"; mkdir -m 700 "$W/data.restore-tmp"
	tar -xpf "$B/data.tar" -C "$W/data.restore-tmp"
	[ -d "$W/data.restore-tmp/data" ] && [ "$(ls -A "$W/data.restore-tmp" | wc -l)" = 1 ] || { echo "data.tar does not hold exactly data/" >&2; exit 1; }
	[ "$(cd "$W/data.restore-tmp" && find data | wc -l)" = "$(tar -tf "$B/data.tar" | sed 's#/$##' | sort -u | wc -l)" ] || { echo "data.tar did not extract completely" >&2; exit 1; }
	stop_wekan
	write_cfg
	db "$W/releases/$prev/bundle" dropdb "$dbname" "$B/manifest.json"
	as_system mongorestore --config="$CFG" --nsInclude="$dbname.*" --quiet "$B/mongodump"
	rm -rf "$W/data.before-restore"; mv "$W/data" "$W/data.before-restore"; mv "$W/data.restore-tmp/data" "$W/data"; rm -rf "$W/data.restore-tmp"
	if [ -e "$B/conf.d-wekan" ]; then cp -p "$B/conf.d-wekan" "$CONFD"; else rm -f "$CONFD"; fi
	ln -sfn "releases/$prev" "$W/current"
	db "$W/current/bundle" verify "$B/manifest.json" exact || { echo "the restored database differs from the backup's manifest; WeKan left stopped" >&2; exit 1; }
	start_wekan
	n=0; until answering; do [ "$n" -lt 600 ] || { echo "WeKan $prev did not answer after the restore" >&2; exit 1; }; sleep 3; n=$((n + 3)); done
	echo "restored: database, files and release $prev; previous files kept in $W/data.before-restore"
	echo "UPGRADE_WEKAN_RESTORE_OK"
	exit 0
fi

# ---- step ----
target=$arg
[ "$(next_after "$cur")" = "$target" ] || { echo "refusing: the next step after $cur is $(next_after "$cur"), not $target" >&2; exit 1; }
zip=$INCOMING/wekan-$target-amd64.zip
[ "$(sha256sum "$zip" | cut -d' ' -f1)" = "$(sha_for "$target")" ] || { echo "refusing: $zip does not match its pinned sha256" >&2; exit 1; }
[ -x "$NODE26" ] || { echo "refusing: $NODE26 is missing" >&2; exit 1; }
answering || { echo "refusing: WeKan does not answer before the step" >&2; exit 1; }
rc-service ferretdb status >/dev/null 2>&1 || { echo "refusing: FerretDB is not running" >&2; exit 1; }
[ "$(df -Pk /opt | awk 'NR==2 {print $4}')" -gt 5242880 ] || { echo "refusing: less than 5 GiB free on /opt" >&2; exit 1; }
B=$W/backups/pre-$target-$(date +%F_%H-%M-%S)
prev_conf_saved=no
PHASE=before-stop
on_exit() {
	status=$?
	trap - EXIT
	cleanup
	if [ "$status" != 0 ]; then
		case "$PHASE" in
			stopped)
				echo "step failed before $target started: starting $cur again, unchanged" >&2
				if [ "$prev_conf_saved" = yes ]; then if [ -e "$B/conf.d-wekan" ]; then cp -p "$B/conf.d-wekan" "$CONFD"; else rm -f "$CONFD"; fi; fi
				ln -sfn "releases/$cur" "$W/current"
				start_wekan || true
				n=0; until answering; do [ "$n" -lt 600 ] || break; sleep 3; n=$((n + 3)); done
				echo "$cur $(answering && echo is answering again || echo 'is NOT answering: see /var/log/wekan/wekan.log')" >&2 ;;
			started)
				echo "STEP FAILED after $target started and may have changed the data: WeKan is stopped and stays stopped." >&2
				stop_wekan || true
				echo "Read the reason above. To put database, files and release back as they were before this step:" >&2
				echo "  doas sh $SRC/upgrade-wekan.sh restore $B" >&2
				echo "(or, if the reason is harmless, start $target as it is: doas rc-service wekan start)" >&2 ;;
		esac
	fi
	exit "$status"
}
trap on_exit EXIT

echo "== stop WeKan $cur for a consistent backup"
stop_wekan
PHASE=stopped

echo "== backup into $B"
install -d -m 700 -o system -g system "$B"
echo "$cur" > "$B/previous-release"
[ ! -e "$CONFD" ] || cp -p "$CONFD" "$B/conf.d-wekan"
prev_conf_saved=yes
cp -p "$W/wekan.env" "$B/wekan.env"
db "$W/current/bundle" snapshot "$B/manifest.json"
dbname=$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["database"])' "$B/manifest.json")
write_cfg
as_system mongodump --config="$CFG" --db="$dbname" --out="$B/mongodump" --quiet
want=$(/usr/bin/python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["counts"]))' "$B/manifest.json")
got=$(find "$B/mongodump/$dbname" -name '*.bson' | wc -l)
[ "$got" = "$want" ] || { echo "the mongodump has $got collections, the database $want" >&2; exit 1; }
su -s /bin/sh postgres -c "pg_dump -Fc -d ferretdb" > "$B/ferretdb.pgdump"
su -s /bin/sh postgres -c "pg_restore -f /dev/null" < "$B/ferretdb.pgdump"
tar -cpf "$B/data.tar" -C "$W" data
tar -tf "$B/data.tar" > /dev/null
chown -R system:system "$B"; chmod -R go-rwx "$B"
echo "backup: mongodump $got collections ($(du -sh "$B/mongodump" | cut -f1)), ferretdb pg_dump $(du -h "$B/ferretdb.pgdump" | cut -f1) read back in full, files $(tar -tf "$B/data.tar" | wc -l) entries, env files"

echo "== restore rehearsal into $REHEARSAL_DB"
WORKDB=$REHEARSAL_DB
db "$W/current/bundle" drop "$REHEARSAL_DB" >/dev/null
as_system mongorestore --config="$CFG" --nsFrom="$dbname.*" --nsTo="$REHEARSAL_DB.*" --nsInclude="$dbname.*" --quiet "$B/mongodump"
rehearsed=$(db "$W/current/bundle" counts "$REHEARSAL_DB")
/usr/bin/python3 -c '
import json, sys
m = json.load(open(sys.argv[1]))["counts"]; r = json.loads(sys.argv[2])
bad = [f"{k}: {v} vs {r.get(k)}" for k, v in m.items() if r.get(k) != v]
if bad:
    print("REHEARSAL MISMATCH: " + "; ".join(bad)); sys.exit(1)
print(f"rehearsal: all {len(m)} collections restored with identical counts")' "$B/manifest.json" "$rehearsed"
db "$W/current/bundle" drop "$REHEARSAL_DB"
WORKDB=

echo "== release $target"
R=$W/releases/$target
tmp=$(mktemp -d "$W/releases/.unpack-$target.XXXXXX"); chown system:system "$tmp"
as_system unzip -q "$zip" -d "$tmp"
[ ! -e "$R" ] || mv "$R" "$R.replaced-$(date +%F_%H-%M-%S)"
mv "$tmp" "$R"
as_system /usr/bin/python3 -c '
import json, sys
s = json.load(open(sys.argv[1]))
assert s["nodeVersion"].startswith("26."), s["nodeVersion"]
assert s.get("gitCommitHash", "").startswith(sys.argv[2]), "unexpected build " + s.get("gitCommitHash", "")
print("release", sys.argv[3], s["meteorRelease"], "node", s["nodeVersion"], "commit", s["gitCommitHash"][:12])' "$R/bundle/star.json" "$(commit_for "$target")" "$target"
[ -f "$R/bundle/main.js" ]
if [ "$target" = 13.06 ]; then
	as_system /usr/bin/python3 "$SRC/wekan-patch-13.06.py" "$R/bundle/programs/server/app/app.js"
	as_system "$NODE26" --check "$R/bundle/programs/server/app/app.js"
fi

echo "== start WeKan $target"
set_node "$NODE26"
ln -sfn "releases/$target" "$W/current"
PHASE=started
start_wekan
echo "waiting for the one-time upgrade steps to finish (up to 30 minutes)"
n=0
while :; do
	[ -n "$(wekan_pids)" ] || { echo "WeKan $target exited" >&2; tail -n 40 /var/log/wekan/wekan.log >&2; exit 1; }
	rcode=0; report=$(upgrade_done "$target") || rcode=$?
	[ "$rcode" = 0 ] && break
	[ "$rcode" = 2 ] && { echo "$report"; echo "the upgrade steps did not finish clean" >&2; exit 1; }
	[ "$n" -lt 1800 ] || { echo "the upgrade steps did not finish within 30 minutes" >&2; exit 1; }
	sleep 5; n=$((n + 5))
done
echo "$report"
answering || { echo "WeKan $target does not answer on /" >&2; exit 1; }
echo "== verify the data"
db "$W/current/bundle" verify "$B/manifest.json" upgrade
PHASE=done
trap - EXIT
cleanup
echo "WeKan $target is running ($(wekan_pids | tr '\n' ' ')); backup and restore command: doas sh $SRC/upgrade-wekan.sh restore $B"
nxt=$(next_after "$target")
if [ -n "$nxt" ]; then echo "next: open https://todo.true-og.net and check your boards, then: doas sh $SRC/upgrade-wekan.sh step $nxt"
else echo "this was the last step: open https://todo.true-og.net and check your boards"; fi
echo "UPGRADE_WEKAN_STEP_OK $target"
