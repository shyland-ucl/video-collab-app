// This script covers steps 3–7 of a 7-step pipeline.
// Prerequisites (run once up-front, need live dev servers):
//   Step 1 (b-roll):  npx playwright test -c demo/app/demo-broll.config.mjs
//   Step 2 (cards):   node demo/cards/capture.mjs
import { execFileSync } from 'node:child_process'
import { DEMO_DIR } from './lib/paths.mjs'
const run = (cmd, args) => execFileSync(cmd, args, { cwd: DEMO_DIR + '/..', stdio: 'inherit' })
console.log('3/7 calibrate'); run('py', ['-3', 'demo/calibrate.py'])
console.log('4/7 cut');       run('node', ['demo/cut.mjs'])
console.log('5/7 deidentify');run('py', ['-3', 'demo/deidentify.py'])
console.log('6/7 captions');  run('node', ['demo/captions.mjs'])
console.log('7/7 build');     run('node', ['demo/build.mjs'])
console.log('done. Review demo/out/*.contact.jpg before sharing.')
