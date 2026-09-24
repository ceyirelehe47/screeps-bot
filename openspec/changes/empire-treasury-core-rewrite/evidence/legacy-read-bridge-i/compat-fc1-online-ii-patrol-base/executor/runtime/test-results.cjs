'use strict';

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function zeroFailureCounts(group) {
  return [group.failed, group.skipped, group.todo, group.cancelled]
    .every((count) => Number.isSafeInteger(count) && count === 0);
}

function validGroup(group, expectedFiles, minTests, exactTests) {
  if (!group || !same(group.files, expectedFiles)) return false;
  if (!Number.isSafeInteger(group.tests) || group.tests <= 0) return false;
  if (group.tests < minTests || (exactTests !== undefined && group.tests !== exactTests)) return false;
  if (group.passed !== group.tests || !zeroFailureCounts(group)) return false;
  return true;
}

function validate(result, contract, fingerprint) {
  if (!result || result.kind !== 'full-cost-FC1-final-executor-tests-result/v2') return false;
  if (result.status !== 'FC1_FINAL_EXECUTOR_VERIFIED' || result.onlineAttempted !== false) return false;
  if (result.packageFingerprint !== fingerprint) return false;
  if (!contract || contract.kind !== 'full-cost-FC1-final-executor-tests/v1') return false;
  const requiredGroups = ['legacyRiskRegressions', 'finalFc1Composition'];
  if (!result.groups || !same(Object.keys(result.groups).sort(), requiredGroups.slice().sort())) return false;

  const legacy = result.groups.legacyRiskRegressions;
  const fc1 = result.groups.finalFc1Composition;
  if (!validGroup(legacy, contract.legacySpecFiles, contract.minimumLegacyTests)) return false;
  if (!validGroup(fc1, contract.fc1ExecutorSpecFiles, contract.fc1ExecutorTests, contract.fc1ExecutorTests)) return false;

  const expected = {
    tests: legacy.tests + fc1.tests,
    passed: legacy.passed + fc1.passed,
    failed: legacy.failed + fc1.failed,
    skipped: legacy.skipped + fc1.skipped,
    todo: legacy.todo + fc1.todo,
    cancelled: legacy.cancelled + fc1.cancelled,
  };
  return Object.entries(expected).every(([key, value]) => result[key] === value);
}

module.exports = { validGroup, validate };
