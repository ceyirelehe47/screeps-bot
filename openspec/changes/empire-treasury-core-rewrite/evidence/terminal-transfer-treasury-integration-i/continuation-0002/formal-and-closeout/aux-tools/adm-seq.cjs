#!/usr/bin/env node
'use strict';
// Lab-only: run a file of CLI expressions sequentially on ONE connection.
// Blank lines and lines starting with '#' are skipped. Prints each expression
// and its response, so the raw output is a complete record of the fixture write.
// Usage: node adm-seq.cjs <expressions-file>
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const file = process.argv[2];
if (!file) { console.error('usage: adm-seq.cjs <expressions-file>'); process.exit(2); }
const expressions = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  .map(line => line.trim()).filter(line => line && !line.startsWith('#'));
if (!expressions.length) { console.error('no expressions in ' + file); process.exit(2); }
const args = [__dirname + '/adm-cli.cjs', ...expressions];
execFileSync(process.execPath, args, { stdio: 'inherit' });
