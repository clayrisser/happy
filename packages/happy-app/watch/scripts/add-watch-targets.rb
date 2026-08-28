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
# DROVER_BUNDLE_ID is the fork's whole-set override (see app.config.js); the
# config plugin and Podfile hook pass IOS_BUNDLE_ID explicitly, but a bare
# `pnpm watch:graft` must not silently fall back to upstream's id when the
# drover override is exported (BASED-98).
host_bundle_id = ENV['IOS_BUNDLE_ID'] || ENV['DROVER_BUNDLE_ID'] || 'com.ex3ndr.happy'
# Apple requires the companion watch app's id to be the phone app's id plus
# `.watchkitapp`, and the widget's to extend the watch app's. Not free-form.
watch_bundle_id = "#{host_bundle_id}.watchkitapp"
widget_bundle_id = "#{watch_bundle_id}.widget"
team_id = ENV['IOS_TEAM_ID'] || '7Y7QU8QZ28'
deployment_target = ENV['WATCHOS_DEPLOYMENT_TARGET'] || '10.0'

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

# --- tear down a previous run ---------------------------------------------
# Host references FIRST. Removing a target leaves any dependency still
# pointing at it dangling, and a dangling PBXTargetDependency is a project
# Xcode refuses to open — so unhook before deleting, never after.
host.build_phases
    .select { |p| p.respond_to?(:name) && p.name == 'Embed Watch Content' }
    .each { |p| p.remove_from_project }
host.dependencies
    .select { |d| d.target.nil? || [app_name, widget_name].include?(d.target.name) }
    .each { |d| d.remove_from_project }

[app_name, widget_name].each do |name|
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

def swift_relative(watch_dir, subdir)
  Dir.glob(File.join(watch_dir, subdir, '**', '*.swift')).sort.map do |path|
    "../watch/#{path.sub("#{watch_dir}/", '')}"
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

puts "watch targets attached to #{File.basename(project_path)}: " \
     "#{app_name} (#{watch_bundle_id}), #{widget_name} (#{widget_bundle_id})"
