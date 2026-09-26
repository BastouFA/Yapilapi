// Adopt the UIKit scene life cycle, which apps built with the iOS 27 SDK must use (the app is refused
// at launch otherwise). Expo 57 ships ExpoAppSceneDelegate for this; the generated AppDelegate still
// creates its own window, so this plugin:
//   - makes AppDelegate provide its React Native factory to the scene delegate,
//   - stops AppDelegate from creating the window (the scene delegate does, and starts React Native in it),
//   - adds a SceneDelegate and the scene manifest to Info.plist.
const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');

function patchAppDelegate(src) {
  if (src.includes('class SceneDelegate: ExpoAppSceneDelegate')) return src;
  let out = src.replace('class AppDelegate: ExpoAppDelegate {', 'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {');
  // Remove the window creation and React Native start; the scene delegate does both.
  out = out.replace(/#if os\(iOS\) \|\| os\(tvOS\)\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)[\s\S]*?#endif\n/, '');
  out += `
/// Creates the window for the app's scene and starts React Native in it (see ExpoAppSceneDelegate).
class SceneDelegate: ExpoAppSceneDelegate {}
`;
  if (!out.includes('ExpoReactNativeFactoryProvider {') || out.includes('UIWindow(frame: UIScreen.main.bounds)'))
    throw new Error('with-scene-lifecycle: the generated AppDelegate.swift has an unexpected shape; update the plugin.');
  return out;
}

module.exports = function withSceneLifecycle(config) {
  config = withAppDelegate(config, (c) => {
    if (c.modResults.language !== 'swift') throw new Error('with-scene-lifecycle expects a Swift AppDelegate.');
    c.modResults.contents = patchAppDelegate(c.modResults.contents);
    return c;
  });
  config = withInfoPlist(config, (c) => {
    c.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          { UISceneConfigurationName: 'Default Configuration', UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate' },
        ],
      },
    };
    return c;
  });
  return config;
};
