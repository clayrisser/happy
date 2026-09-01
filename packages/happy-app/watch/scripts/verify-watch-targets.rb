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
# The iPHONE widget (DROVE-260). Grafted by the same script, so it is checked
# by the same gate — a target that exists only when the graft ran is exactly
# the thing this file was written to catch.
phone_widget_name = 'DroverPhoneWidget'
app_group = 'group.com.bitspur.drover'

targets = [app_name, widget_name].map do |name|
  target = project.targets.find { |t| t.name == name }
  failures << "#{name}: target missing from the project (the graft did not run)" unless target
  target
end.compact

phone_widget = project.targets.find { |t| t.name == phone_widget_name }
failures << "#{phone_widget_name}: target missing from the project (the graft did not run)" unless phone_widget

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

# The phone widget's mirror of the same three, with the answers that are right
# for an iOS extension (DROVE-260). Its device family is '1,2' — the value the
# checks above exist to REFUSE on a watch target — so the two lists cannot
# share a loop, and writing them apart is what keeps the next reader from
# "fixing" one to match the other.
if phone_widget
  phone_widget.build_configurations.each do |config|
    settings = config.build_settings
    sdk = settings['SDKROOT'].to_s
    failures << "#{phone_widget_name}/#{config.name}: SDKROOT=#{sdk.inspect}, expected \"iphoneos\"" unless sdk == 'iphoneos'

    family = settings['TARGETED_DEVICE_FAMILY'].to_s
    unless %w[1 1,2].include?(family)
      failures << "#{phone_widget_name}/#{config.name}: TARGETED_DEVICE_FAMILY=#{family.inspect}, " \
                  'expected "1,2" — a "4" here is a watchOS setting copied onto the phone widget'
    end

    skip = settings['SKIP_INSTALL'].to_s
    failures << "#{phone_widget_name}/#{config.name}: SKIP_INSTALL=#{skip.inspect}, expected \"YES\"" unless skip == 'YES'
  end

  # The widget renders from the app group and nothing else, so an entitlements
  # file that does not name it is a widget stuck on "Not yet synced" — a
  # failure that reaches a home screen rather than a build log, which is
  # exactly the kind this file exists to turn into a non-zero exit.
  ent = phone_widget.build_configurations
                    .map { |c| c.build_settings['CODE_SIGN_ENTITLEMENTS'].to_s }
                    .reject(&:empty?)
                    .first
  if ent.to_s.empty?
    failures << "#{phone_widget_name}: no CODE_SIGN_ENTITLEMENTS, so the app group is not claimed"
  else
    path = File.expand_path(ent, ios_dir)
    if !File.exist?(path)
      failures << "#{phone_widget_name}: entitlements missing at #{path}"
    else
      groups = Array(Xcodeproj::Plist.read_from_path(path)['com.apple.security.application-groups'])
      unless groups.include?(app_group)
        failures << "#{phone_widget_name}: entitlements at #{path} do not claim #{app_group}"
      end
    end
  end
end

# And the HOST app's own claim on the group. This is the half that is new: the
# phone never needed the group while the wrist was the only extra surface,
# because WatchConnectivity is its own channel. Without it the phone's write
# goes into a container the widget cannot open and nothing anywhere says so.
host = project.targets.find { |t| t.product_type == 'com.apple.product-type.application' && t.name != app_name }
if host
  host_ent = host.build_configurations
                 .map { |c| c.build_settings['CODE_SIGN_ENTITLEMENTS'].to_s }
                 .reject(&:empty?)
                 .first
  path = host_ent.to_s.empty? ? nil : File.expand_path(host_ent, ios_dir)
  if path.nil? || !File.exist?(path)
    failures << "#{host.name}: no entitlements file on disk, so the phone cannot write the widget's app group"
  else
    groups = Array(Xcodeproj::Plist.read_from_path(path)['com.apple.security.application-groups'])
    unless groups.include?(app_group)
      failures << "#{host.name}: entitlements at #{path} do not claim #{app_group} — " \
                  'the phone app would write the widget face into a container the widget cannot read'
    end
  end
end

# Defect 3: Expo's Info.plist mods resolve their target file from the pbxproj
# and, with a second application target grafted in, have written the PHONE
# app's merged plist over the TRACKED watch plist. Those files are build
# inputs: a literal version in them is a version that cannot match the phone.
watch_dir = File.expand_path(File.join(__dir__, '..'))
phone_widget_dir = File.expand_path('../widget', watch_dir)
{
  app_name => File.join(watch_dir, app_name, 'Info.plist'),
  widget_name => File.join(watch_dir, widget_name, 'Info.plist'),
  # Same rule, same reason: the phone widget is embedded in the same archive,
  # so a literal version in its plist is a version that can disagree with the
  # app around it (DROVE-260).
  phone_widget_name => File.join(phone_widget_dir, phone_widget_name, 'Info.plist')
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
    ([*targets, phone_widget].compact).each do |target|
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
  puts "native targets verified: #{app_name}, #{widget_name}, #{phone_widget_name}"
  exit 0
end

warn 'native target verification FAILED:'
failures.each { |f| warn "  - #{f}" }
exit 1
