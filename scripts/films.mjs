#!/usr/bin/env node
/**
 * sabeel-ci films <lines|tts|asr|record|publish> — the app's help films.
 *
 *   sabeel-ci films lines                         every line of narration, as JSON
 *   sabeel-ci films tts --wav <dir> [--threads N] render the narration (one WAV a line)
 *   sabeel-ci films asr --wav <dir> [--only id,id] transcribe it and compare with the script
 *   sabeel-ci films record --wav <dir> --out <dir> [--only film,film] [--variant phone|computer]
 *   sabeel-ci films publish --from <dir>          every film, both cuts and captions, to the help site
 *
 * The app names its films module and its help site in ci-tools.json (`films`);
 * the module (lib/films/record.mjs, `checkFilms`) holds the catalogue, the
 * scripts, the stack and world to film in, and the off-camera sign-in.
 *
 * HEAVY: the narration model peaks near 12 GB and the speech check near 3 GB,
 * so neither runs beside an emulator stack or an Android emulator on a 15 GB
 * machine. Rendering takes about six seconds of CPU per second of speech, and
 * a line whose WAV was rendered from the same words is skipped, so a run
 * resumes. Recording runs in real time, twice per film.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../lib/config.mjs';
import { checkFilms, linesOf, recordFilms } from '../lib/films/record.mjs';

const TOOLS = process.env.CI_TOOLS ?? resolve(import.meta.dirname, '..');
const [task, ...rest] = process.argv.slice(2);
const args = Object.fromEntries(rest.reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const usage = 'usage: sabeel-ci films lines | tts --wav <dir> | asr --wav <dir> | record --wav <dir> --out <dir> [--only a,b] [--variant v] | publish --from <dir>';

const settings = config('.');
if (!settings.films) {
  console.error('ci-tools.json has no films section: name the films module and the help site there');
  process.exit(2);
}
if (!['lines', 'tts', 'asr', 'record', 'publish'].includes(task)) {
  console.error(usage);
  process.exit(2);
}
const mod = (await import(pathToFileURL(resolve(settings.films.module)).href)).default;
const problems = checkFilms(mod);
if (problems.length) {
  console.error(`the films module is not ready:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

/** A temporary lines.json, for the Python tools. */
function linesFile() {
  const dir = mkdtempSync(join(tmpdir(), 'films-lines-'));
  const file = join(dir, 'lines.json');
  writeFileSync(file, `${JSON.stringify(linesOf(mod.films), null, 2)}\n`);
  return file;
}

/** A Python tool of this package, run by uv with the dependencies pinned in it. */
function uv(script, toolArgs) {
  const r = spawnSync('uv', ['run', '--script', join(TOOLS, 'lib', 'films', script), ...toolArgs], { stdio: 'inherit' });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

const need = (name) => {
  if (!args[name]) {
    console.error(usage);
    process.exit(2);
  }
  return resolve(args[name]);
};

if (task === 'lines') {
  process.stdout.write(`${JSON.stringify(linesOf(mod.films), null, 2)}\n`);
} else if (task === 'tts') {
  const threads = args.threads ?? '8';
  if (!/^[1-9]\d*$/.test(threads)) {
    console.error('--threads must be a whole number of at least 1');
    process.exit(2);
  }
  process.exit(uv('tts.py', ['--model', '1.7B', '--speaker', 'aiden', '--lines', linesFile(), '--out', need('wav'), '--threads', threads]));
} else if (task === 'asr') {
  process.exit(uv('asr_check.py', ['--lines', linesFile(), '--wav', need('wav'), ...(args.only ? ['--only', args.only] : [])]));
} else if (task === 'record') {
  const only = new Set((args.only ?? '').split(',').filter(Boolean));
  for (const id of only) {
    if (!mod.films.some((f) => f.id === id)) {
      console.error(`--only names no film: ${id}`);
      process.exit(2);
    }
  }
  if (args.variant && !mod.variants.includes(args.variant)) {
    console.error(`--variant must be one of ${mod.variants.join(', ')}, not ${args.variant}`);
    process.exit(2);
  }
  const failures = await recordFilms(mod, { wavDir: need('wav'), outDir: need('out'), only, variant: args.variant });
  process.exit(failures ? 1 : 0);
} else {
  await publish(need('from'));
}

/**
 * PUBLISH to the help site: every film's MP4 and captions, both cuts, in one
 * deploy. A Hosting deploy replaces the whole site, so it takes the WHOLE set or
 * nothing. The site is not the app's, so the app's own deploys never touch the
 * films, and the films, which are not in git, never ride along with the app. It
 * answers every origin (`Access-Control-Allow-Origin: *`): the website's
 * `<video>` loads its caption track under CORS. After the deploy each file is
 * fetched back and its size compared, so a film that did not land fails here
 * rather than on someone's phone.
 */
async function publish(from) {
  const project = JSON.parse(readFileSync('.firebaserc', 'utf8')).projects?.default;
  const site = settings.films.site;
  if (!project) {
    console.error('.firebaserc names no default project');
    process.exit(1);
  }
  const files = mod.catalogue.flatMap((v) =>
    mod.variants.flatMap((variant) => ['video', 'captions'].map((kind) => mod.fileName(v.id, variant, kind))),
  );
  const absent = files.filter((f) => !existsSync(join(from, f)));
  if (absent.length) {
    console.error(`not there, so nothing sent:\n  ${absent.join('\n  ')}`);
    process.exit(1);
  }
  const stage = mkdtempSync(join(tmpdir(), 'help-films-'));
  try {
    mkdirSync(join(stage, 'public'));
    for (const f of files) cpSync(join(from, f), join(stage, 'public', f));
    const headers = [
      {
        source: '**/*.@(mp4|vtt)',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Cache-Control', value: 'public, max-age=3600' },
        ],
      },
      { source: '**/*.vtt', headers: [{ key: 'Content-Type', value: 'text/vtt; charset=utf-8' }] },
    ];
    writeFileSync(join(stage, 'firebase.json'), JSON.stringify({ hosting: { site, public: 'public', headers } }, null, 2));
    execFileSync('firebase', ['deploy', '--only', 'hosting', '--project', project, '--config', 'firebase.json', '--non-interactive'], {
      cwd: stage,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  const origin = `https://${site}.web.app`;
  let wrong = 0;
  for (const f of files) {
    // Uncompressed, or a caption file's length is its gzipped one.
    const r = await fetch(`${origin}/${f}`, { method: 'HEAD', headers: { 'Accept-Encoding': 'identity' } });
    const size = Number(r.headers.get('content-length'));
    if (!r.ok || size !== statSync(join(from, f)).size) {
      wrong += 1;
      console.error(`  ${f}: ${r.status}, ${size} bytes served, ${statSync(join(from, f)).size} sent`);
    }
  }
  if (wrong) {
    console.error(`${wrong} of ${files.length} file(s) are not what was sent`);
    process.exit(1);
  }
  console.log(`${files.length} file(s) live on ${origin}`);
}
