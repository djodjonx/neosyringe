#!/bin/bash
# Same k for both: candidate runs with NEOSYRINGE_BENCH_K_FROM=<base report>. s10/s100 base re-run on an idle machine.
W=<repo>; S=<scratch>
use() { rm -rf $W/packages/core/dist; cp -R $S/$1/core-dist $W/packages/core/dist; }
step() { local name=$1 dist=$2; shift 2; use $dist
  echo "== $name start $(date +%T) load $(sysctl -n vm.loadavg)" >> $S/reports/campaign2.log; local t0=$(date +%s)
  (cd $W && env "$@" NEOSYRINGE_BENCH_REPORT=$S/reports/$name.json node tests/bench/runtime-cost.mjs > $S/reports/$name.out 2>&1)
  echo "== $name exit $? secs $(($(date +%s)-t0))" >> $S/reports/campaign2.log; }
for size in 10 100; do
  step base2-61e09f3-s$size base-61e09f3 NEOSYRINGE_BENCH_SIZES=$size
  step cand2-ac5823a-s$size cand-ac5823a NEOSYRINGE_BENCH_SIZES=$size NEOSYRINGE_BENCH_K_FROM=$S/reports/base2-61e09f3-s$size.json
done
step cand2-ac5823a-s1000 cand-ac5823a NEOSYRINGE_BENCH_SIZES=1000 NEOSYRINGE_BENCH_K_FROM=$S/reports/base-61e09f3-s1000.json
step cand2-ac5823a-s5000-flat cand-ac5823a NEOSYRINGE_BENCH_SIZES=5000 NEOSYRINGE_BENCH_SHAPES=flat NEOSYRINGE_BENCH_K_FROM=$S/reports/base-61e09f3-s5000-flat.json
use cand-ac5823a
echo "== done $(date +%T)" >> $S/reports/campaign2.log
