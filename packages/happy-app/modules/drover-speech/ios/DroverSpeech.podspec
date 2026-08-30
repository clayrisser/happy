Pod::Spec.new do |s|
  s.name           = 'DroverSpeech'
  s.version        = '1.0.0'
  s.summary        = 'On-device speech out and speech in for Cattle Drover'
  s.description    = 'Reads assistant replies aloud as they land and dictates prompts back, both on-device (DROVE-30).'
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
