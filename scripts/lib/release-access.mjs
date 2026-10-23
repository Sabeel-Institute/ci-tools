/**
 * Who can sign, and who can release.
 *
 * Repository secrets reach any workflow on any branch, and collaborators can
 * push branches, so the signing keys, the App Store Connect key and the build
 * configuration live in the `release-build` environment, which only main and
 * the owner's `v*` tags may enter. Every job that reads one must name that
 * environment, or it reads nothing and a refactor that moves a secret back to
 * the repository goes unnoticed. And every job that publishes checks, first,
 * that the owner started it.
 *
 * Held over the templates by ci-tools' tests, and over every workflow an app
 * has, its own included, by `sabeel-ci check-app`.
 */
export const SIGNING = ['APP_ENV_LOCAL', 'ANDROID_KEYSTORE', 'ANDROID_KEYSTORE_PROPERTIES',
  'BUILD_ENV', 'IOS_DIST_P12', 'IOS_DIST_P12_PASSWORD', 'IOS_PROFILE', 'ASC_KEY_P8'];

/**
 * Each publishing workflow, and the jobs in it that release: each starts by
 * checking the owner. Deploy Web uploads the build's source maps to Sentry
 * with a build secret before it publishes the site.
 */
export const RELEASES = {
  'web-deploy.yml': ['sourcemaps', 'deploy'], 'android-publish.yml': ['publish'], 'functions-deploy.yml': ['deploy'], 'ios.yml': ['testflight'],
};

/** A workflow's jobs, by name, each the text from its key to the next job's. */
export function jobs(text) {
  const start = text.indexOf('\njobs:\n');
  if (start === -1) return {};
  const keys = [...text.slice(start).matchAll(/^ {2}([A-Za-z0-9_-]+):\n/gm)];
  return Object.fromEntries(keys.map((m, i) =>
    [m[1], text.slice(start + m.index, keys[i + 1] ? start + keys[i + 1].index : text.length)]));
}

/** What breaks the rules above in `workflows` (file name to text): one line each. */
export function releaseAccessProblems(workflows) {
  const problems = [];
  for (const [file, text] of workflows) {
    const start = text.indexOf('\njobs:\n');
    const header = start === -1 ? text : text.slice(0, start);
    for (const name of SIGNING) {
      if (new RegExp(`secrets\\.${name}\\b`).test(header)) problems.push(`${file} reads ${name} at workflow level, outside any job's release-build environment`);
    }
    for (const [job, body] of Object.entries(jobs(text))) {
      const uses = SIGNING.filter((name) => new RegExp(`secrets\\.${name}\\b`).test(body));
      if (uses.length && !/^ {4}environment: release-build$/m.test(body)) {
        problems.push(`${file} job ${job} reads ${uses.join(', ')} without entering the release-build environment`);
      }
    }
    for (const job of RELEASES[file] ?? []) {
      const body = jobs(text)[job];
      if (body === undefined) {
        problems.push(`${file} has no job ${job}, a release job that starts by checking that the owner started it`);
      } else if (!/^ {4}steps:\n {6}- name: Only the owner releases\n/m.test(body)
        || !body.includes('OWNER_ID: ${{ vars.RELEASE_OWNER_ID }}')
        || !body.includes('TRIGGERING_ACTOR: ${{ github.triggering_actor }}')) {
        problems.push(`${file} job ${job} does not start by checking that the owner started it`);
      }
    }
  }
  return problems;
}
