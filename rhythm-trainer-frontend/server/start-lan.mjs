import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const port = process.env.PORT || '8788';
console.log('电脑需保持运行，琴仍连接电脑。iPad 与电脑需网络互通。');
for (const addresses of Object.values(os.networkInterfaces())) {
  for (const address of addresses ?? []) {
    if (address.family === 'IPv4' && !address.internal) console.log(`iPad 连接地址：http://${address.address}:${port}`);
  }
}
const child = spawn(process.execPath, [fileURLToPath(new URL('./engine-server.mjs', import.meta.url))], {
  stdio: 'inherit', env: { ...process.env, HOST: '0.0.0.0' },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => { console.error('服务启动失败：', error.message); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
