import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { CONTRACT } from '../src/contract.js';

function files(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(f => f.isDirectory() ? files(join(dir, f.name)) : [join(dir, f.name)]); }
for (const file of ['src', 'bin', 'scripts', 'test', 'examples'].flatMap(files).filter(f => /\.m?js$/.test(f))) execFileSync(process.execPath, ['--check', file]);
const schema = JSON.parse(readFileSync('spec/domains-v1.json', 'utf8'));
assert.deepEqual(schema, CONTRACT, 'Run node bin/domain-rails.mjs schemas > spec/domains-v1.json after changing contracts');
const pkg = JSON.parse(readFileSync('package.json', 'utf8')), lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies, 'package-lock is out of date');
assert.equal(new Set(CONTRACT.map(c => c.capability_id)).size, CONTRACT.length);
console.log('Syntax, capability schema and dependency lock checks passed.');
