import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, declared } from '../lib/config.mjs';

/**
 * The shared workflows, rendered into an app repository.
 *
 *   sabeel-ci workflows           # write .github/workflows/<name>.yml from workflows/<name>.yml
 *   sabeel-ci workflows --check   # fail if any of them differs, is missing, or is left over
 *   node scripts/workflows.mjs --to <dir> --config <file>   # ci-tools' own lint
 *
 * The templates live here; the rendered files live in each app, because GitHub
 * runs only what is in the repository, and because a change to a workflow should
 * show in that app's pull request.
 *
 * A template may say three things about the app it is rendered for:
 *   # ci-tools: <partial>            replaced by workflows/partials/<partial>.yml,
 *                                    at the line's indentation
 *   # ci-tools: <partial> if <key>   the same, when ci-tools.json's <key> is set
 *                                    and true (`if !<key>`: when it is not)
 *   {{ci-tools.<key>}}               ci-tools.json's <key>; a string as it is,
 *                                    anything else as JSON
 * Keys are dotted paths, and must be declared in lib/config.mjs.
 */
const TEMPLATES = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'workflows');
const TARGET = '.github/workflows';
const MARK = '# Rendered from Sabeel-Institute/ci-tools';

export const header = (name) => `${MARK} workflows/${name} by\n# \`npx sabeel-ci workflows\`: edit it there, not here.\n`;

const lookup = (settings, path) => path.split('.').reduce((value, key) => value?.[key], settings);

function known(path) {
  if (!declared(path)) throw new Error(`a workflow template names ci-tools.${path}, which lib/config.mjs does not declare`);
  return path;
}

export function expand(text, partial, settings) {
  const included = text.replace(/^( *)# ci-tools: ([a-z0-9-]+)(?: if (!?)([A-Za-z0-9.]+))?\n/gm, (_, indent, name, not, path) => {
    if (path !== undefined && Boolean(lookup(settings, known(path))) === (not === '!')) return '';
    return expand(partial(name), partial, settings).trimEnd().split('\n')
      .map((line) => (line ? indent + line : line)).join('\n') + '\n';
  });
  return included.replace(/\{\{ci-tools\.([A-Za-z0-9.]+)\}\}/g, (_, path) => {
    const value = lookup(settings, known(path));
    if (value === undefined) throw new Error(`a workflow template needs ci-tools.${path}, which ci-tools.json does not set`);
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

/** Every template, rendered for an app's settings: file name to text. */
export function renderAll(settings, templates = TEMPLATES) {
  const partial = (name) => {
    const path = join(templates, 'partials', `${name}.yml`);
    if (!existsSync(path)) throw new Error(`no partial ${name} (workflows/partials/${name}.yml)`);
    return readFileSync(path, 'utf8');
  };
  return new Map(readdirSync(templates).filter((name) => name.endsWith('.yml')).sort()
    .map((name) => [name, header(name) + expand(readFileSync(join(templates, name), 'utf8'), partial, settings)]));
}

/** What `--check` would report for the app at `root`: one line per problem. */
export function drift(root, rendered = renderAll(config(root))) {
  const problems = [];
  for (const [name, text] of rendered) {
    const path = join(root, TARGET, name);
    if (!existsSync(path)) problems.push(`${TARGET}/${name} is missing`);
    else if (readFileSync(path, 'utf8') !== text) problems.push(`${TARGET}/${name} differs from ci-tools workflows/${name}`);
  }
  const directory = join(root, TARGET);
  for (const name of existsSync(directory) ? readdirSync(directory) : []) {
    if (!rendered.has(name) && readFileSync(join(directory, name), 'utf8').startsWith(MARK)) {
      problems.push(`${TARGET}/${name} was rendered from a template ci-tools no longer has`);
    }
  }
  return problems;
}

function main(args) {
  const usage = 'usage: sabeel-ci workflows [--check]  |  node scripts/workflows.mjs --to <dir> --config <file>';
  if (args[0] === '--to') {
    if (args.length !== 4 || !args[1] || args[2] !== '--config' || !args[3]) throw new Error(usage);
    const rendered = renderAll(JSON.parse(readFileSync(args[3], 'utf8')));
    mkdirSync(args[1], { recursive: true });
    for (const [name, text] of rendered) writeFileSync(join(args[1], name), text);
    return;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) throw new Error(usage);
  const rendered = renderAll(config());
  if (args[0] === '--check') {
    const problems = drift('.', rendered);
    if (problems.length) {
      console.error(problems.join('\n') + '\nRun `npx sabeel-ci workflows` and commit the result.');
      process.exit(1);
    }
    console.log(`${rendered.size} workflows match ci-tools`);
    return;
  }
  mkdirSync(TARGET, { recursive: true });
  for (const [name, text] of rendered) writeFileSync(join(TARGET, name), text);
  console.log(`wrote ${[...rendered.keys()].map((name) => `${TARGET}/${name}`).join(', ')}`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}
