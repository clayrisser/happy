#!/usr/bin/env ruby
# frozen_string_literal: true

# Gate the four BASED-94 defects that let a watch graft reach Apple broken.
# Each check below refused a build that xcodebuild had already called green,
# so this runs after prebuild/pod install and exits non-zero rather than
# letting a rejected archive get uploaded.
#
# Usage: verify-watch-targets.rb <ios dir>

require 'xcodeproj'

ios_dir = ARGV[0] or abort('usage: verify-watch-targets.rb <ios dir>')
projects = Dir.glob(File.join(ios_dir, '*.xcodeproj')).reject { |p| p.end_with?('Pods.xcodeproj') }
abort("no .xcodeproj under #{ios_dir}") if projects.empty?
project = Xcodeproj::Project.open(projects.first)

failures = []
app_name = 'DroverWatch'
widget_name = 'DroverWatchWidget'

targets = [app_name, widget_name].map do |name|
  target = project.targets.find { |t| t.name == name }
  failures << "#{name}: target missing from the project (the graft did not run)" unless target
  target
end.compact

targets.each do |target|
  target.build_configurations.each do |config|
    settings = config.build_settings
    # Defect 1: Expo's withDeviceFamily base mod stamps "1,2" on every
    # configuration with a PRODUCT_NAME, and base mods run AFTER the
    # dangerous mod that grafts the watch targets.
    family = settings['TARGETED_DEVICE_FAMILY'].to_s
    failures << "#{target.name}/#{config.name}: TARGETED_DEVICE_FAMILY=#{family.inspect}, expected \"4\"" unless family == '4'

    # Defect 2: SKIP_INSTALL=NO puts the watch app in Products/Applications as
    # a second top-level product, making the archive a Generic Xcode Archive
    # whose allowed export-method set is empty.
    skip = settings['SKIP_INSTALL'].to_s
    failures << "#{target.name}/#{config.name}: SKIP_INSTALL=#{skip.inspect}, expected \"YES\"" unless skip == 'YES'

    sdk = settings['SDKROOT'].to_s
    failures << "#{target.name}/#{config.name}: SDKROOT=#{sdk.inspect}, expected \"watchos\"" unless sdk == 'watchos'
  end
end

# Defect 3: Expo's Info.plist mods resolve their target file from the pbxproj
# and, with a second application target grafted in, have written the PHONE
# app's merged plist over the TRACKED watch plist. Those files are build
# inputs: a literal version in them is a version that cannot match the phone.
watch_dir = File.expand_path(File.join(__dir__, '..'))
{
  app_name => File.join(watch_dir, app_name, 'Info.plist'),
  widget_name => File.join(watch_dir, widget_name, 'Info.plist')
}.each do |name, plist|
  unless File.exist?(plist)
    failures << "#{name}: tracked Info.plist missing at #{plist}"
    next
  end
  values = Xcodeproj::Plist.read_from_path(plist)
  %w[CFBundleVersion CFBundleShortVersionString].each do |key|
    value = values[key].to_s
    unless value.start_with?('$(')
      failures << "#{name}: #{key} is the literal #{value.inspect} — it must stay a build variable, " \
                  'or the embedded bundle can disagree with the phone app and Apple rejects the upload'
    end
  end
  # Defect 4: WKBackgroundModes "app-refresh" is not a value that key accepts;
  # App Store validation refuses the upload (409 STATE_ERROR.VALIDATION_ERROR).
  modes = Array(values['WKBackgroundModes'])
  failures << "#{name}: WKBackgroundModes contains \"app-refresh\", which App Store validation rejects" if modes.include?('app-refresh')
end

# Defect 5: the watch targets' CURRENT_PROJECT_VERSION must equal the phone's
# CFBundleVersion. The plists above keep it a build variable, so the number
# comes from the target settings — and the Podfile's post_integrate hook bakes
# that number into its own text and re-stamps the targets AFTER prebuild. A
# hook written for an earlier build silently wins over the graft, and the
# mismatch only surfaces at Apple's validation, after a 20-minute archive.
host_plist = Dir.glob(File.join(ios_dir, '*', 'Info.plist'))
               .reject { |p| p.include?('/Pods/') }
               .first
if host_plist
  want = Xcodeproj::Plist.read_from_path(host_plist)['CFBundleVersion'].to_s
  if want.empty? || want.start_with?('$(')
    warn "note: phone CFBundleVersion in #{host_plist} is #{want.inspect}; skipping the version-match check"
  else
    targets.each do |target|
      target.build_configurations.each do |config|
        got = config.build_settings['CURRENT_PROJECT_VERSION'].to_s
        next if got == want

        failures << "#{target.name}/#{config.name}: CURRENT_PROJECT_VERSION=#{got.inspect}, " \
                    "phone app is #{want.inspect} — Apple rejects an embedded bundle whose build " \
                    'number disagrees (check the baked IOS_BUILD_NUMBER in ios/Podfile)'
      end
    end
  end
end

if failures.empty?
  puts "watch targets verified: #{app_name}, #{widget_name}"
  exit 0
end

warn 'watch target verification FAILED:'
failures.each { |f| warn "  - #{f}" }
exit 1
