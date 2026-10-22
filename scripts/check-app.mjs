import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../lib/config.mjs';
import { BUILD_INFO } from './build-info.mjs';
import { firebaseFixtures } from './ci-premerge.mjs';
import { deployNotesProblem } from './deploy-notes.mjs';
import { releaseAccessProblems } from './lib/release-access.mjs';
import { drift } from './workflows.mjs';

/**
 * What ci-tools needs to be true of the app repository it runs in.
 *
 *   sabeel-ci check-app
 *
 * The scripts here assume these; an app that broke one would not fail loudly,
 * it would publish a secret or build against the wrong identifiers. CI runs it
 * beside the app's own tests.
 */

/** Files the CI scripts write from secrets; Git must never pick them up. */
export const PRIVATE_FILES = ['app/.env.local', 'app/.env.sentry-build-plugin', 'app/android/keystore.properties'];

/** Files every build writes; unless Git ignores them, each build is marked as built from uncommitted changes. */
export const GENERATED_FILES = [BUILD_INFO];

export function problems(root = '.') {
  const found = [];
  const attempt = (check) => {
    try {
      found.push(...check());
    } catch (error) {
      found.push(error.message);
    }
  };
  attempt(() => (config(root), []));
  attempt(() => drift(root));
  const ignored = (path) => {
    try {
      execFileSync('git', ['check-ignore', '--quiet', '--no-index', path], { cwd: root, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  attempt(() => PRIVATE_FILES.filter((path) => !ignored(path)).map((path) => `.gitignore does not cover ${path}, which CI writes from a secret`));
  attempt(() => GENERATED_FILES.filter((path) => !ignored(path))
    .map((path) => `.gitignore does not cover ${path}, which every build writes, so each build is marked as built from uncommitted changes`));
  attempt(() => {
    const directory = resolve(root, '.github/workflows');
    return releaseAccessProblems(readdirSync(directory).filter((name) => /\.ya?ml$/.test(name))
      .map((name) => [name, readFileSync(join(directory, name), 'utf8')]));
  });
  attempt(() => {
    const app = JSON.parse(readFileSync(resolve(root, 'app/app.json'), 'utf8')).expo;
    firebaseFixtures(app);
    return [];
  });
  attempt(() => {
    const { version } = JSON.parse(readFileSync(resolve(root, 'app/app.json'), 'utf8')).expo;
    const problem = deployNotesProblem(String(version), root);
    return problem ? [`${problem}\n    The Android release build refuses to run without it.`] : [];
  });
  attempt(() => {
    const manifest = resolve(root, 'functions/package.json');
    if (!existsSync(manifest)) return [];
    const { dependencies, devDependencies } = JSON.parse(readFileSync(manifest, 'utf8'));
    const lock = JSON.parse(readFileSync(resolve(root, 'functions/package-lock.json'), 'utf8')).packages[''];
    return JSON.stringify([lock.dependencies, lock.devDependencies]) === JSON.stringify([dependencies, devDependencies])
      ? [] : ['functions/package-lock.json is out of step with functions/package.json (Cloud Build installs from that lock): run npm install in functions/'];
  });
  return found;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const found = problems();
  if (found.length) {
    console.error(found.map((problem) => `- ${problem}`).join('\n'));
    process.exit(1);
  }
  console.log('the app meets what ci-tools assumes');
}
