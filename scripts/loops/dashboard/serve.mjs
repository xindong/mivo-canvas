#!/usr/bin/env node
// bug-doctor 看板静态服务(零依赖,launchd 常驻)。
// 只读服务 <stateDir>/dashboard/ 下的文件,绑定 127.0.0.1,默认 8787。
// 用法: node scripts/loops/dashboard/serve.mjs [--state-dir DIR] [--port N]

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');

let stateDir = join(REPO_ROOT, 'history/loops/bug-doctor');
let port = 8787;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--state-dir') stateDir = resolve(argv[++i]);
  else if (argv[i] === '--port') port = Number(argv[++i]);
}
const root = join(stateDir, 'dashboard');

const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.css': 'text/css', '.js': 'text/javascript' };

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const file = normalize(join(root, rel));
    if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403); return res.end('forbidden'); }
    const st = await stat(file).catch(() => null);
    if (!st || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<meta charset="utf-8">404 — 看板尚未渲染。先跑 <code>node scripts/loops/dashboard/render.mjs</code>');
    }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch (e) {
    res.writeHead(500); res.end(String(e));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[dashboard] serving ${root} at http://127.0.0.1:${port}/`);
});
