#!/bin/zsh
# Usage: desktop-test-gate.sh <owner-label> <min-unused-GB> -- <command...>
# Atomic single-slot desktop test admission (mkdir lock). Refuses (exit 75) if the slot is taken or the
# host guard fails (CPU idle >= 40%, unused >= min GB, swap not grown since the last admission,
# compressor <= 8 GB, no other desktop vitest/tsc). Otherwise runs the command, logs START/END, releases.
# Callers retry at most every 60 s and give up after 30 minutes, recording NOT RUN.
LOCK=/tmp/clubhouse-desktop-test.lock
LOG=/tmp/clubhouse-desktop-test-gate.log
SWAPBASE=/tmp/clubhouse-desktop-test.swapbase
owner=$1; min=$2; shift 2; [ "$1" = "--" ] && shift
if ! mkdir "$LOCK" 2>/dev/null; then echo "REFUSED: slot held by $(cat $LOCK/owner 2>/dev/null)"; exit 75; fi
trap 'rm -rf "$LOCK"' EXIT INT TERM
echo "$owner" > "$LOCK/owner"
top_line=$(top -l 1 -n 0)
idle=$(print -r -- "$top_line" | awk '/CPU usage/ {for(i=1;i<=NF;i++) if($i ~ /idle/) {gsub("%","",$(i-1)); print int($(i-1))}}')
unused=$(print -r -- "$top_line" | awk '/PhysMem/ {for(i=1;i<=NF;i++) if($i ~ /unused/) print $(i-1)}')
comp=$(print -r -- "$top_line" | awk '/PhysMem/ {for(i=1;i<=NF;i++) if($i ~ /compressor/) {gsub("\\(","",$(i-1)); print $(i-1)}}')
tomb() { print -r -- "$1" | awk '/G$/ {sub("G","");print int($1*1024); next} /M$/ {sub("M","");print int($1)}'; }
mb=$(tomb "$unused"); compmb=$(tomb "$comp")
swapmb=$(sysctl -n vm.swapusage | awk '{for(i=1;i<=NF;i++) if($i=="used") {v=$(i+2); sub("M","",v); print int(v)}}')
base=$(cat "$SWAPBASE" 2>/dev/null || echo "$swapmb")
reason=""
[ "${idle:-0}" -lt 40 ] && reason="$reason idle=${idle}%<40"
# "unused" excludes reclaimable file cache, so it stays near zero on a busy Mac. Use reclaimable memory
# (free+inactive+speculative+purgeable) plus the kernel's free percentage; swap/compressor guards catch real pressure.
availmb=$(vm_stat | awk -F: '/Pages (free|inactive|speculative|purgeable)/{gsub(/[ .]/,"",$2); s+=$2} END{print int(s*16384/1048576)}')
freepct=$(memory_pressure 2>/dev/null | awk -F': ' '/free percentage/{gsub("%","",$2); print int($2)}')
[ "${availmb:-0}" -lt $((min*1024)) ] && reason="$reason available=${availmb}M<${min}G"
[ "${freepct:-0}" -lt 25 ] && reason="$reason mem_free_pct=${freepct}<25"
[ "${compmb:-0}" -gt 12288 ] && reason="$reason compressor=${comp}>12G"
[ "${swapmb:-0}" -gt $((base+128)) ] && reason="$reason swap_grew=${base}->${swapmb}M"
# Go's build phase: hold every desktop admission while an xcodebuild is compiling (not testing).
# Explicit phase hold set by the orchestrator from Navi/Go receipts (independent of process matching).
# A hold line starting "allow=<owner>[,<owner>...];" admits only those owners (atomic reservation for the integrated suite).
if [ -f /tmp/clubhouse-desktop-hold ]; then
  hold=$(head -c 200 /tmp/clubhouse-desktop-hold)
  allow=""; case "$hold" in allow=*) allow=${${hold#allow=}%%;*};; esac
  case ",$allow," in *",$owner,"*) ;; *) reason="$reason explicit_hold(${hold:0:80})";; esac
fi
# Go self-admits: block heavy (>=6 GB) runs only while Swift is actually compiling (swift-frontend/swiftc/ld); an idle xcodebuild (test phase) is judged by the measured guards.
# admissions while it is compiling; everything else is decided by the measured guards above.
# Go's test phase: allow only targeted vitest (min < 6), never tsc/npm-sized admissions.
[ "$min" -ge 6 ] && ps -axo comm= | grep -qE '(^|/)(swift-frontend|swiftc|ld)$' && reason="$reason go_compiling_hold_heavy"
# Only real node processes count (not this gate's own argv, and not apps whose arguments mention vitest).
ps -axo pid=,comm=,args= | awk -v me=$$ '$1!=me && $2 ~ /(^|\/)node$/ && $0 ~ /vitest|tsc --noEmit|typescript\/bin\/tsc/ {found=1} END {exit !found}' && reason="$reason other_test_running"
if [ -n "$reason" ]; then echo "REFUSED:$reason"; exit 75; fi
echo "$swapmb" > "$SWAPBASE"
echo "$(date -u +%FT%TZ) START $owner idle=${idle}% unused=${unused} avail=${availmb}M freepct=${freepct} comp=${comp} swap=${swapmb}M pid=$$ cmd=$*" | tee -a $LOG
"$@"; rc=$?
echo "$(date -u +%FT%TZ) END $owner rc=$rc" | tee -a $LOG
exit $rc
