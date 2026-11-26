#!/bin/bash
# Alternates base (61e09f3) and candidate (ac5823a) core dist per step. Writes reports under <scratch>/reports.
W=<repo>; S=<scratch>
use() { rm -rf $W/packages/core/dist; cp -R $S/$1/core-dist $W/packages/core/dist; }
step() { # name dist env...
  local name=$1 dist=$2; shift 2
  use $dist
  echo "== $name start $(date +%T) load $(sysctl -n vm.loadavg)" >> $S/reports/campaign.log
  local t0=$(date +%s)
  (cd $W && env "$@" NEOSYRINGE_BENCH_REPORT=$S/reports/$name.json node tests/bench/runtime-cost.mjs > $S/reports/$name.out 2>&1)
  echo "== $name exit $? secs $(($(date +%s)-t0))" >> $S/reports/campaign.log
}
for size in 10 100 1000; do
  step base-61e09f3-s$size base-61e09f3 NEOSYRINGE_BENCH_SIZES=$size
  step cand-ac5823a-s$size cand-ac5823a NEOSYRINGE_BENCH_SIZES=$size
done
step base-61e09f3-s5000-flat base-61e09f3 NEOSYRINGE_BENCH_SIZES=5000 NEOSYRINGE_BENCH_SHAPES=flat
step cand-ac5823a-s5000-flat cand-ac5823a NEOSYRINGE_BENCH_SIZES=5000 NEOSYRINGE_BENCH_SHAPES=flat
for d in base-61e09f3 cand-ac5823a; do
  (cd $W && NEOSYRINGE_BENCH_CORE_DIST=$S/$d/core-dist NEOSYRINGE_BENCH_FACTORY_REPORT=$S/reports/factory-$d.json node tests/bench/factory-cost.mjs > $S/reports/factory-$d.out 2>&1); echo "== factory $d exit $?" >> $S/reports/campaign.log
  use $d
  (cd $W && node scripts/measure-t17-size.mjs --json > $S/reports/size-$d.json 2>&1); echo "== size $d exit $?" >> $S/reports/campaign.log
  (cd $W && node scripts/measure-t17-size.mjs --breakdown --json > $S/reports/breakdown-$d.json 2>&1); echo "== breakdown $d exit $?" >> $S/reports/campaign.log
  (cd $W && node scripts/measure-chunk-split.mjs > $S/reports/chunk-$d.out 2>&1); echo "== chunk $d exit $?" >> $S/reports/campaign.log
done
use cand-ac5823a
echo "== done $(date +%T)" >> $S/reports/campaign.log
