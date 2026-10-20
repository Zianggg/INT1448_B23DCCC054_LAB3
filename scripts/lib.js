// Tiện ích dùng chung cho các script đo: chạy/tắt service, gọi HTTP có đo thời gian, lưu report.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPORTS = path.join(ROOT, 'reports');
const LOGS = path.join(REPORTS, 'logs');
fs.mkdirSync(LOGS, { recursive: true });

export const FEE = 'http://localhost:4001';
export const BANK = 'http://localhost:4002';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Chạy một service Node, chờ tới khi in "listening". Log ghi vào reports/logs/<logName>.log */
export function startService(file, env, logName) {
  const out = fs.createWriteStream(path.join(LOGS, `${logName}.log`));
  const proc = spawn(process.execPath, [path.join(ROOT, 'src', file)], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.pipe(out);
  proc.stderr.pipe(out);
  const exited = new Promise((r) => proc.once('exit', (code) => r(code)));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${file} did not start (see ${logName}.log)`)), 8000);
    let buf = '';
    proc.stdout.on('data', function onData(chunk) {
      buf += chunk;
      if (buf.includes('listening')) {
        clearTimeout(timer);
        proc.stdout.off('data', onData);
        resolve({
          proc,
          alive: () => proc.exitCode === null,
          stop: async () => {
            if (proc.exitCode === null) proc.kill();
            await exited;
            out.end();
          },
        });
      }
    });
    proc.once('exit', (code) => { clearTimeout(timer); reject(new Error(`${file} exited with ${code} (see ${logName}.log)`)); });
  });
}

export const startBank = (env, logName) => startService('bank.js', { QUIET: '0', ...env }, logName);
export const startFee = (mode, env, logName) => startService('fee-service.js', { FEE_MODE: mode, QUIET: '1', ...env }, logName);

/** Gọi HTTP, đo thời gian. Không ném lỗi: lỗi mạng trả về status 0. */
export async function call(method, url, body) {
  const t = performance.now();
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
    return { status: res.status, body: json, ms: Math.round(performance.now() - t) };
  } catch (err) {
    return { status: 0, body: { error: err.cause?.code ?? err.message }, ms: Math.round(performance.now() - t) };
  }
}

export const pay = (studentId, amount) => call('POST', `${FEE}/students/${studentId}/payments`, { amount });
export const fees = (studentId) => call('GET', `${FEE}/students/${studentId}/fees`);
export const bankStats = async () => (await call('GET', `${BANK}/stats`)).body;

/** Chạy n tác vụ với tối đa `concurrency` tác vụ cùng lúc. */
export async function pool(n, concurrency, task) {
  const results = new Array(n);
  let next = 0;
  async function worker() {
    while (next < n) {
      const i = next++;
      results[i] = await task(i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export function countBy(xs, key) {
  const out = {};
  for (const x of xs) {
    const k = key(x);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export function saveReport(name, data) {
  const file = path.join(REPORTS, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, ...data }, null, 2));
  console.log(`\n→ saved reports/${name}.json`);
}

export const check = (ok) => (ok ? 'ĐẠT' : 'KHÔNG ĐẠT');
