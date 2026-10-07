// The phone app's scene life cycle plugin (apps/mobile/plugins/with-scene-lifecycle.js), used as it
// is so there is one copy. It is loaded here so that `expo/config-plugins` comes from Yap's own
// node_modules: apps/mobile/node_modules may not be installed when building Yap.
const fs = require('fs');
const Module = require('module');
const path = require('path');

const file = path.resolve(__dirname, '../../mobile/plugins/with-scene-lifecycle.js');
const plugin = new Module(file, module);
plugin.filename = file;
plugin.paths = Module._nodeModulePaths(__dirname);
plugin._compile(fs.readFileSync(file, 'utf8'), file);

module.exports = plugin.exports;
