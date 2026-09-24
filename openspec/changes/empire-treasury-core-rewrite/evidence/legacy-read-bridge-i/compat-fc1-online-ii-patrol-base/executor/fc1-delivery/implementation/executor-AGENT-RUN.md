# FC1 Final Executor

This assembled executor is offline-ready and online-disabled. Its policy contains `newRoundAuthorization.status = WAITING_FOR_EXPLICIT_AUTHORIZATION`, null new authorization identifiers, and `onlineExecutionReady = false`.

Run the offline executor tests with Node 22:

```sh
node tools/run-tests.cjs --out /path/outside/this/executor
```

The supported full-run entry and the direct observe entry both stop before network access or marker creation until a separately authorized package has a new authorizationId and runId. The historical FC1 identifiers embedded for provenance must not be reused. Do not run the old observe invocation or any collector/worker from an older package.

FC1 measurement policy is fixed at exposure ceiling 10 CPU, reserve 25 CPU, native entry headroom 55 CPU, minBucket 2000, four points separated by 100 ticks, rooms E3N59/E4N58 and energy/H. There is no performance target and this policy grants no production quota.

The executor reads only the compatibility preview. It does not authorize business actions, change the production writer, enable Treasury, or modify the generated Core.
