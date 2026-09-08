const fs = require('fs');
const file = process.argv[2];
const j = JSON.parse(fs.readFileSync(file, 'utf8'));
console.log('numTotalTestSuites=' + j.numTotalTestSuites);
console.log('numTotalTests=' + j.numTotalTests);
console.log('numPassedTests=' + j.numPassedTests);
console.log('numFailedTests=' + j.numFailedTests);
console.log('numPendingTests=' + j.numPendingTests);
console.log('numRuntimeErrorTestSuites=' + (j.numRuntimeErrorTestSuites || 0));
console.log('success=' + j.success);
for (const r of j.testResults) {
  const short = r.name.split(/[\\/]/).slice(-2).join('/');
  console.log('SUITE ' + r.status + ' tests=' + r.assertionResults.length + ' ' + short);
}
