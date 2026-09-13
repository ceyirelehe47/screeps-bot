'use strict';
/** Offline authoring transform, never imported by the game.
 * Convert ONLY private module-captured inputs to explicit per-builder arguments.
 * Aggregation, validation, owner, expiry, completeness and all query bodies remain
 * the canonical compiler output modulo these reversible substitutions.
 */
const START = '"src/runtime/treasury/commitments.ts": function(exports, require) {\n';
const END = '\n},\n"src/runtime/treasury/holderResolution.ts": function';
const EDGE = '    "@/runtime/treasury/commitmentRevision": "src/runtime/treasury/commitmentRevision.ts",\n';
const RULES = [
  ['revision-import', 'const commitmentRevision_1 = require("@/runtime/treasury/commitmentRevision");', '// V: revision supplied by the private read-only sample context.', 1],
  ['catalog-capture', 'const VALID_RESOURCES_FOR_COMMITMENT = new Set(RESOURCES_ALL);', '// V: catalog captured once per builder, not at shared module initialization.', 1],
  ['task-validator-context', 'isValidTreasuryTransferTaskForCommitment(task)', 'isValidTreasuryTransferTaskForCommitment(task, compatContext)', 2],
  ['reservation-validator-context', 'isValidReservationForCommitment(entry)', 'isValidReservationForCommitment(entry, compatContext)', 2],
  ['builder-context', 'function buildTreasuryCommitmentIndex(options)', 'function buildTreasuryCommitmentIndex(options, compatContext)', 1],
  ['revision-value', '(0, commitmentRevision_1.readTreasuryCommitmentRevision)()', 'compatContext.revision', 1],
  ['catalog-lookup', 'VALID_RESOURCES_FOR_COMMITMENT.has(', 'compatContext.resources.has(', 4],
];
function check(ok, code) { if (!ok) { const e = new Error(code); e.code = code; throw e; } }
function region(text) {
  const a = text.indexOf(START), b = text.indexOf(END, a + START.length);
  check(a > 0 && b > a && text.indexOf(START, a + START.length) < 0, 'COMMITMENT_REGION_INVALID');
  return [a, b];
}
function replaceCount(s, a, b, count, code) {
  check(s.split(a).length - 1 === count, 'CONTEXT_TRANSFORM_COUNT:' + code);
  return s.split(a).join(b);
}
function transform(prefix) {
  const [a, b] = region(prefix); let body = prefix.slice(a, b);
  for (const [name, before, after, count] of RULES) body = replaceCount(body, before, after, count, name);
  const out = replaceCount(prefix.slice(0, a) + body + prefix.slice(b), EDGE,
    '    // V: no mutable revision module imported by the shared read definitions.\n', 1, 'dependency-edge');
  check(restore(out) === prefix, 'CONTEXT_TRANSFORM_NOT_REVERSIBLE');
  return out;
}
function restore(prefix) {
  const [a, b] = region(prefix); let body = prefix.slice(a, b);
  for (const [name, before, after, count] of [...RULES].reverse()) body = replaceCount(body, after, before, count, name);
  return replaceCount(prefix.slice(0, a) + body + prefix.slice(b),
    '    // V: no mutable revision module imported by the shared read definitions.\n', EDGE, 1, 'dependency-edge');
}
module.exports = { transform, restore, region, rules: RULES.map(([name, , , count]) => ({ name, replacements: count })) };
