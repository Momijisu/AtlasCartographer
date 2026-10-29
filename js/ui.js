// Shared UI state used by app.js and the views.

// cleanup: called before the next view renders (e.g. to stop the editor).
// onRemote: lets the current view take changes from another device itself
// instead of being re-rendered.
export const state = { cleanup: null, onRemote: null, installPrompt: null, route: null };

export function setTitle(t) { document.title = t ? `${t} · AtlasCartographer` : 'AtlasCartographer'; }
