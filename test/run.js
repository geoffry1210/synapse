/**
 * test/run.js
 * -----------------------------------------------------------------------
 * Runs every demo-*.js script at the repo root as its own process and
 * reports which ones completed vs threw. These are integration demos
 * (mocked pools/adapters, no real credentials needed) written during
 * development — not assertion-based unit tests, so a "pass" here means
 * "ran without crashing," not "verified correct behavior." Wired up here
 * so \`npm test\` actually runs them instead of the previous no-op stub.
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
    execFileSync('node', [file], { cwd: root, stdio: 'pipe', timeout: 30_000 });
    console.log('ok');
  } catch (e) {
    failed++;
    console.log('FAILED');
    console.error((e.stderr || e.message || String(e)).toString().trim());
  }
}

console.log(`\n${demos.length - failed}/${demos.length} demos ran clean.`);
if (failed > 0) process.exit(1);
