import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The shared workflows, rendered into an app repository.
 *
 *   sabeel-ci workflows           # write .github/workflows/<name>.yml from workflows/<name>.yml
 *   sabeel-ci workflows --check   # fail if any of them differs, is missing, or is left over
 *   node scripts/workflows.mjs --to <dir>   # render into <dir> (ci-tools' own lint)
 *
 * The templates live here; the rendered files live in each app, because GitHub
 * runs only what is in the repository, and because a change to a workflow should
 * show in that app's pull request. A line `# ci-tools: <partial>` is replaced by
 * workflows/partials/<partial>.yml at the line's indentation.
 */
const TEMPLATES = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'workflows');
const TARGET = '.github/workflows';
const MARK = '# Rendered from Sabeel-Institute/ci-tools';

export const header = (name) => `${MARK} workflows/${name} by\n# \`npx sabeel-ci workflows\`: edit it there, not here.\n`;

export function expand(text, partial) {
  return text.replace(/^( *)# ci-tools: ([a-z0-9-]+)\n/gm, (_, indent, name) => partial(name).trimEnd().split('\n')
    .map((line) => (line ? indent + line : line)).join('\n') + '\n');
}

/** Every template, rendered: file name to text. */
export function renderAll(templates = TEMPLATES) {
  const partial = (name) => {
    const path = join(templates, 'partials', `${name}.yml`);
    if (!existsSync(path)) throw new Error(`no partial ${name} (workflows/partials/${name}.yml)`);
    return readFileSync(path, 'utf8');
  };
  return new Map(readdirSync(templates).filter((name) => name.endsWith('.yml')).sort()
    .map((name) => [name, header(name) + expand(readFileSync(join(templates, name), 'utf8'), partial)]));
}

/** What `--check` would report for the app at `root`: one line per problem. */
export function drift(root, rendered = renderAll()) {
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
  const usage = 'usage: sabeel-ci workflows [--check | --to <dir>]';
  if (args.length > 2 || (args.length === 1 && args[0] !== '--check') || (args.length === 2 && (args[0] !== '--to' || !args[1]))) {
    throw new Error(usage);
  }
  const rendered = renderAll();
  if (args[0] === '--to') {
    mkdirSync(args[1], { recursive: true });
    for (const [name, text] of rendered) writeFileSync(join(args[1], name), text);
    return;
  }
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
