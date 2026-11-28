#!/bin/bash
W=<repo>; S=<scratch>; R=$S/reports/final; mkdir -p $R
use() { rm -rf $W/packages/core/dist; cp -R $S/$1/core-dist $W/packages/core/dist; }
step() { local name=$1 dist=$2; shift 2; use $dist
  echo "== $name start $(date +%T) load $(sysctl -n vm.loadavg)" >> $R/log; local t0=$(date +%s)
  (cd $W && env "$@" NEOSYRINGE_BENCH_REPORT=$R/$name.json node tests/bench/runtime-cost.mjs > $R/$name.out 2>&1)
  echo "== $name exit $? secs $(($(date +%s)-t0)) end-load $(sysctl -n vm.loadavg)" >> $R/log; }
for i in $(seq 1 60); do l=$(sysctl -n vm.loadavg | awk "{print int(\$2)}"); [ "$l" -lt 5 ] && break; sleep 10; done
for size in 10 100; do
  step base-61e09f3-s$size base-61e09f3 NEOSYRINGE_BENCH_SIZES=$size
  step cand-84c096e-s$size cand-84c096e NEOSYRINGE_BENCH_SIZES=$size NEOSYRINGE_BENCH_K_FROM=$R/base-61e09f3-s$size.json
done
step cand-84c096e-s1000 cand-84c096e NEOSYRINGE_BENCH_SIZES=1000
step cand-84c096e-s5000-flat cand-84c096e NEOSYRINGE_BENCH_SIZES=5000 NEOSYRINGE_BENCH_SHAPES=flat
use cand-84c096e
(cd $W && NEOSYRINGE_BENCH_FACTORY_REPORT=$R/factory-cand-84c096e.json node tests/bench/factory-cost.mjs > $R/factory-cand-84c096e.out 2>&1); echo "== factory exit $?" >> $R/log
(cd $W && node scripts/measure-t17-size.mjs --json > $R/size-cand-84c096e.json 2>&1); echo "== size exit $?" >> $R/log
(cd $W && node scripts/measure-t17-size.mjs --breakdown --json > $R/breakdown-cand-84c096e.json 2>&1); echo "== breakdown exit $?" >> $R/log
(cd $W && node scripts/measure-chunk-split.mjs > $R/chunk-cand-84c096e.out 2>&1); echo "== chunk exit $?" >> $R/log
use base-61e09f3
(cd $W && node scripts/measure-t17-size.mjs --breakdown --json > $R/breakdown-base-61e09f3.json 2>&1); echo "== breakdown base exit $?" >> $R/log
use cand-84c096e
echo "== done $(date +%T)" >> $R/log
