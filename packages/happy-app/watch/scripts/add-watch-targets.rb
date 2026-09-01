#!/usr/bin/env ruby
# frozen_string_literal: true

# Graft the Cattle Drover watchOS app and its widget onto the GENERATED Xcode
# project (BASED-98, porting the BASED-94 Lookout graft).
#
# packages/happy-app/ios is gitignored — `expo prebuild` rewrites it from
# scratch — so the watch app cannot live there as committed Xcode state. The
# Swift is tracked in packages/happy-app/watch and this script re-attaches it
# from the config plugin every time the project is regenerated.
#
# Xcodeproj (the gem CocoaPods already installs) rather than hand-editing
# project.pbxproj: it knows a watchOS application from an iOS one and writes
# embed phases with the destination specs Xcode expects.
#
# Idempotent by construction: existing targets of the same name, and the
# host's references to them, are torn down and rebuilt, so a re-run after
# `pod install` never doubles anything.

require 'fileutils'
require 'xcodeproj'

ios_dir = ARGV[0] or abort('usage: add-watch-targets.rb <ios dir> <watch dir>')
watch_dir = ARGV[1] or abort('usage: add-watch-targets.rb <ios dir> <watch dir>')

# The project name follows the Expo app name, which varies per build variant
# ("Happy", "Happy (dev)", "Happy (preview)"). Discover it rather than
# hardcoding — a wrong guess here silently grafts nothing.
projects = Dir.glob(File.join(ios_dir, '*.xcodeproj')).reject { |p| p.end_with?('Pods.xcodeproj') }
abort("no .xcodeproj under #{ios_dir}") if projects.empty?
abort("ambiguous projects under #{ios_dir}: #{projects.join(', ')}") if projects.size > 1
project_path = projects.first

app_name = 'DroverWatch'
widget_name = 'DroverWatchWidget'
# The iPHONE home-screen widget (DROVE-260). It is grafted by this script
# rather than one of its own for the reason the watch targets are: ios/ is
# gitignored and prebuild rewrites it, so every target this project has must be
# re-attached from tracked sources on every build, and one idempotent script
# that tears down everything it owns before rebuilding it cannot leave half a
# project behind the way two racing ones could.
#
# Its sources are a SIBLING of the watch dir rather than a third argument, so
# the Podfile's post_integrate hook — which bakes its arguments into the
# Podfile text and re-runs this after CocoaPods — keeps working untouched. A
# hook written before this existed would otherwise pass two paths to a script
# wanting three and take `pod install` down with it (BASED-98's build 7 shape).
phone_widget_name = 'DroverPhoneWidget'
phone_widget_dir = File.expand_path('../widget', watch_dir)
# DROVER_BUNDLE_ID is the fork's whole-set override (see app.config.js); the
# config plugin and Podfile hook pass IOS_BUNDLE_ID explicitly, but a bare
# `pnpm watch:graft` must not silently fall back to upstream's id when the
# drover override is exported (BASED-98).
host_bundle_id = ENV['IOS_BUNDLE_ID'] || ENV['DROVER_BUNDLE_ID'] || 'com.ex3ndr.happy'
# Apple requires the companion watch app's id to be the phone app's id plus
# `.watchkitapp`, and the widget's to extend the watch app's. Not free-form.
watch_bundle_id = "#{host_bundle_id}.watchkitapp"
widget_bundle_id = "#{watch_bundle_id}.widget"
# Apple imposes no such rule on an iOS extension, so this one is a choice. It
# must match app.config.js's appExtensions entry exactly or EAS mints a profile
# for a bundle id nothing builds.
phone_widget_bundle_id = "#{host_bundle_id}.widget"
team_id = ENV['IOS_TEAM_ID'] || '7Y7QU8QZ28'
deployment_target = ENV['WATCHOS_DEPLOYMENT_TARGET'] || '10.0'
# WidgetKit's `containerBackground(_:for:)` — which both widgets call, and
# which iOS 17 REQUIRES a widget to call or it draws with no background at all
# — is iOS 17. Expo's own floor for this SDK is higher than that, so this is a
# statement of what the code needs rather than a constraint anyone will feel.
ios_deployment_target = ENV['IPHONEOS_DEPLOYMENT_TARGET'] || '17.0'

# Version comes off the PHONE APP'S OWN Info.plist, not a default: the watch
# bundle inside an archive must carry the same CFBundleVersion as the phone
# bundle around it or Apple rejects the upload. A default of '1' here would
# recreate that mismatch one layer down, where nobody looks.
def host_plist_value(project_path, ios_dir, key, fallback)
  target_name = File.basename(project_path, '.xcodeproj')
  plist = File.join(ios_dir, target_name, 'Info.plist')
  return fallback unless File.exist?(plist)

  value = Xcodeproj::Plist.read_from_path(plist)[key]
  value.to_s.empty? || value.to_s.start_with?('$(') ? fallback : value.to_s
end

marketing_version = ENV['IOS_MARKETING_VERSION'] ||
                    host_plist_value(project_path, ios_dir, 'CFBundleShortVersionString', '1.0.0')
build_number = ENV['IOS_BUILD_NUMBER'] ||
               host_plist_value(project_path, ios_dir, 'CFBundleVersion', '1')

project = Xcodeproj::Project.open(project_path)
host_name = File.basename(project_path, '.xcodeproj')
host = project.targets.find { |t| t.name == host_name } ||
       project.targets.find { |t| t.product_type == 'com.apple.product-type.application' }
abort("no host application target in #{project_path}") unless host

# --- pin the PHONE app's entitlements before anything else -----------------
# expo's entitlements mod picks its output path by asking the project, and on
# a project that already carries the watch targets it can answer with a WATCH
# target's name against the PHONE's source root — writing the phone's
# aps-environment and associated-domains into
# `ios/<Host>/DroverWatchWidget.entitlements` and pointing the phone target
# there. On a reused `ios/` the correct file already exists so the bug never
# shows; on a FRESH checkout the archive then dies with "no entitlements at
# ios/<Host>/<Host>.entitlements", which is where build 8 lost an hour.
# Pinning the setting here settles the answer before expo asks it.
host_entitlements = "#{host_name}/#{host_name}.entitlements"
host.build_configurations.each do |config|
  config.build_settings['CODE_SIGN_ENTITLEMENTS'] = host_entitlements
end
entitlements_path = File.join(ios_dir, host_entitlements)
unless File.exist?(entitlements_path)
  FileUtils.mkdir_p(File.dirname(entitlements_path))
  Xcodeproj::Plist.write_to_path({}, entitlements_path)
end

# --- the app group, on the PHONE app too (DROVE-260) -----------------------
# The group is how the phone tells the home-screen widget anything: WidgetKit
# renders the widget in a separate process with no store and no socket, so a
# shared container is the only channel there is. app.config.js declares it as
# `ios.entitlements` so EAS mints a profile carrying the capability, and
# expo's entitlements base mod writes it into the file above — but that mod
# runs AFTER this dangerous one and only merges what it is given, so on a
# fresh ios/ this file is the empty plist written a moment ago until it does.
#
# Written here as well, and MERGED rather than assigned, so the ordering
# cannot matter: whichever of the two runs last, the group is present and
# nothing else in the file is lost. A missing group does not fail a build —
# it produces a widget that says "Not yet synced" forever, which is the kind
# of failure that reaches a home screen instead of a log.
app_group = 'group.com.bitspur.drover'
entitlements = Xcodeproj::Plist.read_from_path(entitlements_path) || {}
groups = Array(entitlements['com.apple.security.application-groups'])
unless groups.include?(app_group)
  entitlements['com.apple.security.application-groups'] = groups + [app_group]
  Xcodeproj::Plist.write_to_path(entitlements, entitlements_path)
end

# --- tear down a previous run ---------------------------------------------
# Host references FIRST. Removing a target leaves any dependency still
# pointing at it dangling, and a dangling PBXTargetDependency is a project
# Xcode refuses to open — so unhook before deleting, never after.
grafted = [app_name, widget_name, phone_widget_name]
host.build_phases
    .select { |p| p.respond_to?(:name) && ['Embed Watch Content', 'Embed Foundation Extensions'].include?(p.name) }
    .each { |p| p.remove_from_project }
host.dependencies
    .select { |d| d.target.nil? || grafted.include?(d.target.name) }
    .each { |d| d.remove_from_project }

grafted.each do |name|
  project.targets.select { |t| t.name == name }.each(&:remove_from_project)
  project.main_group.children
         .select { |c| c.respond_to?(:name) && c.name == name }
         .each(&:remove_from_project)
end

# --- helpers ---------------------------------------------------------------

FILE_TYPES = {
  '.swift' => 'sourcecode.swift',
  '.plist' => 'text.plist.xml',
  '.entitlements' => 'text.plist.entitlements',
  '.xcassets' => 'folder.assetcatalog'
}.freeze

# Reference the tracked sources IN PLACE (../watch/...) rather than copying
# them into ios/. Editing the watch app in Xcode then edits the file actually
# under version control, and a regenerated ios/ loses nothing.
def reference(project, group, relative_path)
  ref = project.new(Xcodeproj::Project::Object::PBXFileReference)
  ref.path = relative_path
  ref.source_tree = 'SOURCE_ROOT'
  ref.name = File.basename(relative_path)
  type = FILE_TYPES[File.extname(relative_path)]
  ref.last_known_file_type = type if type
  group << ref
  ref
end

# `prefix` is how the reference is spelled from ios/, and it defaults to the
# watch dir because that is where all but one target's sources live. The phone
# widget passes '../widget' (DROVE-260).
def swift_relative(root, subdir, prefix = '../watch')
  Dir.glob(File.join(root, subdir, '**', '*.swift')).sort.map do |path|
    "#{prefix}/#{path.sub("#{root}/", '')}"
  end
end

def apply(target, settings)
  target.build_configurations.each do |config|
    settings.each { |key, value| config.build_settings[key] = value }
    next unless config.name == 'Debug'

    config.build_settings['SWIFT_OPTIMIZATION_LEVEL'] = '-Onone'
    config.build_settings['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] = 'DEBUG'
  end
end

common = {
  'SDKROOT' => 'watchos',
  'WATCHOS_DEPLOYMENT_TARGET' => deployment_target,
  'TARGETED_DEVICE_FAMILY' => '4',
  'SUPPORTED_PLATFORMS' => 'watchos watchsimulator',
  'SWIFT_VERSION' => '5.0',
  'MARKETING_VERSION' => marketing_version,
  'CURRENT_PROJECT_VERSION' => build_number,
  'GENERATE_INFOPLIST_FILE' => 'NO',
  'DEVELOPMENT_TEAM' => team_id,
  # YES, both targets. The watch app reaches the archive through the phone
  # app's Embed Watch Content phase and the widget through the watch app's
  # PlugIns embed. With SKIP_INSTALL=NO the watch app ALSO installs as a
  # second top-level product in Products/Applications, which turns the whole
  # archive into a Generic Xcode Archive — -exportArchive then reports an
  # EMPTY set of allowed export methods and the export fails. (BASED-94
  # defect 2, measured on a real build.)
  'SKIP_INSTALL' => 'YES',
  'ALWAYS_SEARCH_USER_PATHS' => 'NO',
  'CLANG_ENABLE_MODULES' => 'YES',
  # A generated project is not ours to argue with about warnings, and a watch
  # target that fails an archive on a deprecation is a lane that never ships.
  'SWIFT_TREAT_WARNINGS_AS_ERRORS' => 'NO',
  'GCC_TREAT_WARNINGS_AS_ERRORS' => 'NO'
}

# --- watch app -------------------------------------------------------------
watch_app = project.new_target(:application, app_name, :watchos, deployment_target, nil, :swift)
apply(watch_app, common.merge(
                   'PRODUCT_BUNDLE_IDENTIFIER' => watch_bundle_id,
                   'PRODUCT_NAME' => app_name,
                   # Info.plist's WKCompanionAppBundleIdentifier reads this;
                   # it is not a stock Xcode setting, so define it here rather
                   # than hardcoding the phone id into a tracked plist.
                   'HOST_BUNDLE_IDENTIFIER' => host_bundle_id,
                   'INFOPLIST_FILE' => "../watch/#{app_name}/Info.plist",
                   'CODE_SIGN_ENTITLEMENTS' => "../watch/#{app_name}/#{app_name}.entitlements",
                   'ASSETCATALOG_COMPILER_APPICON_NAME' => 'AppIcon',
                   'ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME' => 'AccentColor'
                 ))

app_group = project.main_group.new_group(app_name)
watch_app.add_file_references(
  swift_relative(watch_dir, app_name).map { |p| reference(project, app_group, p) }
)
assets = File.join(watch_dir, app_name, 'Assets.xcassets')
watch_app.add_resources([reference(project, app_group, "../watch/#{app_name}/Assets.xcassets")]) if Dir.exist?(assets)
reference(project, app_group, "../watch/#{app_name}/Info.plist")

# --- widget extension ------------------------------------------------------
widget = project.new_target(:app_extension, widget_name, :watchos, deployment_target, nil, :swift)
apply(widget, common.merge(
                'PRODUCT_BUNDLE_IDENTIFIER' => widget_bundle_id,
                'PRODUCT_NAME' => widget_name,
                'INFOPLIST_FILE' => "../watch/#{widget_name}/Info.plist",
                'CODE_SIGN_ENTITLEMENTS' => "../watch/#{widget_name}/#{widget_name}.entitlements",
                'SKIP_INSTALL' => 'YES'
              ))

widget_group = project.main_group.new_group(widget_name)
# DroverSnapshot.swift compiles into BOTH targets: it is the wire format
# between them, so one tracked copy is the point.
widget_sources = swift_relative(watch_dir, widget_name) +
                 swift_relative(watch_dir, "#{app_name}/Shared")
widget.add_file_references(
  widget_sources.map { |p| reference(project, widget_group, p) }
)
reference(project, widget_group, "../watch/#{widget_name}/Info.plist")

# --- iPhone home-screen widget (DROVE-260) ---------------------------------
# An iOS app extension, so almost none of `common` applies: that hash is
# watchOS end to end (SDKROOT, device family 4, the watchOS deployment
# target), and merging over it would leave a target claiming to be both.
# Spelled out instead, with only the version and team settings shared, because
# the settings that matter here are the ones that differ.
phone_widget = project.new_target(:app_extension, phone_widget_name, :ios, ios_deployment_target, nil, :swift)
apply(phone_widget,
      'SDKROOT' => 'iphoneos',
      'IPHONEOS_DEPLOYMENT_TARGET' => ios_deployment_target,
      # iPhone and iPad. NOT '4' — the self-check below asserts the watch
      # targets are '4' precisely because Expo and CocoaPods keep stamping
      # '1,2' on everything, and on THIS target '1,2' is the right answer.
      'TARGETED_DEVICE_FAMILY' => '1,2',
      'SUPPORTED_PLATFORMS' => 'iphoneos iphonesimulator',
      'SWIFT_VERSION' => '5.0',
      'MARKETING_VERSION' => marketing_version,
      'CURRENT_PROJECT_VERSION' => build_number,
      'GENERATE_INFOPLIST_FILE' => 'NO',
      'DEVELOPMENT_TEAM' => team_id,
      # Same reason as the watch targets: an extension reaches the archive
      # through the host's embed phase, and installing it as a second
      # top-level product turns the archive generic and empties the set of
      # export methods (BASED-94 defect 2).
      'SKIP_INSTALL' => 'YES',
      'ALWAYS_SEARCH_USER_PATHS' => 'NO',
      'CLANG_ENABLE_MODULES' => 'YES',
      'SWIFT_TREAT_WARNINGS_AS_ERRORS' => 'NO',
      'GCC_TREAT_WARNINGS_AS_ERRORS' => 'NO',
      'PRODUCT_BUNDLE_IDENTIFIER' => phone_widget_bundle_id,
      'PRODUCT_NAME' => phone_widget_name,
      'INFOPLIST_FILE' => "../widget/#{phone_widget_name}/Info.plist",
      'CODE_SIGN_ENTITLEMENTS' => "../widget/#{phone_widget_name}/#{phone_widget_name}.entitlements")

phone_widget_group = project.main_group.new_group(phone_widget_name)
# DroverSnapshot.swift compiles in here too, and ONLY that file out of Shared.
# The rest of Shared is the wrist's — cues, reach, drafts, the demo — and an
# iOS extension that compiled them would be carrying watch behaviour it can
# never run. This one is the app-group plumbing (the suite name, the shared
# ISO-8601 coders) that DroverWidgetFace.swift extends.
phone_widget_sources = swift_relative(phone_widget_dir, phone_widget_name, '../widget') +
                       ["../watch/#{app_name}/Shared/DroverSnapshot.swift"]
phone_widget.add_file_references(
  phone_widget_sources.map { |p| reference(project, phone_widget_group, p) }
)
reference(project, phone_widget_group, "../widget/#{phone_widget_name}/Info.plist")

# --- embedding -------------------------------------------------------------
# Widget into the watch app's PlugIns, watch app into the phone app's Watch
# directory. Both need CodeSignOnCopy, or the embedded bundle ships with a
# signature that is not the one the outer bundle was signed with and the
# install is rejected on device.
embed_widget = watch_app.new_copy_files_build_phase('Embed Foundation Extensions')
embed_widget.symbol_dst_subfolder_spec = :plug_ins
embed_widget.dst_path = ''
embed_widget.add_file_reference(widget.product_reference).settings =
  { 'ATTRIBUTES' => %w[RemoveHeadersOnCopy CodeSignOnCopy] }
watch_app.add_dependency(widget)

embed_watch = host.new_copy_files_build_phase('Embed Watch Content')
embed_watch.symbol_dst_subfolder_spec = :products_directory
embed_watch.dst_path = '$(CONTENTS_FOLDER_PATH)/Watch'
embed_watch.add_file_reference(watch_app.product_reference).settings =
  { 'ATTRIBUTES' => %w[RemoveHeadersOnCopy CodeSignOnCopy] }
host.add_dependency(watch_app)

# The phone widget into the PHONE app's PlugIns (DROVE-260). A separate phase
# from 'Embed Watch Content' above because the destination is different — an
# app extension goes to PlugIns, a watch app to Contents/Watch — and Xcode
# names them differently for that reason. CodeSignOnCopy for the same reason
# as every other embed here.
embed_phone_widget = host.new_copy_files_build_phase('Embed Foundation Extensions')
embed_phone_widget.symbol_dst_subfolder_spec = :plug_ins
embed_phone_widget.dst_path = ''
embed_phone_widget.add_file_reference(phone_widget.product_reference).settings =
  { 'ATTRIBUTES' => %w[RemoveHeadersOnCopy CodeSignOnCopy] }
host.add_dependency(phone_widget)

project.save

# --- self-check ------------------------------------------------------------
# BASED-94 defect 1: Expo's withDeviceFamily base mod stamps
# TARGETED_DEVICE_FAMILY "1,2" on every configuration with a PRODUCT_NAME, the
# watch targets included, and base mods run AFTER the dangerous mod that
# grafts them. Read the setting back and die on anything but "4" rather than
# shipping an archive Apple will reject.
[watch_app, widget].each do |target|
  target.build_configurations.each do |config|
    family = config.build_settings['TARGETED_DEVICE_FAMILY'].to_s
    next if family == '4'

    abort("#{target.name}/#{config.name}: TARGETED_DEVICE_FAMILY is #{family.inspect}, expected \"4\"")
  end
end

# The phone widget's own version of that hazard runs the other way (DROVE-260).
# Nothing stamps SDKROOT the way things stamp the device family, but this
# target sits two lines away from three watchOS ones and a copied setting here
# builds a watch bundle into the phone app's PlugIns — which links, embeds, and
# fails on device with no useful message. Cheap to assert, so assert it.
phone_widget.build_configurations.each do |config|
  sdk = config.build_settings['SDKROOT'].to_s
  abort("#{phone_widget.name}/#{config.name}: SDKROOT is #{sdk.inspect}, expected \"iphoneos\"") unless sdk == 'iphoneos'
end

puts "native targets attached to #{File.basename(project_path)}: " \
     "#{app_name} (#{watch_bundle_id}), #{widget_name} (#{widget_bundle_id}), " \
     "#{phone_widget_name} (#{phone_widget_bundle_id})"
