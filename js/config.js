// OneDrive / Microsoft sign-in configuration.
//
// The "Application (client) ID" of AtlasCartographer's Azure app registration
// (see README.md → "OneDrive sync"). Leave it empty to have each device enter
// its own on the Settings page instead.
export const CLIENT_ID = '60010beb-8110-4e8c-b4f4-4176ebd83d41';

// "common" allows both personal Microsoft accounts and work/school accounts.
export const AUTHORITY = 'common';

// The preview (the preview branch, published at …/preview/) keeps its own
// data on the device and its own maps in OneDrive, so trying it can't harm
// real maps. It shares the art library. Its offline cache is its own too.
export const PREVIEW = /\/preview\/(index\.html)?$/.test(location.pathname);
export const CACHE_PREFIX = PREVIEW ? 'cartographer-preview-' : 'cartographer-';
export const ownCache = (k) => k.startsWith(CACHE_PREFIX) && (PREVIEW || !k.startsWith('cartographer-preview-'));
