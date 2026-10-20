// Chạy lần lượt 4 tình huống. Cần cổng 4001, 4002 đang trống.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
for (const s of ['s1-bank-down.js', 's2-slow-bank.js', 's3-keep-alive.js', 's4-drop-fail-reject.js']) {
  console.log(`\n################ ${s} ################`);
  const r = spawnSync(process.execPath, [path.join(dir, s)], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
