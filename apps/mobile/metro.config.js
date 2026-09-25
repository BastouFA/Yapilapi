// Metro config: apps/mobile is intentionally NOT an npm workspace (see docs/architecture/decisions/001-mobile-monorepo.md).
// Shared code (packages/api-client, packages/design-system) is consumed from source through tsconfig `paths` +
// `watchFolders`, and every dependency is resolved ONLY from apps/mobile/node_modules so the hoisted root
// node_modules (a different React / React Native for web and admin) can never leak into the bundle.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, '../..');
const sharedPackages = ['api-client', 'design-system'].map((n) =>
  path.join(repoRoot, 'packages', n),
);

const config = getDefaultConfig(projectRoot);
config.watchFolders = [...(config.watchFolders ?? []), ...sharedPackages];
config.resolver.nodeModulesPaths = [path.join(projectRoot, 'node_modules')];
config.resolver.disableHierarchicalLookup = true;
module.exports = config;
