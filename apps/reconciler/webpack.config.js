const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const { join } = require('path');
const { dependencies } = require('./package.json');

module.exports = {
  output: {
    path: join(__dirname, 'dist'),
    clean: true,
    ...(process.env.NODE_ENV !== 'production' && {
      devtoolModuleFilenameTemplate: '[absolute-resource-path]',
    }),
  },
  plugins: [
    new NxAppWebpackPlugin({
      target: 'node',
      compiler: 'tsc',
      main: './src/main.ts',
      tsConfig: './tsconfig.app.json',
      assets: [
        './src/assets',
        // The observation client loads the provider contract at runtime, so the proto travels
        // with the bundle exactly as it does for the orchestrator.
        {
          input: '../../packages/contracts/proto',
          glob: '**/*.proto',
          output: 'assets/proto',
        },
      ],
      // pnpm keeps app dependencies isolated; the manifest is the deployment dependency boundary.
      externalDependencies: Object.keys(dependencies),
      optimization: false,
      outputHashing: 'none',
      generatePackageJson: false,
      sourceMap: true,
    }),
  ],
};
