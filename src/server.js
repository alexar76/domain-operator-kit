import { openSync, readFileSync, writeFileSync, closeSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { configuredService } from './config.js';
import { createHttpServer } from './http.js';

// One process per durable store. Horizontal scale means independent seller nodes/databases.
const dir = resolve(process.env.DOMAIN_DATA_DIR || './data'); mkdirSync(dir, { recursive: true, mode: 0o700 });
const lock = join(dir, 'server.lock');
// Linux containers reuse PIDs on restart. Include boot/process-start identity so a stale PID 1
// lock does not look like the freshly started seller. Other platforms fail closed on PID reuse.
const identity = pid => {
  try { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); return `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`; }
  catch { return null; }
};
try {
  const saved = JSON.parse(readFileSync(lock, 'utf8')), old = typeof saved === 'number' ? saved : saved.pid;
  if (!Number.isInteger(old) || old <= 0) throw Error('invalid lock file; operator inspection required');
  try {
    process.kill(old, 0);
    const current = identity(old);
    if (saved.identity && current && saved.identity !== current) unlinkSync(lock);
    else throw Error('domain seller already running');
  }
  catch (error) { if (error.code === 'ESRCH') unlinkSync(lock); else throw error; }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const fd = openSync(lock, 'wx', 0o600); writeFileSync(fd, JSON.stringify({ pid: process.pid, identity: identity(process.pid) })); closeSync(fd);
let service;
try { service = await configuredService(); } catch (error) { unlinkSync(lock); throw error; }
const server = createHttpServer(service);
let timer, stopped = false, reconciliation = null;
const tick = () => { reconciliation ??= service.reconcileAll().finally(() => { reconciliation = null; }); return reconciliation; };
const stop = async () => {
  if (stopped) return; stopped = true; clearInterval(timer);
  await new Promise(resolve => server.close(resolve)); await reconciliation;
  service.store.close(); unlinkSync(lock);
};
process.once('SIGINT', stop); process.once('SIGTERM', stop);
server.once('error', async error => { console.error(`domain seller listen failed: ${error.code}`); await stop(); process.exitCode = 1; });
server.listen(Number(process.env.PORT || 9495), process.env.HOST || '127.0.0.1', () => {
  console.log(`domain seller listening; mode=${service.mode}; supplier=${service.provider.kind}; fixed markup=${service.markupUsd} USD`);
  tick(); timer = setInterval(tick, 30000); timer.unref();
});
