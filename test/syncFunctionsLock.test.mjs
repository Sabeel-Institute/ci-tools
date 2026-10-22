import { describe, expect, it } from 'vitest';
import { lockDrift } from '../scripts/sync-functions-lock.mjs';

describe('sync-functions-lock', () => {
  const root = {
    packages: {
      'node_modules/firebase-admin': { version: '14.5.0' },
      'node_modules/typescript': { version: '6.0.3' },
      'functions/node_modules/google-auth-library': { version: '11.3.1' },
      'node_modules/google-auth-library': { version: '9.15.1' },
    },
  };
  const manifest = {
    dependencies: { 'firebase-admin': '^14.5.0', 'google-auth-library': '^11.3.1' },
    devDependencies: { typescript: '~6.0.2' },
  };
  const functions = (versions) => ({
    packages: Object.fromEntries(Object.entries(versions).map(([name, version]) => ['node_modules/' + name, { version }])),
  });

  it('accepts a lock whose direct dependencies are the workspace versions, the functions copy first', () => {
    expect(lockDrift(root, functions({ 'firebase-admin': '14.5.0', 'google-auth-library': '11.3.1', typescript: '6.0.3' }), manifest))
      .toEqual([]);
  });

  it('names each direct dependency that resolved otherwise, with its section', () => {
    expect(lockDrift(root, functions({ 'firebase-admin': '14.6.0', 'google-auth-library': '11.3.1' }), manifest)).toEqual([
      { name: 'firebase-admin', section: 'dependencies', functions: '14.6.0', workspace: '14.5.0' },
      { name: 'typescript', section: 'devDependencies', functions: undefined, workspace: '6.0.3' },
    ]);
  });

  it('refuses a dependency the root lock does not have', () => {
    expect(() => lockDrift(root, functions({}), { dependencies: { uuid: '^11.1.1' } }))
      .toThrow('uuid is not in the root package-lock.json');
  });
});
