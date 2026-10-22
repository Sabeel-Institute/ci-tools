import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The id the debug build installs as: app.json's Android package, plus the
 * applicationIdSuffix build.gradle's debug build type gives it, where it gives
 * one (Kanban's debug build installs beside its release build that way).
 */
export function debugAppId(root = '.') {
  const app = JSON.parse(readFileSync(join(root, 'app/app.json'), 'utf8')).expo;
  const gradle = readFileSync(join(root, 'app/android/app/build.gradle'), 'utf8');
  const types = gradle.slice(Math.max(0, gradle.search(/^\s*buildTypes\s*\{/m)));
  const start = types.search(/^\s*debug\s*\{/m);
  if (start < 0) return app.android.package;
  let depth = 0;
  let end = types.indexOf('{', start);
  for (; end < types.length; end++) {
    if (types[end] === '{') depth++;
    else if (types[end] === '}' && --depth === 0) break;
  }
  const debug = types.slice(start, end);
  return app.android.package + (/applicationIdSuffix\s+["']([^"']+)["']/.exec(debug)?.[1] ?? '');
}
