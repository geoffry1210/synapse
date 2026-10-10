/**
 * test/run.js
 * -----------------------------------------------------------------------
 * Runs every demo-*.js script at the repo root as its own process and
 * reports which ones completed vs threw — AND checks each one's own
 * stdout for a standalone "FAIL" line (demo-strategy-refinement.js's
 * self-reporting convention: console.log(cond ? 'PASS' : 'FAIL')).
 * Without that second check, a demo whose own assertions fail but which
 * never throws or calls process.exit(1) still reported "ok" here —
 * found the hard way when demo-strategy-refinement.js's Test 4 had been
 * silently printing FAIL for a while with the overall suite still green.
 *
 * These are integration demos (mocked pools/adapters, no real
 * credentials needed) written during development — not a from-scratch
 * assertion framework, so this stays a light check on top of whatever
 * self-reporting convention a given demo already uses, not a demand
 * that every demo adopt one. Wired up here so `npm test` actually runs
 * them instead of the previous no-op stub.
 * -----------------------------------------------------------------------
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const demos = fs.readdirSync(root).filter((f) => /^demo-.*\.js$/.test(f)).sort();

let failed = 0;
for (const file of demos) {
  process.stdout.write(`-> ${file} ... `);
  try {
    const stdout = execFileSync('node', [file], { cwd: root, stdio: 'pipe', timeout: 30_000 }).toString();
    const failLines = stdout.split('\n').filter((line) => line.trim() === 'FAIL');
    if (failLines.length > 0) {
      failed++;
      console.log(`FAILED (${failLines.length} self-reported FAIL line${failLines.length > 1 ? 's' : ''})`);
    } else {
      console.log('ok');
    }
  } catch (e) {
    failed++;
    console.log('FAILED');
    console.error((e.stderr || e.message || String(e)).toString().trim());
  }
}

console.log(`\n${demos.length - failed}/${demos.length} demos ran clean.`);
if (failed > 0) process.exit(1);
