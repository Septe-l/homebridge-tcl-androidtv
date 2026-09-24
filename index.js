'use strict';

const { PLATFORM_NAME, TclAndroidTvPlatform } = require('./src/platform');

module.exports = (api) => {
  api.registerPlatform(PLATFORM_NAME, TclAndroidTvPlatform);
};
