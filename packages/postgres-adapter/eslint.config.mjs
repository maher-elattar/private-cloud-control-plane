import baseConfig from '../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, project: null, tsconfigRootDir: import.meta.dirname },
    },
  },
  { ignores: ['**/out-tsc'] },
];
