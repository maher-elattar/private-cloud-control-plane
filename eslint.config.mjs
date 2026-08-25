import nx from '@nx/eslint-plugin';

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: [
      '**/dist',
      '**/out-tsc',
      '**/src/generated',
      '**/vitest.config.*.timestamp*',
      '**/webpack.config.js',
      'docs/diagrams/rendered/**',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
          depConstraints: [
            {
              sourceTag: 'type:app',
              onlyDependOnLibsWithTags: ['visibility:production'],
            },
            {
              sourceTag: 'layer:domain',
              onlyDependOnLibsWithTags: ['layer:domain'],
            },
            {
              sourceTag: 'layer:contract',
              onlyDependOnLibsWithTags: ['layer:contract'],
            },
            {
              sourceTag: 'layer:port',
              onlyDependOnLibsWithTags: ['layer:domain', 'layer:contract', 'layer:port'],
            },
            {
              sourceTag: 'layer:testing',
              onlyDependOnLibsWithTags: [
                'layer:domain',
                'layer:contract',
                'layer:port',
                'layer:testing',
              ],
            },
          ],
        },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
];
