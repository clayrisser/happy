const { execFileSync } = require('node:child_process');

const variant = process.env.APP_ENV || 'development';
// DROVER_APP_NAME overrides the display name the same way DROVER_BUNDLE_ID
// overrides the ids (BASED-98): an env override, never an edit, so merges
// from upstream stay clean.
const name = process.env.DROVER_APP_NAME || {
    development: "Cattle Drover (dev)",
    preview: "Cattle Drover (preview)",
    production: "Happy"
}[variant];
// Upstream's ids by default. A fork cannot sign them — they belong to the
// upstream author's Apple account — so DROVER_BUNDLE_ID overrides the whole
// set for builds under a different team (BASED-98). Kept as an override
// rather than an edit so merges from upstream stay clean.
const bundleId = process.env.DROVER_BUNDLE_ID || {
    development: "com.slopus.happy.dev",
    preview: "com.slopus.happy.preview",
    production: "com.ex3ndr.happy"
}[variant];
// The Expo project the app belongs to, and the account that owns it. Expo
// looks push credentials up per (experience, bundle id), so a drover build
// signed as com.bitspur.drover but still registering under @bulkacorp/happy
// asks Expo for a key nobody can upload: the project is upstream's account.
// Every push then dies at Expo with InvalidCredentials, which the CLI only
// logs at debug — so the app showed the card and the phone stayed silent
// (BASED-98). Same env-override shape as DROVER_BUNDLE_ID, so a merge from
// upstream stays clean and the default stays upstream's.
const easProjectId =
    process.env.DROVER_EAS_PROJECT_ID || "4558dd3d-cd5a-47cd-bad9-e591a241cc06";
const easOwner = process.env.DROVER_EAS_OWNER || "bulkacorp";
// The pair is the credential key, so half an override is never a build worth
// making: Expo resolves the experience as `@owner/slug` and mints the token
// from projectId, and a mismatched pair fails exactly like no override at all.
// A throw rather than a warning because there is no correct outcome to reach.
if (!!process.env.DROVER_EAS_PROJECT_ID !== !!process.env.DROVER_EAS_OWNER) {
    throw new Error(
        "DROVER_EAS_PROJECT_ID and DROVER_EAS_OWNER must be set together. " +
        "One without the other registers push under the wrong Expo account."
    );
}
// Which EAS Update channel this build subscribes to. A Route A build is
// archived from Xcode, so eas.json's per-profile `channel` never reaches it and
// this is the only place the channel gets set. Defaults to production because
// that is what a TestFlight build is (BASED-98).
const updateChannel = process.env.DROVER_UPDATE_CHANNEL || "production";
// A fork build on upstream's Expo project cannot push, and that failure is
// silent everywhere it lands: the token registers, the server accepts it, the
// CLI logs InvalidCredentials at debug and drops it (BASED-98). The archive
// script says this too, but Route A installs straight from Xcode and never
// runs it, so the warning belongs where every build path reads it.
//
// process.stderr, not console.warn: @expo/config patches the console while it
// evaluates this file, and `expo config --type public --json` swallowed the
// line entirely (measured 2026-08-29). stderr also keeps it out of the JSON on
// stdout, which a log line there would corrupt.
if (process.env.DROVER_BUNDLE_ID && !process.env.DROVER_EAS_PROJECT_ID) {
    process.stderr.write(
        `app.config: building ${process.env.DROVER_BUNDLE_ID} against upstream's Expo ` +
        "project, so every push will fail with InvalidCredentials. Set " +
        "DROVER_EAS_PROJECT_ID and DROVER_EAS_OWNER to your own project and rebuild.\n"
    );
}
// const stagingElevenLabsAgentId = 'agent_7801k2c0r5hjfraa1kdbytpvs6yt';
const productionElevenLabsAgentId = 'agent_6701k211syvvegba4kt7m68nxjmw';
const elevenLabsAgentId = {
    development: productionElevenLabsAgentId,
    preview: productionElevenLabsAgentId,
    production: productionElevenLabsAgentId,
}[variant];
const consoleLoggingDefault = {
    development: true,
    preview: true,
    production: false,
}[variant];

function git(args) {
    try {
        return execFileSync('git', args, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() || undefined;
    } catch {
        return undefined;
    }
}

function loadBuildMetadata() {
    const commitSha =
        process.env.HAPPY_BUILD_COMMIT_SHA ||
        process.env.EAS_BUILD_GIT_COMMIT_HASH ||
        process.env.GITHUB_SHA ||
        git(['rev-parse', 'HEAD']);
    const commitTimestamp =
        process.env.HAPPY_BUILD_COMMIT_TIMESTAMP ||
        (commitSha
            ? git(['show', '-s', '--format=%cI', commitSha])
            : git(['show', '-s', '--format=%cI', 'HEAD']));

    return {
        commitSha,
        commitTimestamp,
    };
}

const buildMetadata = loadBuildMetadata();

export default {
    expo: {
        name,
        slug: "happy",
        version: "1.7.0",
        // Bumped to 22 in the change that archives build 8, which is the
        // documented rule: the voice lane added a real autolinked pod
        // (modules/drover-speech, podspec + DroverSpeechModule.swift), so a
        // JS bundle that calls into it must not be served to a binary that
        // does not have it. It was held at 21 until now because build 7 on
        // Clay's wrist IS runtime 21 and bumping ahead of the binary cut him
        // off from every OTA — the manifest correctly answered 204 for 22
        // while it went on serving an hour-old 21 update.
        // From build 8 on, every OTA must be published at 22 or it reaches
        // nothing. Builds 6 and 7 are orphaned from updates by design.
        runtimeVersion: "22",
        orientation: "default",
        icon: "./sources/assets/images/icon.png",
        scheme: "happy",
        userInterfaceStyle: "automatic",
        ios: {
            supportsTablet: true,
            bundleIdentifier: bundleId,
            // CFBundleVersion. Apple refuses an upload whose build number is
            // already taken for this marketing version, and build 1 is taken
            // (BASED-98), so every later build sets DROVER_BUILD_NUMBER. It is
            // an env override rather than a tracked number so the tree never
            // carries a value that is only correct for one upload, and so the
            // watch graft — which reads ios.buildNumber and stamps
            // CURRENT_PROJECT_VERSION on both watch targets — cannot disagree
            // with the phone.
            buildNumber: process.env.DROVER_BUILD_NUMBER || "1",
            config: {
                usesNonExemptEncryption: false
            },
            infoPlist: {
                NSMicrophoneUsageDescription: "Allow $(PRODUCT_NAME) to access your microphone for voice conversations with AI.",
                // Dictation (DROVE-30, mode A). SFSpeechRecognizer refuses to
                // start without this key, and it runs with
                // requiresOnDeviceRecognition, so the audio really does stay here.
                NSSpeechRecognitionUsageDescription: "Allow $(PRODUCT_NAME) to turn what you say into a prompt. Transcription happens on this device.",
                // Read-aloud (DROVE-30, mode B) has to keep speaking with the
                // screen locked, which is what the audio background mode buys.
                // The AVAudioSession category is .playback/.spokenAudio with
                // .duckOthers, set in DroverSpeechModule.
                UIBackgroundModes: ["audio"],
                NSLocalNetworkUsageDescription: "Allow $(PRODUCT_NAME) to find and connect to local devices on your network.",
                NSBonjourServices: ["_http._tcp", "_https._tcp"],
                // ATS:
                // - NSAllowsLocalNetworking: lets HTTP fetches reach LAN
                //   addresses (e.g. self-hosted server at 192.168.x.y) without
                //   forcing TLS. Production cloud server is HTTPS, so the
                //   default policy still applies there.
                // - In dev/preview only, allow arbitrary HTTP loads so a
                //   developer pointing the app at their machine doesn't have
                //   to ship a TLS cert just to test attachment uploads.
                NSAppTransportSecurity: variant === 'production'
                    ? { NSAllowsLocalNetworking: true }
                    : { NSAllowsLocalNetworking: true, NSAllowsArbitraryLoads: true }
            },
            ...(variant === 'production'
                ? { associatedDomains: ["applinks:app.happy.engineering"] }
                : {})
        },
        android: {
            adaptiveIcon: {
                foregroundImage: "./sources/assets/images/icon-adaptive.png",
                monochromeImage: "./sources/assets/images/icon-monochrome.png",
                backgroundColor: "#000000"
            },
            permissions: [
                "android.permission.RECORD_AUDIO",
                "android.permission.MODIFY_AUDIO_SETTINGS",
                "android.permission.ACCESS_NETWORK_STATE",
                "android.permission.POST_NOTIFICATIONS",
            ],
            blockedPermissions: [
                "android.permission.ACTIVITY_RECOGNITION",
                // Not using external storage/media access for now — blocks Google Play photo/video permission declaration
                "android.permission.READ_EXTERNAL_STORAGE",
                "android.permission.WRITE_EXTERNAL_STORAGE",
                "android.permission.READ_MEDIA_IMAGES",
                "android.permission.READ_MEDIA_VIDEO",
            ],
            package: bundleId,
            versionCode: Number(process.env.DROVER_BUILD_NUMBER || 1),
            googleServicesFile: "./google-services.json",
            intentFilters: variant === 'production' ? [
                {
                    "action": "VIEW",
                    "autoVerify": true,
                    "data": [
                        {
                            "scheme": "https",
                            "host": "app.happy.engineering",
                            "pathPrefix": "/"
                        }
                    ],
                    "category": ["BROWSABLE", "DEFAULT"]
                }
            ] : []
        },
        web: {
            bundler: "metro",
            output: "single",
            favicon: "./sources/assets/images/favicon.png"
        },
        plugins: [
            require("./plugins/withEinkCompatibility.js"),
            // Cattle Drover watch app (BASED-98). Grafts the tracked watchOS
            // sources in ./watch onto the generated Xcode project; ios/ is
            // gitignored, so committed Xcode state is not an option.
            require("./plugins/withWatchApp.cjs"),
            [
                "expo-router",
                {
                    root: "./sources/app"
                }
            ],
            "expo-updates",
            "expo-asset",
            "expo-localization",
            "expo-mail-composer",
            "expo-secure-store",
            "expo-web-browser",
            "react-native-vision-camera",
            "@more-tech/react-native-libsodium",
            "react-native-audio-api",
            "@livekit/react-native-expo-plugin",
            "@config-plugins/react-native-webrtc",
            [
                "expo-audio",
                {
                    microphonePermission: "Allow $(PRODUCT_NAME) to access your microphone for voice conversations."
                }
            ],
            [
                "expo-location",
                {
                    locationAlwaysAndWhenInUsePermission: "Allow $(PRODUCT_NAME) to improve AI quality by using your location.",
                    locationAlwaysPermission: "Allow $(PRODUCT_NAME) to improve AI quality by using your location.",
                    locationWhenInUsePermission: "Allow $(PRODUCT_NAME) to improve AI quality by using your location."
                }
            ],
            [
                "expo-calendar",
                {
                    "calendarPermission": "Allow $(PRODUCT_NAME) to access your calendar to improve AI quality."
                }
            ],
            [
                "expo-camera",
                {
                    cameraPermission: "Allow $(PRODUCT_NAME) to access your camera to scan QR codes and share photos with AI.",
                    microphonePermission: "Allow $(PRODUCT_NAME) to access your microphone for voice conversations.",
                    recordAudioAndroid: true
                }
            ],
            [
                "expo-notifications",
                {
                    "enableBackgroundRemoteNotifications": true,
                    "icon": "./sources/assets/images/icon-notification.png"
                }
            ],
            [
                'expo-splash-screen',
                {
                    ios: {
                        backgroundColor: "#F2F2F7",
                        dark: {
                            backgroundColor: "#000000",
                        }
                    },
                    android: {
                        image: "./sources/assets/images/splash-android-light.png",
                        backgroundColor: "#F5F5F5",
                        dark: {
                            image: "./sources/assets/images/splash-android-dark.png",
                            backgroundColor: "#000000",
                        }
                    }
                }
            ]
        ],
        // A drover build must NEVER take OTA updates from upstream's EAS
        // project: the update server is theirs, the published bundles are
        // compiled from their tree by their toolchain, and a runtime-version
        // match would happily replace our JS with theirs (and a Hermes
        // bytecode mismatch in that path only surfaces as a crash on launch).
        //
        // What makes the update server safe is DROVER_EAS_PROJECT_ID, not the
        // bundle id: `url` is built from easProjectId, so with the pair set the
        // app polls OUR project and can only ever be served bundles we publish.
        // Disabling on DROVER_BUNDLE_ID alone therefore turned OTA off for
        // exactly the builds that had already been made safe, and left the
        // wrist on a TestFlight round-trip for a one-line JS fix (BASED-98).
        // A fork build with no project of its own still gets nothing: it would
        // poll upstream, which is the original hazard.
        updates: process.env.DROVER_BUNDLE_ID && !process.env.DROVER_EAS_PROJECT_ID
            ? { enabled: false }
            : {
                url: `https://u.expo.dev/${easProjectId}`,
                requestHeaders: {
                    // A locally archived build never runs through EAS Build, so
                    // nothing else ever writes the channel: this header is the
                    // only thing that puts a Route A archive on a channel.
                    "expo-channel-name": updateChannel
                }
            },
        experiments: {
            typedRoutes: true
        },
        extra: {
            router: {
                root: "./sources/app"
            },
            eas: {
                // Read back by sources/sync/pushRegistration.ts to mint the
                // Expo push token, so this value decides which account's push
                // credentials Expo looks for.
                projectId: easProjectId,
                // The watch app and its widget are grafted onto the generated
                // Xcode project by watch/scripts/add-watch-targets.rb, which
                // runs during prebuild. A cloud build prebuilds from scratch,
                // and `ios/` is gitignored, so eas-cli never sees those two
                // targets when it provisions credentials: it set up
                // com.bitspur.drover alone and the Xcode build then died with
                // "No profiles for 'com.bitspur.drover.watchkitapp'". Declaring
                // them here is how a managed project tells EAS an extension
                // exists. The names and ids must match the graft exactly
                // (app_name, widget_name, and the ids Apple forces: the host id
                // plus .watchkitapp, plus .widget).
                build: {
                    experimental: {
                        ios: {
                            // The entitlements matter as much as the ids.
                            // Without them EAS syncs the capability set for
                            // each extension and reports "Disabled: App
                            // Groups", so the profile it mints omits the
                            // group the target's .entitlements file demands
                            // and Xcode refuses: "doesn't support the
                            // group.com.bitspur.drover App Group". The group
                            // is a literal here because it is a literal in
                            // watch/DroverWatch{,Widget}/*.entitlements; the
                            // two must agree or the build fails the same way.
                            appExtensions: [
                                {
                                    targetName: "DroverWatch",
                                    bundleIdentifier: `${bundleId}.watchkitapp`,
                                    entitlements: {
                                        "com.apple.security.application-groups": [
                                            "group.com.bitspur.drover"
                                        ]
                                    }
                                },
                                {
                                    targetName: "DroverWatchWidget",
                                    bundleIdentifier: `${bundleId}.watchkitapp.widget`,
                                    entitlements: {
                                        "com.apple.security.application-groups": [
                                            "group.com.bitspur.drover"
                                        ]
                                    }
                                }
                            ]
                        }
                    }
                }
            },
            app: {
                postHogKey: process.env.EXPO_PUBLIC_POSTHOG_API_KEY,
                revenueCatAppleKey: process.env.EXPO_PUBLIC_REVENUE_CAT_APPLE,
                revenueCatGoogleKey: process.env.EXPO_PUBLIC_REVENUE_CAT_GOOGLE,
                revenueCatStripeKey: process.env.EXPO_PUBLIC_REVENUE_CAT_STRIPE,
                elevenLabsAgentId,
                consoleLoggingDefault,
                buildCommitSha: buildMetadata.commitSha,
                buildCommitTimestamp: buildMetadata.commitTimestamp,
            }
        },
        owner: easOwner
    }
};
