// Metro config for npm workspaces. Without this, Metro can't resolve
// @carnet/shared from the monorepo root.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.disableHierarchicalLookup = true;

// jsdom (a Node-only devDependency for vitest) drags webidl-conversions@8
// into apps/mobile/node_modules, and with disableHierarchicalLookup that
// nested copy shadows the root webidl-conversions@5 that expo's URL polyfill
// (whatwg-url-without-unicode) needs. v8 dereferences SharedArrayBuffer at
// module load, which Hermes doesn't expose — the app hard-crashes during
// bundle evaluation ("Property 'SharedArrayBuffer' doesn't exist"). Block the
// nested copy so resolution falls through to the root v5. Node/vitest are
// unaffected (they don't resolve through Metro).
config.resolver.blockList = [
  new RegExp(
    `${path.resolve(projectRoot, 'node_modules/webidl-conversions').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/.*`,
  ),
];

module.exports = config;
