#!/bin/bash
# usage: storage-driver.sh <wt-label>   (runs every storage failure case; prints a table line per case)
set -u
W=$1; WT=/tmp/$W; export PATH=/tmp/node-v24.21.0-linux-x64/bin:$PATH
TSX="$WT/node_modules/.bin/tsx"; H=/tmp/ev/scripts/storage.mts
ROOT=/tmp/j1-storage-$W; rm -rf $ROOT; mkdir -p $ROOT; chmod 755 $ROOT
mkdir -p /tmp/j1-nobody-tmp; chmod 1777 /tmp/j1-nobody-tmp
run() { (cd $WT && WT=$WT $TSX $H "$@"); }
runas() { (cd $WT && setpriv --reuid=65534 --regid=65534 --clear-groups env TMPDIR=/tmp/j1-nobody-tmp HOME=/tmp/j1-nobody-tmp WT=$WT PATH=$PATH $TSX $H "$@"); }
files() { (cd $1 && for f in session-messages.sqlite3 session-messages.sqlite3-wal session-messages.sqlite3-shm trust.sqlite3 trust.sqlite3-wal trust.sqlite3-shm; do if [ -e $f ]; then if [[ $f == *-shm ]]; then echo "$f:$(stat -c %s $f)"; else echo "$f:$(stat -c %s $f):$(sha256sum $f|cut -c1-12)"; fi; else echo "$f:-"; fi; done | tr '\n' ' '); }
case_() { # name, setup-fn, claim-runner, dt
  local name=$1 prep=$2 runner=${3:-run} dt=${4:-10} crash=${5:-}; local D=${CASEDIR:-$ROOT}/$name; mkdir -p $D
  run setup $D unknown $crash >/dev/null 2>&1 || echo "SETUP-FAIL $name"
  local pre=$(run dump $D)
  $prep $D
  local fb=$(files $D)
  local out=$($runner claim $D $dt 2>&1 | tail -1)
  local fa=$(files $D)
  local post=$(run dump $D 2>&1 | tail -1)
  echo "CASE $name"; echo "  pre-dump : $pre"; echo "  files-before: $fb"; echo "  claim    : $out"; echo "  files-after : $fa"; echo "  post-dump: $post"
}
noop() { :; }
p_missing_db() { rm -f $1/session-messages.sqlite3*; }
p_missing_dir() { rm -rf $1; }
p_ro_dir() { chown -R 65534:65534 $1; chmod 400 $1/*.sqlite3; chmod 500 $1; }
p_ro_file() { chown -R 65534:65534 $1; chmod 700 $1; chmod 400 $1/session-messages.sqlite3; }
p_ro_trust() { chown -R 65534:65534 $1; chmod 700 $1; chmod 400 $1/trust.sqlite3; }
p_owned() { chown -R 65534:65534 $1; chmod 700 $1; }
p_lock_session() { node -e '
const {DatabaseSync}=require("node:sqlite"); const d=new DatabaseSync(process.argv[1]); d.exec("BEGIN EXCLUSIVE"); require("fs").writeFileSync(process.argv[1]+".locked","1"); setTimeout(()=>{d.exec("ROLLBACK");d.close()},9000);' $1/session-messages.sqlite3 & while [ ! -e $1/session-messages.sqlite3.locked ]; do :; done; rm $1/session-messages.sqlite3.locked; }
p_lock_trust() { node -e '
const {DatabaseSync}=require("node:sqlite"); const d=new DatabaseSync(process.argv[1]); d.exec("BEGIN EXCLUSIVE"); require("fs").writeFileSync(process.argv[1]+".locked","1"); setTimeout(()=>{d.exec("ROLLBACK");d.close()},9000);' $1/trust.sqlite3 & while [ ! -e $1/trust.sqlite3.locked ]; do :; done; rm $1/trust.sqlite3.locked; }
p_shm_garbage() { head -c 32768 /dev/urandom > $1/session-messages.sqlite3-shm; }
p_wal_garbage_empty() { head -c 8192 /dev/urandom > $1/session-messages.sqlite3-wal; }
p_schema_drop_wake() { node -e 'const {DatabaseSync}=require("node:sqlite"); const d=new DatabaseSync(process.argv[1]); d.exec("DROP TABLE wake_nonces"); d.close()' $1/session-messages.sqlite3; }
p_schema_msgs_nocol() { node -e 'const {DatabaseSync}=require("node:sqlite"); const d=new DatabaseSync(process.argv[1]); d.exec("ALTER TABLE messages DROP COLUMN claim_until"); d.close()' $1/session-messages.sqlite3 2>&1 | tail -1; }
p_schema_wake_readonly_trigger() { node -e 'const {DatabaseSync}=require("node:sqlite"); const d=new DatabaseSync(process.argv[1]); d.exec("CREATE TRIGGER j1_block BEFORE UPDATE ON wake_nonces BEGIN SELECT RAISE(ABORT, '"'"'j1 injected update failure'"'"'); END;"); d.close()' $1/session-messages.sqlite3; }
p_schema_msgs_trigger() { node -e 'const {DatabaseSync}=require("node:sqlite"); const d=new DatabaseSync(process.argv[1]); d.exec("CREATE TRIGGER j1_block_m BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, '"'"'j1 injected claim failure'"'"'); END;"); d.close()' $1/session-messages.sqlite3; }
p_schema_msgs_rebuild() { node -e 'const {DatabaseSync}=require("node:sqlite"); const d=new DatabaseSync(process.argv[1]); d.exec("DROP INDEX messages_target_pending; ALTER TABLE messages DROP COLUMN claim_until;"); d.close()' $1/session-messages.sqlite3; }
p_crash_state() { echo "    crash-wal-before: $(stat -c %s $1/session-messages.sqlite3-wal 2>/dev/null)"; }
p_crash_delete_wal() { rm -f $1/session-messages.sqlite3-wal $1/session-messages.sqlite3-shm; }
p_crash_corrupt_wal() { local sz=$(stat -c %s $1/session-messages.sqlite3-wal); python3 -c "
import sys,os; p=sys.argv[1]; b=bytearray(open(p,'rb').read()); n=len(b)
for off in range(n-4096, n-100, 97): b[off]^=0xFF
open(p,'wb').write(b)" $1/session-messages.sqlite3-wal; rm -f $1/session-messages.sqlite3-shm; }
p_crash_corrupt_shm() { head -c 32768 /dev/urandom > $1/session-messages.sqlite3-shm; }
p_diskfull() { local f=$1/filler; dd if=/dev/zero of=$f bs=1k count=100000 2>/dev/null; sync; echo "    df: $(df -k $1|tail -1)"; }
p_garbage_db() { rm -f $1/session-messages.sqlite3-*; head -c 16384 /dev/urandom > $1/session-messages.sqlite3; }
p_trust_missing() { rm -f $1/trust.sqlite3*; }

echo "## $W  $(date -u +%FT%TZ)"
case_ control-root noop run
case_ control-nobody p_owned runas
case_ missing-db p_missing_db run
case_ missing-dir p_missing_dir run
case_ ro-dir-nobody p_ro_dir runas
case_ ro-file-nobody p_ro_file runas
case_ ro-trust-nobody p_ro_trust runas
case_ lock-session-exclusive p_lock_session run
wait
case_ lock-trust-exclusive p_lock_trust run
wait
case_ shm-garbage p_shm_garbage run
case_ wal-garbage-after-close p_wal_garbage_empty run
case_ schema-drop-wake p_schema_drop_wake run
case_ schema-msgs-rebuilt-missing-claim_until p_schema_msgs_rebuild run
case_ schema-wake-update-abort p_schema_wake_readonly_trigger run
case_ schema-msgs-update-abort p_schema_msgs_trigger run
case_ garbage-db p_garbage_db run
case_ trust-missing p_trust_missing run
case_ crash-noop p_crash_state run 10 crash
case_ crash-delete-wal p_crash_delete_wal run 10 crash
case_ crash-corrupt-wal-tail p_crash_corrupt_wal run 10 crash
case_ crash-corrupt-shm p_crash_corrupt_shm run 10 crash
# disk full: session DB on 256k tmpfs, trust DB on normal disk
mountpoint -q /tmp/j1-tmpfs-$W || { mkdir -p /tmp/j1-tmpfs-$W; mount -t tmpfs -o size=384k tmpfs /tmp/j1-tmpfs-$W; }
rm -rf /tmp/j1-tmpfs-$W/*; mkdir -p $ROOT/trust-for-diskfull
export TRUST_PATH=$ROOT/trust-for-diskfull/trust.sqlite3
CASEDIR=/tmp/j1-tmpfs-$W case_ diskfull-session p_diskfull run
unset TRUST_PATH
rm -rf /tmp/j1-tmpfs-$W/*
CASEDIR=/tmp/j1-tmpfs-$W case_ diskfull-both p_diskfull run
