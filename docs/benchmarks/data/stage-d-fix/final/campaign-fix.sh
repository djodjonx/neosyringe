#!/bin/bash
# Final campaign: base ba192b4 vs stage D a3562b1 vs candidate (fix), sizes 10 and 100, k locked on the base.
# Usage: campaign-fix.sh <worktree> <ab dir> <out dir>
W=$1; S=$2; R=$3; mkdir -p $R
use() { rm -rf $W/packages/core/dist; cp -R $S/$1 $W/packages/core/dist; }
load() { sysctl -n vm.loadavg; }
step() { local name=$1 dist=$2; shift 2; use $dist
  echo "== $name start $(date +%T) load $(load)" >> $R/log; local t0=$(date +%s)
  (cd $W && env "$@" NEOSYRINGE_BENCH_REPORT=$R/$name.json node tests/bench/runtime-cost.mjs > $R/$name.out 2>&1)
  echo "== $name exit $? secs $(($(date +%s)-t0)) end-load $(load)" >> $R/log; }
echo "== campaign start $(date '+%F %T') load $(load)" >> $R/log
for size in 10 100; do
  step base-ba192b4-s$size base-ba192b4-core-dist NEOSYRINGE_BENCH_SIZES=$size
  step cand-fix-s$size cand-fix-core-dist NEOSYRINGE_BENCH_SIZES=$size NEOSYRINGE_BENCH_K_FROM=$R/base-ba192b4-s$size.json
  step stageD-a3562b1-s$size stageD-a3562b1-core-dist NEOSYRINGE_BENCH_SIZES=$size NEOSYRINGE_BENCH_K_FROM=$R/base-ba192b4-s$size.json
done
for v in base-ba192b4 stageD-a3562b1 cand-fix; do
  use $v-core-dist
  (cd $W && node scripts/measure-t17-size.mjs --json > $R/size-$v.json 2>&1); echo "== size $v exit $? load $(load)" >> $R/log
done
use cand-fix-core-dist
echo "== campaign done $(date '+%F %T') load $(load)" >> $R/log
