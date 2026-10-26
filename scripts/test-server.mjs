import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

/** Start a directly owned Node process, with a unique DB and an OS-assigned port. */
export async function startTestServer(out) {
  const dir = mkdtempSync(join(out, 'run-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: { ...process.env, PORT: process.env.E2E_PORT || '0', ANANT_DB: join(dir, 'worlds.db'), ANANT_OFFLINE: '1' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      child.once('exit', resolve);
      child.kill();
    });
  };
  try {
    const url = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Test server did not start within 30 seconds')), 30000);
      let output = '';
      const finish = (fn, value) => { clearTimeout(timeout); fn(value); };
      child.once('error', e => finish(reject, e));
      child.once('exit', code => finish(reject, new Error(`Test server exited: ${code}`)));
      child.stdout.on('data', data => {
        process.stdout.write(data);
        output += data;
        const match = output.match(/server on (http:\/\/localhost:\d+)/);
        if (match) finish(resolve, match[1]);
      });
      child.stderr.on('data', data => process.stderr.write(data));
    });
    const health = await fetch(`${url}/api/health`).then(r => r.json());
    if (health.ai.mode !== 'offline-parser') throw new Error('Tests must use the offline parser');
    return { url, stop };
  } catch (error) { await stop(); throw error; }
}
