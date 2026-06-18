import { execFileSync } from 'node:child_process'
import { DEMO_DIR } from './lib/paths.mjs'
const run = (cmd, args) => execFileSync(cmd, args, { cwd: DEMO_DIR + '/..', stdio: 'inherit' })
console.log('1/5 calibrate'); run('py', ['-3', 'demo/calibrate.py'])
console.log('2/5 cut');       run('node', ['demo/cut.mjs'])
console.log('3/5 deidentify');run('py', ['-3', 'demo/deidentify.py'])
console.log('4/5 captions');  run('node', ['demo/captions.mjs'])
console.log('5/5 build');     run('node', ['demo/build.mjs'])
console.log('done. Review demo/out/*.contact.jpg before sharing.')
// NOTE: run the app b-roll (Task 6) and cards (Task 7) once up-front; they are not
// re-run here because they need live dev servers / are stable between runs.
