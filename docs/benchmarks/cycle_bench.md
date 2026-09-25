# cycle_bench — Widespread programs

Per-program Risc0 executor cycle counts for the deployed Widespread programs
(registry, testimonial, pointer). Mirrors the upstream methodology in
`logos-execution-zone/tools/cycle_bench`: `SessionInfo::cycles()` is
deterministic across runs; wall time is best/mean over 5 timed iterations
after 1 discarded warmup. Executor only — no proving (upstream's `--prove`
mode can be added the same way if a fee-model input is needed).

## Machine

| Field | Value |
|---|---|
| Chip | Intel Core Ultra 9 275HX (24 cores) |
| OS | Fedora 44 |
| Rust | 1.98.1 |
| Risc0 zkVM | 3.0.5 |
| Profile | release |
| GPU acceleration | none |

## Results

| Program | Instruction | user_cycles | segments | exec_ms (best / mean) |
|---|---|---:|---:|---:|
| registry | register_self | 125,348 | 1 | 30.5 / 35.5 |
| registry | register_deployer (chained) | 147,571 | 1 | 30.7 / 37.2 |
| registry | register_third_party | 205,611 | 1 | 30.8 / 36.2 |
| registry | update_self | 95,807 | 1 | 29.7 / 36.4 |
| registry | update_deployer (chained) | 107,804 | 1 | 30.2 / 36.7 |
| registry | update_third_party | 166,444 | 1 | 33.0 / 37.5 |
| testimonial | submit | 129,882 | 1 | 27.1 / 31.1 |
| testimonial | register_self | 112,692 | 1 | 32.3 / 32.8 |
| pointer | publish | 122,781 | 1 | 28.5 / 33.3 |
| pointer | register_self | 112,077 | 1 | 33.6 / 33.9 |

All instructions fit a single 128K-cycle segment — comfortably below
`MAX_NUM_CYCLES_PUBLIC_EXECUTION`, and comparable to upstream's cheapest
built-ins (authenticated_transfer ≈ 80K cycles, clock tick ≈ 137K). The
~28–34 ms best-case exec wall time is dominated by the same fixed host-side
per-call overhead (ELF parse + `ExecutorEnv` build) documented upstream
(~30 ms intercept on the reference machine); compute-only time is a few ms.

Note on instruction composition: `register_self`/`update_self` are the
top-level half of the chained-call pattern — they emit a `ChainedCall` to
the registry and pass `entry` through unchanged. The real on-chain cost of
self-registration is `register_self` + `register_deployer` across two
executions (≈ 273K cycles combined for the registry's own entry).

## Reproduce

```bash
cd programs/registry     && cargo run -p registry-examples    --release --bin cycle_bench
cd programs/testimonial  && cargo run -p testimonial-examples --release --bin cycle_bench
cd programs/pointer      && cargo run -p pointer-examples     --release --bin cycle_bench
```

Each bin loads the committed docker-built ELF
(`methods/guest/target/riscv32im-risc0-zkvm-elf/docker/*.bin`) so the
numbers correspond to the deployed image IDs recorded in
`programs/ARTIFACTS.md`.
