#!/bin/bash
# Same commit (D4 r1 tree, dist rebuilt), linear (Infinity) vs table (0); table run reuses the linear k.
W=<repo>; S=<scratch>; R=$S/reports/crossover; mkdir -p $R
run() { local name=$1; shift; echo "== $name start $(date +%T) load $(sysctl -n vm.loadavg)" >> $R/log; local t0=$(date +%s)
  (cd $W && env NEOSYRINGE_BENCH_SHAPES=flat "$@" NEOSYRINGE_BENCH_REPORT=$R/$name.json node tests/bench/runtime-cost.mjs > $R/$name.out 2>&1)
  echo "== $name exit $? secs $(($(date +%s)-t0))" >> $R/log; }
for size in 16 32 64 128 256 512; do
  run linear-s$size NEOSYRINGE_BENCH_SIZES=$size NEOSYRINGE_BENCH_DISPATCH_LINEAR_MAX=Infinity
  run table-s$size NEOSYRINGE_BENCH_SIZES=$size NEOSYRINGE_BENCH_DISPATCH_LINEAR_MAX=0 NEOSYRINGE_BENCH_K_FROM=$R/linear-s$size.json
done
echo "== done $(date +%T)" >> $R/log
