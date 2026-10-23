/** Expo's definition of projectRoot, which the Sentry block reads and so must follow. */
export const PROJECT_ROOT = 'def projectRoot = rootDir.getAbsoluteFile().getParentFile().getAbsolutePath()\n';

/** build.gradle's Sentry block, as check-app and build-aab require it, written out rather than taken from the code. */
export const SENTRY_GRADLE = 'if (file("$projectRoot/.env.sentry-build-plugin").exists()) {\n'
  + '    apply from: new File(["node", "--print", "require.resolve(\'@sentry/react-native/package.json\')"].execute(null, rootDir).text.trim(), "../sentry.gradle")\n'
  + '}\n';

/** The Sentry Android Gradle plugin's setup check-app asks of every app's build.gradle. */
export const SENTRY_AGP = 'def sentryBuildEnv = file("$projectRoot/.env.sentry-build-plugin")\n'
  + 'sentry {\n'
  + '    includeProguardMapping = true\n'
  + "    autoUploadProguardMapping = sentryBuildEnv.exists() && System.getenv('SENTRY_DISABLE_AUTO_UPLOAD') != 'true'\n"
  + '    telemetry = false\n'
  + '    autoInstallation {\n'
  + '        enabled = false\n'
  + '    }\n'
  + '}\n'
  + 'tasks.withType(io.sentry.android.gradle.tasks.SentryCliExecTask).configureEach {\n'
  + "    if (sentryBuildEnv.exists()) environment('SENTRY_DOTENV_PATH', sentryBuildEnv.absolutePath)\n"
  + '}\n';
