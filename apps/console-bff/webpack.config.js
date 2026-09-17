const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const { join } = require('path');

module.exports = {
  // Bundling third-party code means webpack reads its published source maps, and several packages
  // ship maps pointing at `.ts` files they do not publish. The warnings are cosmetic and there are
  // eleven of them, which is enough noise to hide a real one — so they are filtered rather than
  // tolerated.
  ignoreWarnings: [{ module: /node_modules/, message: /Failed to parse source map/ }],
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
      assets: ['./src/assets'],
      // Everything is bundled, unlike the backend services.
      //
      // WHY this one differs: those services carry the OpenTelemetry SDK, which patches modules at
      // require time and therefore cannot be bundled — so they externalise their dependencies and
      // install them in the image from a pruned lockfile. This process has no SDK. It forwards
      // `traceparent` instead of emitting its own spans, which keeps a trace continuous across it
      // without an instrumentation runtime, and leaves nothing that resists bundling.
      //
      // The result is a runtime image that copies one directory and runs it: no install, no pruned
      // lockfile to keep in step with the root one, and no second place for a supply-chain policy
      // to be evaluated against a different workspace file.
      externalDependencies: [],
      optimization: false,
      outputHashing: 'none',
      generatePackageJson: false,
      sourceMap: true,
    }),
  ],
};
