// Attach the Cattle Drover watchOS app to the project `expo prebuild`
// generates (BASED-98, porting the BASED-94 Lookout graft).
//
// Why a plugin and not committed Xcode state: packages/happy-app/ios is
// gitignored because prebuild rewrites it from scratch. Anything added there
// by hand is gone on the next build. So the Swift lives in
// packages/happy-app/watch (tracked) and this re-grafts it every time.
//
// The pbxproj surgery is Ruby, via the xcodeproj gem CocoaPods already puts
// on the box — see watch/scripts/add-watch-targets.rb for why.

const { withDangerousMod } = require("@expo/config-plugins");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const HOOK_MARKER = "BASED-98 drover watch targets";

// CocoaPods rewrites TARGETED_DEVICE_FAMILY on every target in the project it
// integrates — including ones not in the Podfile — so the watch targets come
// out of `pod install` claiming device family "1,2". That is iPhone+iPad on a
// watchOS target: Xcode warns and App Store validation rejects it. Running
// the graft before pod install is therefore not enough.
//
// post_integrate fires AFTER the project is written, so re-running the
// (idempotent) script there is what makes the settings stick. Values are
// baked in rather than read from the environment, because `pod install` does
// not inherit the exports prebuild set.
const podfileHook = (watchRelative, version, buildNumber, bundleId) => `
# ${HOOK_MARKER}: re-attach after CocoaPods, which rewrites
# TARGETED_DEVICE_FAMILY to "1,2" on targets it did not create. The script is
# idempotent — see ${watchRelative}/scripts/add-watch-targets.rb.
post_integrate do |installer|
  watch = File.expand_path('${watchRelative}', __dir__)
  env = {
    'IOS_BUNDLE_ID' => '${bundleId}',
    'IOS_MARKETING_VERSION' => '${version}',
    'IOS_BUILD_NUMBER' => '${buildNumber}'
  }
  script = File.join(watch, 'scripts', 'add-watch-targets.rb')
  unless system(env, 'ruby', script, __dir__, watch)
    raise 'BASED-98: re-attaching the drover watch targets after pod install failed'
  end
end
`;

const withWatchApp = (config) =>
  withDangerousMod(config, [
    "ios",
    (cfg) => {
      const iosRoot = cfg.modRequest.platformProjectRoot;
      const watchRoot = path.join(cfg.modRequest.projectRoot, "watch");
      const script = path.join(watchRoot, "scripts", "add-watch-targets.rb");

      const result = spawnSync("ruby", [script, iosRoot, watchRoot], {
        stdio: "inherit",
        env: {
          ...process.env,
          // The watch app's CFBundleVersion must match the phone app's or
          // Apple rejects the upload, so pass the same values prebuild used
          // rather than letting the script fall back to "1".
          IOS_BUNDLE_ID: cfg.ios?.bundleIdentifier ?? "com.ex3ndr.happy",
          IOS_MARKETING_VERSION: cfg.version ?? "1.0.0",
          IOS_BUILD_NUMBER: cfg.ios?.buildNumber ?? "1",
        },
      });

      if (result.status !== 0) {
        throw new Error(
          `withWatchApp: ${script} exited ${result.status}. ` +
            "The watch target was NOT added; the iOS app would still build " +
            "and silently ship without it, so this fails loudly instead.",
        );
      }

      const podfile = path.join(iosRoot, "Podfile");
      if (fs.existsSync(podfile)) {
        const current = fs.readFileSync(podfile, "utf8");
        if (!current.includes(HOOK_MARKER)) {
          fs.appendFileSync(
            podfile,
            podfileHook(
              path.relative(iosRoot, watchRoot),
              cfg.version ?? "1.0.0",
              cfg.ios?.buildNumber ?? "1",
              cfg.ios?.bundleIdentifier ?? "com.ex3ndr.happy",
            ),
          );
        }
      }
      return cfg;
    },
  ]);

module.exports = withWatchApp;
