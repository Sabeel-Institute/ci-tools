import { execFileSync } from 'node:child_process';
import { readlinkSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Refuse to start when port 8081 belongs to another project's Metro.
 *
 *   sabeel-ci preflight-metro && expo start
 *
 * The Android emulator reaches Metro at 10.0.2.2:8081, the host's port 8081
 * directly: `adb reverse` does not intercept that, and Metro's port cannot move
 * without rebuilding the native app. So whoever holds 8081 serves this app. A
 * Metro left running by another of this machine's React Native projects serves
 * its own bundle: the Gradle build and the install succeed, and the app boots to
 * a red screen full of the other repository's module paths, easily misread as a
 * bug here. Fail loudly instead.
 *
 * Fails closed: a holder whose working directory cannot be read (another user's
 * process) counts as foreign. A guard whose failure mode is "all clear" guards
 * nothing.
 */
export const PORT = 8081;
const MAC = process.platform === 'darwin';
const output = (program, args) => execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const unique = (values) => [...new Set(values)];

/** Process ids listening on `port`. */
export function pidsOnPort(port) {
  // macOS has neither `ss` nor /proc, so lsof answers there; it exits 1 when
  // nothing listens. Elsewhere `ss`, not lsof: lsof is not on PATH in a
  // non-interactive shell without the toolchain's environment, and its absence
  // read as "nothing listening" turned the guard into a no-op.
  try {
    if (MAC) return unique(output('lsof', ['-nP', '-ti', `TCP:${port}`, '-sTCP:LISTEN']).split('\n').filter(Boolean));
    return unique(output('ss', ['-lptn', `sport = :${port}`]).split('\n').flatMap((line) => line.match(/pid=(\d+)/g) ?? [])
      .map((match) => match.slice(4)));
  } catch {
    return [];
  }
}

/** A process's working directory, or null when it cannot be read. */
export function cwdOf(pid) {
  try {
    if (MAC) return output('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn']).split('\n').find((line) => line.startsWith('n'))?.slice(1) || null;
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

/** The holders not running inside `appDirectory` (a real path), with their working directories. */
export function foreignHolders(pids, appDirectory, directoryOf = cwdOf) {
  return pids.map((pid) => ({ pid, cwd: directoryOf(pid) }))
    .filter(({ cwd }) => cwd === null || (cwd !== appDirectory && !cwd.startsWith(appDirectory + sep)));
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) {
    console.error('usage: sabeel-ci preflight-metro');
    process.exit(2);
  }
  // The real path: on macOS a checkout is reachable both as /Users/… and as
  // /Volumes/<disk>/Users/…, and lsof reports a working directory by its real path.
  const foreign = foreignHolders(pidsOnPort(PORT), realpathSync('app'));
  if (foreign.length) {
    console.error(`\nPort ${PORT} is held by a Metro from another project:\n`);
    for (const { pid, cwd } of foreign) console.error(`    pid ${pid}  ${cwd ?? '(working directory unreadable: another user’s process)'}`);
    console.error(`\n  The Android emulator reaches Metro at 10.0.2.2:${PORT}, so that server would\n`
      + '  serve its bundle to this app, and the red screen that follows misleads.\n\n'
      + `  Stop it first (in that project's terminal), or:  kill ${foreign.map(({ pid }) => pid).join(' ')}\n`);
    process.exit(1);
  }
}
