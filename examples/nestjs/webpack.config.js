const { neoSyringePlugin } = require('@djodjonx/neosyringe-plugin');

module.exports = (options) => ({
  ...options,
  plugins: [
    ...(options.plugins || []),
    neoSyringePlugin.webpack(),
  ],
});
