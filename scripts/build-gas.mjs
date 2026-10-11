// Copies parser.js into the Apps Script project as Parser.gs (Apps Script has no ES modules).
// Run after every parser change: npm run build:gas
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync(new URL('../parser.js', import.meta.url), 'utf8');
const out = '// GENERATED from parser.js by scripts/build-gas.mjs. Do not edit here.\n\n' +
  src.replace(/^export /gm, '');
writeFileSync(new URL('../gmail-inbox/Parser.gs', import.meta.url), out);
console.log('wrote gmail-inbox/Parser.gs');
