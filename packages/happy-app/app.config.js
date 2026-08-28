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
        runtimeVersion: "21",
        orientation: "default",
        icon: "./sources/assets/images/icon.png",
        scheme: "happy",
        userInterfaceStyle: "automatic",
        ios: {
            supportsTablet: true,
            bundleIdentifier: bundleId,
            config: {
                usesNonExemptEncryption: false
            },
            infoPlist: {
                NSMicrophoneUsageDescription: "Allow $(PRODUCT_NAME) to access your microphone for voice conversations with AI.",
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
        // With the bundle-id override active, updates are disabled outright
        // and the app runs the bundle baked into the archive (BASED-98).
        updates: process.env.DROVER_BUNDLE_ID
            ? { enabled: false }
            : {
                url: "https://u.expo.dev/4558dd3d-cd5a-47cd-bad9-e591a241cc06",
                requestHeaders: {
                    "expo-channel-name": "production"
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
                projectId: "4558dd3d-cd5a-47cd-bad9-e591a241cc06"
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
        owner: "bulkacorp"
    }
};
