Pod::Spec.new do |s|
  s.name           = 'DroverWatch'
  s.version        = '1.0.0'
  s.summary        = 'WatchConnectivity bridge for the Cattle Drover wrist surface'
  s.description    = 'Publishes pending permission gates to the paired watch and forwards answers back (BASED-98).'
  s.author         = 'Bitspur'
  s.homepage       = 'https://basedlinux.com'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
