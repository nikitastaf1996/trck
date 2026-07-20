/**
 * Jest configuration for trck.
 *
 * Builds on the React Native Jest preset (which already wires up Hermes /
 * haste module maps / a default React Native mock) and adds:
 *
 *   - A `jest.setup.js` that installs extra mocks for native-side modules
 *     the unit tests don't want to actually instantiate (SafeAreaContext,
 *     DeviceEventEmitter subscriptions, etc.).
 *   - A `coverageThreshold` floor so coverage never silently regresses below
 *     a sane baseline. We don't aim for 100% — the recording pipeline is
 *     hard to exercise in JSDOM — but we do want every pure helper, every
 *     presentational component, and every hook to be exercised.
 *   - A `testPathIgnorePatterns` that skips the `android/` Kotlin sources
 *     (those run via `./gradlew testDebugUnitTest`, not via Jest).
 *   - `testEnvironment: 'node'` because the React Native preset already
 *     shims the RN primitives we need; using 'jsdom' would conflict.
 */
module.exports = {
  preset: '@react-native/jest-preset',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  testEnvironment: 'node',
  testPathIgnorePatterns: [
    '/node_modules/',
    '/android/',
    '/ios/',
    '/__tests__/helpers/',  // helper modules, not test files
  ],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    'App.tsx',
    '!src/**/*.d.ts',
  ],
  coverageThreshold: {
    global: {
      statements: 50,
      branches: 40,
      functions: 50,
      lines: 50,
    },
  },
  // Verbose output so each test name shows up in CI logs — very useful when
  // a single test in a large suite starts failing.
  verbose: true,
};
