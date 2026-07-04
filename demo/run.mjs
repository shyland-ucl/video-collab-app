// This script covers steps 3–8 of an 8-step pipeline.
// Prerequisites (run once up-front, need live dev servers):
//   Step 1 (b-roll):  npx playwright test -c demo/app/demo-broll.config.mjs
//                     (records app UI against demo/sample.mp4 + writes app/out/markers.json)
//   Step 2 (cards):   node demo/cards/capture.mjs
import { execFileSync } from 'node:child_process'
import { DEMO_DIR } from './lib/paths.mjs'
const run = (cmd, args) => execFileSync(cmd, args, { cwd: DEMO_DIR + '/..', stdio: 'inherit' })
console.log('3/8 calibrate'); run('py', ['-3', 'demo/calibrate.py'])
console.log('4/8 cut');       run('node', ['demo/cut.mjs'])
console.log('5/8 deidentify');run('py', ['-3', 'demo/deidentify.py'])
console.log('6/8 tts');       run('node', ['demo/tts.mjs'])
console.log('7/8 captions');  run('node', ['demo/captions.mjs'])
console.log('8/8 build');     run('node', ['demo/build.mjs'])
console.log('done. Review demo/out/*.contact.jpg before sharing.')
