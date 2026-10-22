import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../lib/config.mjs';
import { emulatorProject, ports, suitePorts } from '../lib/ports.mjs';

/**
 * The app's emulator and dev-server ports (lib/ports.mjs), for shell scripts
 * and people: the one place a port is read from, so no script states one.
 *
 *   sabeel-ci ports            # every port and its name, one per line
 *   sabeel-ci ports <name>     # one port: WEB_PORT=$(npx --no sabeel-ci ports web)
 *   sabeel-ci ports --suite    # what an emulator run binds, which free-emulator-ports frees
 *   sabeel-ci ports --project  # the emulators' project, demo-sabeel-<name>
 */
function main(args) {
  const settings = config();
  const all = ports(settings);
  if (args.length === 0) {
    for (const [name, port] of Object.entries(all).sort(([, a], [, b]) => a - b)) console.log(`${port} ${name}`);
    return;
  }
  if (args.length === 1 && args[0] === '--suite') {
    console.log(suitePorts(settings).join(' '));
    return;
  }
  if (args.length === 1 && args[0] === '--project') {
    console.log(emulatorProject(settings));
    return;
  }
  if (args.length === 1 && Object.hasOwn(all, args[0])) {
    console.log(all[args[0]]);
    return;
  }
  throw new Error(args.length === 1 && !args[0].startsWith('-')
    ? `no port named ${args[0]}; the names are ${Object.keys(all).join(', ')}`
    : 'usage: sabeel-ci ports [<name> | --suite | --project]');
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`sabeel-ci ports: ${error.message}`);
    process.exit(2);
  }
}
