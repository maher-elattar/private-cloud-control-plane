import jsdoc from 'eslint-plugin-jsdoc';

/**
 * Documentation rules for the reusable library layers.
 *
 * Spread this into each package's `eslint.config.mjs` after the shared base config. It is a
 * separate fragment rather than part of `eslint.config.mjs` because Nx runs `eslint .` from
 * each project directory, so flat-config `files` patterns resolve relative to the package.
 * A root-relative pattern rooted at the `packages` directory would silently match nothing,
 * which is why the pattern below starts at `src`.
 *
 * It is deliberately NOT applied to `apps/`. NestJS controllers describe themselves through
 * their decorators; JSDoc stacked on top of `@Post()` and `@Param('projectId')` is noise.
 * Files under `apps/` still take a header block and `WHY:` notes by convention.
 *
 * @see docs/architecture/comment-standard.md
 */
export default [
  {
    files: ['src/**/*.ts'],
    ignores: ['**/*.spec.ts', '**/generated/**'],
    plugins: { jsdoc },
    rules: {
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: true,
          require: {
            ClassDeclaration: true,
            FunctionDeclaration: true,
            MethodDefinition: true,
          },
          contexts: ['TSInterfaceDeclaration', 'TSTypeAliasDeclaration'],
          checkConstructors: false,
          enableFixer: false,
        },
      ],
      'jsdoc/require-description': ['error', { checkConstructors: false }],
      'jsdoc/check-alignment': 'error',
      'jsdoc/check-tag-names': ['error', { typed: true }],
      // TypeScript already resolves and checks types. A comment must explain why the code is
      // the way it is, never restate a signature the compiler already enforces.
      'jsdoc/no-undefined-types': 'off',
      'jsdoc/require-param': 'off',
      'jsdoc/require-returns': 'off',
    },
  },
];
