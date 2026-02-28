#!/usr/bin/env node
/**
 * Simple dev server that:
 * 1. Serves static files (index.html)
 * 2. Proxies /v1/* requests to the OpenClaw gateway (bypasses CORS)
 *
 * Usage: node server.js [port] [gateway-url]
 * Default: port=3000, gateway=http://localhost:18789
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.argv[2]) || 3000;
const GATEWAY = process.argv[3] || 'http://localhost:18789';

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  // Proxy /v1/* and /tools/* to gateway
  if (req.url.startsWith('/v1/') || req.url.startsWith('/tools/')) {
    return proxy(req, res);
  }

  // Static files
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

function proxy(req, res) {
  const url = new URL(req.url, GATEWAY);

  const opts = {
    hostname: url.hostname,
    port: url.port,
    path: url.pathname + url.search,
    method: req.method,
    headers: { ...req.headers, host: url.host },
  };

  const proxyReq = http.request(opts, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('Proxy error:', err.message);
    res.writeHead(502);
    res.end(JSON.stringify({ error: { message: 'Gateway proxy error: ' + err.message } }));
  });

  req.pipe(proxyReq);
}

server.listen(PORT, () => {
  console.log(`\n  🔌 OpenClaw API POC Server`);
  console.log(`  ├─ UI:      http://localhost:${PORT}`);
  console.log(`  ├─ Proxy:   /v1/* → ${GATEWAY}/v1/*`);
  console.log(`  └─ Gateway: ${GATEWAY}\n`);
});
