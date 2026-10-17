module.exports = {
  root: true,
  extends: '@react-native',
  overrides: [
    {
      // jest.setup.js / jest.config.js use jest globals (jest.fn, beforeAll,
      // …) but don't match the *.test.* / __tests__/** patterns that
      // @react-native/eslint-config applies the jest environment to, so they
      // need it applied explicitly here.
      files: ['jest.setup.js', 'jest.config.js'],
      env: { jest: true, 'jest/globals': true, node: true },
    },
  ],
};
