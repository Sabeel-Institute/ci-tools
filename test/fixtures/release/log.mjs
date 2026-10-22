// Every stand-in tool records how it was called in RELEASE_LOG, one JSON line each.
import { appendFileSync } from 'node:fs';

export function log(tool, extra = {}) {
  const entry = { tool, args: process.argv.slice(2), cwd: process.cwd(), ...extra };
  appendFileSync(process.env.RELEASE_LOG, JSON.stringify(entry) + '\n');
  return entry;
}

