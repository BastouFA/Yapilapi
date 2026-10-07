// Yap reuses the phone app's screens and helpers where they live (apps/mobile/app and apps/mobile/lib,
// one copy of the code; see README.md). Metro needs to watch those folders, and every package they
// import has to come from Yap's own node_modules, even when apps/mobile/node_modules is installed
// too: two copies of React or React Native in one bundle would break the app.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const mobile = path.join(root, 'apps/mobile');
const config = getDefaultConfig(__dirname);

config.watchFolders = [path.join(root, 'packages'), path.join(mobile, 'app'), path.join(mobile, 'lib')];
config.resolver.nodeModulesPaths = [path.join(__dirname, 'node_modules'), path.join(root, 'node_modules')];

const fromMobile = (file) => file.startsWith(mobile + path.sep) && !file.includes(`${path.sep}node_modules${path.sep}`);
const isPackage = (name) => !name.startsWith('.') && !path.isAbsolute(name);
// A package imported from a phone app file resolves as if Yap had imported it.
const asYap = path.join(__dirname, 'package.json');

config.resolver.resolveRequest = (context, moduleName, platform) =>
  context.resolveRequest(
    fromMobile(context.originModulePath) && isPackage(moduleName) ? { ...context, originModulePath: asYap } : context,
    moduleName,
    platform,
  );

module.exports = config;
