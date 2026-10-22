/** build.gradle's Sentry block, as check-app and build-aab require it, written out rather than taken from the code. */
export const SENTRY_GRADLE = 'if (file("$projectRoot/.env.sentry-build-plugin").exists()) {\n'
  + '    apply from: new File(["node", "--print", "require.resolve(\'@sentry/react-native/package.json\')"].execute(null, rootDir).text.trim(), "../sentry.gradle")\n'
  + '}\n';
