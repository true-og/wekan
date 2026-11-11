#!/bin/sh
# Install (or update) trueog-wekan-authwatch, the service that locks a WeKan account within about a second of
# its Staff-Auth account being deactivated or deleted (and unlocks it when that account is active again).
#   doas sh /home/system/gitea-upgrade/install-wekan-authwatch.sh           install or update, then verify
#   doas sh /home/system/gitea-upgrade/install-wekan-authwatch.sh remove    stop and remove it (and its DB role)
# Complete output and INSTALL_WEKAN_AUTHWATCH_EXIT=<status> are saved in logs/install-wekan-authwatch-<time>.log.
# WeKan, Staff-Auth and Hydra are not restarted or reconfigured. What it sets up:
#   - PostgreSQL role wekan_authwatch (login, SELECT on staffauth users(uuid, deactivated) only), with a new
#     random password in /etc/trueog-wekan-authwatch/pgpass (system, 0600) on every run;
#   - WeKan admin account staffauth-lockbot (made by this tool, marked trueogLockBot) with NO password: it cannot
#     sign in; the service writes itself a login token into the account and keeps it in memory. The service locks
#     in the database, then asks WeKan through its REST API to disable the account too (open tabs close in ~2 s);
#   - /usr/local/sbin/trueog-wekan-authwatch.mjs, /etc/init.d/trueog-wekan-authwatch (supervise-daemon, user
#     system, WeKan's Node), /etc/logrotate.d/trueog-wekan-authwatch; default runlevel.
# Everything that runs WeKan's Node or loads modules from /opt/wekan runs as system (those files belong to system,
# so running them as root would hand system root). Nothing is installed unless the tests pass and the service's own --check, as system against the live
# databases, connects and finds nothing to lock right now.
SRC=/home/system/gitea-upgrade
[ "$(id -u)" = 0 ] || { echo "run as root: doas sh $0" >&2; exit 1; }
if [ -z "${WEKAN_AUTHWATCH_LOGGED:-}" ]; then
	mkdir -p "$SRC/logs"
	LOG=$SRC/logs/install-wekan-authwatch-$(date +%F_%H-%M-%S).log
	: > "$LOG"; chmod 644 "$LOG"; chown system:system "$LOG"
	echo "started $(date -Is): sh $0 $*" >> "$LOG"
	WEKAN_AUTHWATCH_LOGGED=1 sh "$0" "$@" >> "$LOG" 2>&1
	rc=$?
	echo "finished $(date -Is)" >> "$LOG"
	echo "INSTALL_WEKAN_AUTHWATCH_EXIT=$rc" >> "$LOG"
	cat "$LOG"
	exit "$rc"
fi
set -eu
NAME=trueog-wekan-authwatch
BIN=/usr/local/sbin/$NAME.mjs
INITD=/etc/init.d/$NAME
ROTATE=/etc/logrotate.d/$NAME
CONFDIR=/etc/$NAME
PGPASS=$CONFDIR/pgpass
SVCLOG=/var/log/wekan/$NAME.log
ROLE=wekan_authwatch
NODE=$(sed -n 's/^node="\(.*\)"$/\1/p' /etc/conf.d/wekan)
[ -n "$NODE" ] && [ -x "$NODE" ] || { echo "no Node from node= in /etc/conf.d/wekan" >&2; exit 1; }

as_system() { (cd / && env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/home/system PGPASSFILE="$PGPASS" runuser -u system -- "$@"); }
pg() { runuser -u postgres -- /usr/bin/psql -X -q -At -v ON_ERROR_STOP=1 "$@"; }
enabled() { rc-update show default | grep -Eq "(^|[[:space:]])$NAME([[:space:]]|\$)"; }
running() { pgrep -f "^$NODE $BIN" >/dev/null; }
stop_service() {
	rc-service "$NAME" stop >/dev/null 2>&1 || true
	n=0
	while running; do
		[ "$n" -lt 30 ] || { echo "$NAME did not stop after 30 seconds" >&2; return 1; }
		sleep 1; n=$((n + 1))
	done
}
# Start detached, then require: OpenRC says started, supervise-daemon supervises it, and its log shows the
# installed code starting and its first pass ("watching N linked WeKan accounts").
start_and_verify() {
	version=$(sha256sum "$BIN" | cut -c1-16)
	mark=0
	[ ! -f "$SVCLOG" ] || mark=$(wc -l < "$SVCLOG")
	setsid -f /bin/sh -c "rc-service $NAME start >>/var/log/wekan/openrc-detached-start.log 2>&1"
	n=0
	until rc-service "$NAME" status >/dev/null 2>&1 &&
		pgrep -f "^supervise-daemon $NAME " >/dev/null && running &&
		tail -n +"$((mark + 1))" "$SVCLOG" 2>/dev/null | grep -q "started version=$version " &&
		tail -n +"$((mark + 1))" "$SVCLOG" 2>/dev/null | grep -q "watching [0-9]* linked WeKan accounts"; do
		[ "$n" -lt 30 ] || { echo "$NAME was not started, supervised and watching after 30 seconds" >&2
			tail -n +"$((mark + 1))" "$SVCLOG" 2>/dev/null | tail -5 >&2; return 1; }
		sleep 1; n=$((n + 1))
	done
	if tail -n +"$((mark + 1))" "$SVCLOG" | grep -q "not reviewed"; then
		echo "$NAME is running but watches only (WeKan version not in REVIEWED_WEKAN)" >&2; return 1
	fi
	if ! tail -n +"$((mark + 1))" "$SVCLOG" | grep -q "started version=$version .*API nudge on"; then
		echo "$NAME is running without its WeKan API nudge (open tabs would close only at WeKan's next poll)" >&2; return 1
	fi
	[ "$(pgrep -c -f "^$NODE $BIN")" = 1 ] || { echo "more than one $NAME process" >&2; return 1; }
	tail -n +"$((mark + 1))" "$SVCLOG"
}

if [ "${1:-}" = remove ]; then
	stop_service
	rc-update del "$NAME" default >/dev/null 2>&1 || true
	rm -f "$BIN" "$INITD" "$ROTATE"
	if [ -s "$SRC/$NAME.mjs" ]; then
		as_system "$NODE" --no-warnings "$SRC/$NAME.mjs" --remove-bot
	else
		echo "note: $SRC/$NAME.mjs is missing, so the WeKan account staffauth-lockbot was not removed" >&2
	fi
	rm -rf "$CONFDIR"
	if [ "$(pg -d postgres -c "select 1 from pg_roles where rolname='$ROLE'")" = 1 ]; then
		pg -d staffauth -c "revoke all on users from $ROLE; revoke all on schema public from $ROLE"
		pg -d postgres -c "revoke all on database staffauth from $ROLE; drop role $ROLE"
	fi
	echo "removed $NAME, the WeKan account staffauth-lockbot and the role $ROLE (Staff-Auth still refuses sign-in for deactivated or deleted accounts;"
	echo "WeKan sessions already open are no longer ended by it)"
	echo "INSTALL_WEKAN_AUTHWATCH_REMOVED"
	exit 0
fi
[ "$#" = 0 ] || { echo "usage: doas sh $0 [remove]" >&2; exit 2; }

for f in "$SRC/$NAME.mjs" "$SRC/$NAME-test.mjs" "$SRC/$NAME.initd" "$SRC/$NAME.logrotate"; do
	[ -s "$f" ] || { echo "missing source $f" >&2; exit 1; }
done
as_system "$NODE" --check "$SRC/$NAME.mjs"
sh -n "$SRC/$NAME.initd"

WORK=$(mktemp -d /var/tmp/$NAME-install.XXXXXX)
chmod 700 "$WORK"
# The tests use a scratch FerretDB database only (wekan_authwatch_test, dropped afterwards); as system they skip
# the scratch-PostgreSQL part, which needs root (run the test file as root by hand for that part).
tests=0
as_system "$NODE" --no-warnings "$SRC/$NAME-test.mjs" > "$WORK/tests" 2>&1 || tests=$?
tail -3 "$WORK/tests" | sed 's/^/tests: /'
if [ "$tests" != 0 ] || ! tail -1 "$WORK/tests" | grep -Eq '^([0-9]+)/\1 passed$'; then
	echo "tests failed; nothing installed" >&2; rm -rf "$WORK"; exit 1
fi

# The database role: read-only, two columns. A new password on every run, written only to the pgpass file
# (sent to psql on its standard input, so it never appears in a process list).
mkdir -p "$CONFDIR"; chown system:system "$CONFDIR"; chmod 700 "$CONFDIR"
PW=$(/usr/bin/python3 -I -c 'import secrets; print(secrets.token_hex(24))')
if [ "$(pg -d postgres -c "select 1 from pg_roles where rolname='$ROLE'")" != 1 ]; then
	pg -d postgres -c "create role $ROLE login nosuperuser nocreatedb nocreaterole noinherit"
fi
# The new pgpass is written first and moved into place only after PostgreSQL took the password, so a failure
# leaves the running service with a matching pair. The statement is kept out of PostgreSQL's log, even on error.
umask 077
printf '127.0.0.1:5432:staffauth:%s:%s\n' "$ROLE" "$PW" > "$PGPASS.new"
chown system:system "$PGPASS.new"; chmod 600 "$PGPASS.new"
umask 022
printf "set log_statement = 'none';\nset log_min_error_statement = 'panic';\n\\\\set pw '%s'\nalter role %s login password :'pw';\n" "$PW" "$ROLE" | pg -d postgres -f -
mv "$PGPASS.new" "$PGPASS"
unset PW
pg -d postgres -c "revoke all on database staffauth from $ROLE; grant connect on database staffauth to $ROLE"
pg -d staffauth -c "revoke all on users from $ROLE; grant usage on schema public to $ROLE; grant select (uuid, deactivated) on users to $ROLE"
echo "role $ROLE: login, SELECT (uuid, deactivated) on staffauth.users only; password in $PGPASS"

# The WeKan account the service uses to make WeKan disable a locked account itself (closing open tabs at
# once): created or reset (administrator, enabled, no password, no tokens); the tool refuses an existing account
# of that name it did not make, and proves through the REST API that a token it mints acts as the admin bot.
rm -f "$CONFDIR/wekan-bot" "$CONFDIR/allow-mass-lock"
as_system "$NODE" --no-warnings "$SRC/$NAME.mjs" --provision-bot > "$WORK/bot" 2>&1 || {
	sed 's/^/bot: /' "$WORK/bot"; echo "could not set up the WeKan account staffauth-lockbot; service not installed" >&2; rm -rf "$WORK"; exit 1; }
sed 's/^/bot: /' "$WORK/bot"
grep -q '^WEKAN_LOCKBOT_OK$' "$WORK/bot" || { echo "staffauth-lockbot not verified; service not installed" >&2; rm -rf "$WORK"; exit 1; }

# The service's own check, as system, against the live databases: reads Staff-Auth through the new role,
# reads WeKan's users, writes nothing. It must report nothing to lock right now.
preflight=0
as_system "$NODE" --no-warnings "$SRC/$NAME.mjs" --check > "$WORK/preflight" 2>&1 || preflight=$?
sed 's/^/preflight: /' "$WORK/preflight"
if [ "$preflight" != 0 ] || ! grep -q '^WEKAN_AUTHWATCH_CHECK_OK$' "$WORK/preflight"; then
	echo "preflight check failed; service not installed (the role and $PGPASS stay; 'remove' drops them)" >&2
	rm -rf "$WORK"; exit 1
fi
if ! grep -q 'would lock \[\], unlock \[\]' "$WORK/preflight" || grep -q -E 'NOT reviewed|refused:' "$WORK/preflight" ||
	! grep -q 'API: bot signs in$' "$WORK/preflight"; then
	echo "preflight: it would change accounts right now, refuses a mass lock, this WeKan version is not reviewed," >&2
	echo "or the bot cannot sign in; check by hand first" >&2
	rm -rf "$WORK"; exit 1
fi

BACKUP=$WORK/previous
mkdir "$BACKUP"
[ ! -e "$BIN" ] || cp -p "$BIN" "$BACKUP/service"
[ ! -e "$INITD" ] || cp -p "$INITD" "$BACKUP/initd"
[ ! -e "$ROTATE" ] || cp -p "$ROTATE" "$BACKUP/logrotate"
was_enabled=no; ! enabled || was_enabled=yes
was_running=no; ! running || was_running=yes
DONE=no
# Any failing exit from here on puts the previous files, runlevel membership and running state back (a
# first installation is removed again); the same signal list as install-authwatch.sh.
SIGNALS="1 2 3 4 5 6 7 8 10 11 12 13 14 15 16 24 25 26 27 29 30 31"
n=34
while [ "$n" -le 64 ]; do SIGNALS="$SIGNALS $n"; n=$((n + 1)); done
rollback() {
	status=$?
	trap '' $SIGNALS
	trap - EXIT
	if [ "$DONE" != yes ]; then
		echo "installation failed; restoring the previous state" >&2
		ok=yes
		stop_service || ok=no
		for pair in "service:$BIN:755" "initd:$INITD:755" "logrotate:$ROTATE:644"; do
			name=${pair%%:*}; rest=${pair#*:}; dst=${rest%%:*}; mode=${rest#*:}
			if [ -e "$BACKUP/$name" ]; then
				install -m "$mode" -o root -g root "$BACKUP/$name" "$dst" && cmp -s "$BACKUP/$name" "$dst" || ok=no
			else
				rm -f "$dst" || true
				[ ! -e "$dst" ] || ok=no
			fi
		done
		if [ "$was_enabled" = yes ]; then
			enabled || rc-update add "$NAME" default >/dev/null 2>&1 || true
			enabled || ok=no
		else
			rc-update del "$NAME" default >/dev/null 2>&1 || true
			! enabled || ok=no
		fi
		if [ "$was_running" = yes ] && [ "$ok" = yes ]; then
			start_and_verify >/dev/null 2>&1 || { ok=no; echo "the previous $NAME is restored but not verified running" >&2; }
		fi
		if [ "$ok" = yes ]; then
			rm -rf "$WORK"
			echo "previous state restored (the role $ROLE and $PGPASS stay; 'remove' drops them)" >&2
		else
			echo "ROLLBACK INCOMPLETE: files, runlevel or running state differ from before; backup kept in $BACKUP" >&2
		fi
		[ "$status" != 0 ] || status=1
	fi
	exit "$status"
}
trap rollback EXIT
for sig in $SIGNALS; do
	trap "trap '' $SIGNALS; exit $((128 + sig))" "$sig"
done

stop_service
install -m 755 -o root -g root "$SRC/$NAME.mjs" "$BIN"
install -m 755 -o root -g root "$SRC/$NAME.initd" "$INITD"
install -m 644 -o root -g root "$SRC/$NAME.logrotate" "$ROTATE"
cmp -s "$SRC/$NAME.mjs" "$BIN" && cmp -s "$SRC/$NAME.initd" "$INITD" && cmp -s "$SRC/$NAME.logrotate" "$ROTATE"
echo "installed $BIN, $INITD and $ROTATE"
rotate_status=0
logrotate -d "$ROTATE" > "$WORK/logrotate" 2>&1 || rotate_status=$?
if [ "$rotate_status" != 0 ] || grep -Ei "^error|duplicate log entry|^warning: .*$NAME:[0-9]+" "$WORK/logrotate" >&2; then
	echo "logrotate rejects $ROTATE (status $rotate_status)" >&2; exit 1
fi
enabled || rc-update add "$NAME" default >/dev/null
enabled || { echo "$NAME is not in the default runlevel" >&2; exit 1; }
start_and_verify
DONE=yes
trap - EXIT $SIGNALS
rm -rf "$WORK"
echo "$NAME $(sha256sum "$BIN" | cut -c1-16) is enabled, started, supervised and watching"
echo "INSTALL_WEKAN_AUTHWATCH_OK"
