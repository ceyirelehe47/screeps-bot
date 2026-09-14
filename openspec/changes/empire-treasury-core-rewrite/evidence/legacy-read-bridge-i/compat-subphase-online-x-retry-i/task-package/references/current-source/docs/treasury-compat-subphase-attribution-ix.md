# Compatibility Subphase Attribution IX

This revision adds bounded, diagnostic-only attribution to the existing read-only compatibility capsule. It does not change authorization, persistence, table limits, source selection, business aggregation or the 2 CPU cooperative budget.

## Measurement model

Top-level phase accounting remains the source of total elapsed cost. IX adds nine nested coarse intervals:

- observation setup, room processing, final snapshot freeze, and view construction;
- commitment setup, task processing, reservation processing, and final index/view construction;
- commitment projection rows in the preview.

A builder boundary samples the same injected CPU port already used by the preview. The sampling overhead remains inside both the enclosing top-level phase and the nested interval. Nested intervals therefore must not be added to their parent phase. No estimated probe overhead is removed.

The builders never sample once per task, reservation, resource key, or index query. They emit bounded primitive work counters at the end of the build. Counters describe workload composition and are not CPU weights.

## Preserved boundaries

- The default configuration remains OFF with `maxSampleCpu=2` and window `0..0`.
- The canonical host Treasury sources remain pinned and unmodified.
- VII task buckets, full-table validation, eager secondary indexes, owner/expiry semantics and query results are unchanged.
- Observation still reads actual Stores independently of the direct oracle and legacy Memory projection.
- Every builder, observation, commitment index, metrics object and query cache remains sample-private.
- No subphase result authorizes work or changes cooperative budget checks.

## Attribution limits

Task validation, health predicates, aggregation and route indexing are interleaved in the canonical single task loop. IX measures that loop as one coarse `commitmentTasks` interval and reports bounded composition counters; it does not introduce a second pass merely to manufacture cleaner timing. Reservation owner/expiry processing is similarly one coarse interval.

Observation room processing includes Store enumeration, numeric snapshot creation, freezing and empire-total folding because those operations are interleaved per room. Separate counters expose rooms, locations, existing Stores and non-zero resource keys. The attribution is designed to locate the next optimization region without materially multiplying CPU-port calls.

The first builder call may include shared-definition initialization and remains distinguishable through the existing `readerLoad` phase. IX is not an engine CPU repair and requires a later controlled online capture.
