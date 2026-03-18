#!/usr/bin/env node
// Generates a shareable strudel.cc URL from a pattern file.
// Usage: node strudel-link.js <pattern-file.js> [--base-url URL]
//
// Encoding matches strudel's own embed.js: encodeURIComponent(btoa(code))

import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
let filePath = null;
let baseUrl = 'https://strudel.cc/';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--base-url' && args[i + 1]) {
    baseUrl = args[++i];
  } else if (!filePath) {
    filePath = args[i];
  }
}

if (!filePath) {
  console.error('Usage: node strudel-link.js <pattern-file.js> [--base-url URL]');
  process.exit(1);
}

const resolved = path.resolve(filePath);
if (!fs.existsSync(resolved)) {
  console.error(`File not found: ${resolved}`);
  process.exit(1);
}

const code = fs.readFileSync(resolved, 'utf-8');
const hash = encodeURIComponent(Buffer.from(code).toString('base64'));
const url = `${baseUrl.replace(/\/$/, '')}/#${hash}`;

console.log(url);
