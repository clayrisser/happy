import './sources/polyfills/screenOrientation';
import './sources/unistyles';
// Module scope, and BEFORE expo-router/entry. expo-notifications resolves a
// background notification task by looking for a handler registered as the JS
// bundle loads; registered from inside a component it does not exist yet on the
// cold launch iOS performs to deliver a content-available push, so the wake
// arrives, finds no handler, and the wrist is never refreshed. That silent
// no-op is indistinguishable from the push never being sent.
import './sources/sync/droverBackgroundNotification';
import 'expo-router/entry';