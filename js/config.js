// OneDrive / Microsoft sign-in configuration.
//
// AtlasCartographer shares WorldAtlas's Azure app registration: add this app's
// address as a second "Single-page application" redirect URI there (see
// README.md → "OneDrive sync"). Leave CLIENT_ID empty to have each device
// enter its own on the Settings page instead.
export const CLIENT_ID = 'aaec4fa5-f6e4-4251-8998-177a2fedc48b';

// "common" allows both personal Microsoft accounts and work/school accounts.
export const AUTHORITY = 'common';

// The registration's app folder is OneDrive → Apps → WorldAtlas. This app keeps
// everything in its own subfolder there, apart from WorldAtlas's files.
export const REMOTE_DIR = 'Cartographer';
