// Let Metro resolve the shared packages that live outside apps/mobile.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const config = getDefaultConfig(__dirname);
config.watchFolders = [path.join(root, 'packages')];
config.resolver.nodeModulesPaths = [path.join(__dirname, 'node_modules'), path.join(root, 'node_modules')];
module.exports = config;
