import baseConfig from '../../eslint.config.mjs';
import jsdocConfig from '../../eslint.jsdoc.mjs';

export default [
  ...baseConfig,
  ...jsdocConfig,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, project: null, tsconfigRootDir: import.meta.dirname },
    },
  },
  { ignores: ['**/out-tsc', 'vite.config.ts'] },
];
