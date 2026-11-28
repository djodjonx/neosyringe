#!/bin/bash
# parent full open, sizes 10 and 100: the candidate calibrates its own k (its create k differs from the base),
# then base and stage D are locked on the candidate's k. Run a (cand, base, stageD), then b and c (stageD, base, cand) at 100.
# W=<repo>; AB=<run>/t3o-ab; R=$AB/final/parent-relock
use() { rm -rf $W/packages/core/dist; cp -R $AB/$1 $W/packages/core/dist; }
run() { local name=$1 dist=$2; shift 2; use $dist; echo "== $name start load $(sysctl -n vm.loadavg)" >> $R/log; env NEOSYRINGE_BENCH_SHAPES=parent NEOSYRINGE_BENCH_PROFILES=full NEOSYRINGE_BENCH_MODES=open "$@" NEOSYRINGE_BENCH_REPORT=$R/$name.json node tests/bench/runtime-cost.mjs > $R/$name.out 2>&1; echo "== $name exit $? end-load $(sysctl -n vm.loadavg)" >> $R/log; }
for s in 10 100; do
 run cand-fix-s$s cand-fix-core-dist NEOSYRINGE_BENCH_SIZES=$s
 run base-ba192b4-s$s base-ba192b4-core-dist NEOSYRINGE_BENCH_SIZES=$s NEOSYRINGE_BENCH_K_FROM=$R/cand-fix-s$s.json
 run stageD-a3562b1-s$s stageD-a3562b1-core-dist NEOSYRINGE_BENCH_SIZES=$s NEOSYRINGE_BENCH_K_FROM=$R/cand-fix-s$s.json
done
for rep in b c; do for v in stageD-a3562b1 base-ba192b4 cand-fix; do
 run $v-s100-$rep $v-core-dist NEOSYRINGE_BENCH_SIZES=100 NEOSYRINGE_BENCH_K_FROM=$R/cand-fix-s100.json
done; done
# Budget: node scripts/ci/performance-budget.mjs --baseline $R/base-ba192b4-s$s.json --candidate $R/<v>-s$s.json
