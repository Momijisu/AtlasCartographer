// Shared UI state used by app.js and the views.

// cleanup: called before the next view renders (e.g. to stop the editor).
// onRemote: lets the current view take changes from another device itself
// instead of being re-rendered.
export const state = { cleanup: null, onRemote: null, installPrompt: null, route: null, busy: new Set() };

// busy: functions that say whether something is in progress that a page reload
// would cut short (an art import, a stroke being drawn).
export const isBusy = () => [...state.busy].some((fn) => fn());

export function setTitle(t) { document.title = t ? `${t} · AtlasCartographer` : 'AtlasCartographer'; }
