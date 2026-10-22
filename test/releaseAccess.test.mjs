import { describe, expect, it } from 'vitest';
import { RELEASES, jobs, releaseAccessProblems } from '../scripts/lib/release-access.mjs';
import { renderAll } from '../scripts/workflows.mjs';
import full from './fixtures/full.json' with { type: 'json' };
import minimal from './fixtures/minimal.json' with { type: 'json' };

const OWNER_CHECK = `    steps:
      - name: Only the owner releases
        env:
          OWNER_ID: \${{ vars.RELEASE_OWNER_ID }}
          OWNER_LOGIN: \${{ vars.RELEASE_OWNER_LOGIN }}
          ACTOR_ID: \${{ github.actor_id }}
          TRIGGERING_ACTOR: \${{ github.triggering_actor }}
`;

describe('release access', () => {
  it('holds in every template, for every app', () => {
    for (const settings of [full, minimal]) {
      const workflows = renderAll(settings);
      expect(Object.keys(RELEASES).filter((name) => !workflows.has(name))).toEqual([]);
      expect(releaseAccessProblems(workflows)).toEqual([]);
    }
  });

  it('reports a signing secret read outside release-build', () => {
    const job = (environment, secret) => `jobs:\n  build:\n${environment ? '    environment: release-build\n' : ''}    steps:\n      - env:\n          X: \${{ secrets.${secret} }}\n`;
    expect(releaseAccessProblems([['a.yml', 'on: push\n' + job(true, 'ASC_KEY_P8')]])).toEqual([]);
    expect(releaseAccessProblems([['a.yml', 'on: push\n' + job(false, 'PROBE_TOKEN')]])).toEqual([]);
    expect(releaseAccessProblems([['a.yml', 'on: push\n' + job(false, 'BUILD_ENV')]]))
      .toEqual(['a.yml job build reads BUILD_ENV without entering the release-build environment']);
    expect(releaseAccessProblems([['a.yml', 'env:\n  K: ${{ secrets.ASC_KEY_P8 }}\n' + job(true, 'APP_ENV_LOCAL')]]))
      .toEqual(['a.yml reads ASC_KEY_P8 at workflow level, outside any job\'s release-build environment']);
  });

  it('reports a release that does not check the owner first', () => {
    const release = (steps) => `on: workflow_dispatch\njobs:\n  testflight:\n    environment: release-build\n${steps}`;
    expect(releaseAccessProblems([['ios.yml', release(OWNER_CHECK)]])).toEqual([]);
    const later = OWNER_CHECK.replace('    steps:\n', '    steps:\n      - uses: actions/checkout@v7\n');
    expect(releaseAccessProblems([['ios.yml', release(later)]]))
      .toEqual(['ios.yml job testflight does not start by checking that the owner started it']);
    expect(releaseAccessProblems([['ios.yml', 'on: push\njobs:\n  build:\n    steps: []\n']]))
      .toEqual(['ios.yml has no job testflight, a release job that starts by checking that the owner started it']);
  });

  it('uploads the web source maps from release-build, checking the owner first, and publishes only once they are in Sentry', () => {
    const deploy = renderAll(full).get('web-deploy.yml');
    const { sourcemaps, deploy: publish } = jobs(deploy);
    expect(sourcemaps).toMatch(/^ {4}environment: release-build$/m);
    expect(sourcemaps).toMatch(/^ {4}if: .*&& inputs\.deploy$/m);
    expect(sourcemaps).not.toContain('id-token');
    expect(sourcemaps).toContain('BUILD_ENV: ${{ secrets.BUILD_ENV }}\n        run: sabeel-ci ci-platform sourcemaps\n');
    expect(sourcemaps).toContain('sentry-cli/releases/download/2.58.6/sentry-cli-Linux-x86_64');
    expect(sourcemaps).toContain('36b689311b399d9332950d84f4299aee682d2d290a770a77372b30a74f7e7add  $SENTRY_CLI" | sha256sum --check');
    expect(sourcemaps.indexOf('sha256sum --check')).toBeLessThan(sourcemaps.indexOf('sabeel-ci ci-platform sourcemaps'));
    expect(publish).toContain('    needs: sourcemaps\n');
    expect(publish).toContain("(needs.sourcemaps.result == 'success' || !inputs.deploy)");
    expect(publish).not.toContain('secrets.BUILD_ENV');
    const unchecked = deploy.replace(/( {2}sourcemaps:\n[\s\S]*? {4}steps:\n) {6}- name: Only the owner releases\n/, '$1      - name: Anyone may\n');
    expect(releaseAccessProblems([['web-deploy.yml', unchecked]]))
      .toEqual(['web-deploy.yml job sourcemaps does not start by checking that the owner started it']);
    expect(releaseAccessProblems([['web-deploy.yml', deploy.replace('    environment: release-build\n', '')]]))
      .toEqual(['web-deploy.yml job sourcemaps reads BUILD_ENV without entering the release-build environment']);
  });

  it('builds iOS on main and sends it to TestFlight only from a manual run, after asking first', () => {
    const ios = renderAll(full).get('ios.yml');
    const { build, testflight } = jobs(ios);
    expect(ios).toMatch(/^on:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:\n/m);
    expect(testflight).toContain("    if: github.event_name == 'workflow_dispatch' && inputs.testflight\n");
    for (const job of [build, testflight]) expect(job).toMatch(/^ {4}environment: release-build$/m);
    expect(build).toContain('run: sabeel-ci build-ios\n');
    expect(build).not.toMatch(/altool|upload-package/);
    const order = ['- name: Only the owner releases', 'sabeel-ci testflight-check "$BUNDLE" "$VERSION" "$BUILD" "$COMMIT"',
      'xcrun altool --validate-app', 'xcrun altool --upload-package'].map((step) => testflight.indexOf(step));
    expect(order.every((at, i) => at > -1 && (i === 0 || at > order[i - 1])), String(order)).toBe(true);
    expect(ios.match(/altool --upload-package/g)).toHaveLength(1);
  });
});
