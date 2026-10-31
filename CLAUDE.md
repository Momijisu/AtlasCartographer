# Working rules for AtlasCartographer

`main` is the live app on GitHub Pages: every push lands on the owner's
devices. `preview` is published at `…/AtlasCartographer/preview/` for trying
larger changes first. These rules exist to catch problems before they reach
the owner, not after.

## 1. Prove it works before you push

- **Run it, don't reason about it.** Every change is exercised in a real
  browser (Playwright, `chromium.launch()`) before it is committed: the flow
  the user asked for, then the console checked for errors.
- **Test the follow-on interactions, not just the feature.** For any UI change,
  also try:
  - the reverse action (collapse after expand, undo after do, close after open);
  - what happens to whatever else is open (does the picker still behave when
    another tool is chosen? does a panel cover the canvas?);
  - the narrowest phone width (375px, touch) and a large real-sized map;
  - mouse, touch and pen, including middle- and right-button.
- **Look at the screenshot, and say what you saw.** Take one after each
  visual change and read it. If something is off, fix it before reporting.
- **Measure instead of eyeballing** anything about alignment, size, speed or
  position (bounding boxes, pixel sampling, timings), and report the numbers.
- **Check results, not just that something happened.** A test that only sees
  a download start, or a toast appear, proves little: open the file, sample
  the pixels, read the stored record.
- **Reproduce a reported bug first**, with a script that fails, then show the
  same script passing. If you can't reproduce it, say so and ask; don't ship
  a guess as a fix.
- **The tests live in `tests/`.** Add a script for every feature and fix, and
  run `tests/runall.sh` before every push (it serves the app and mocks
  OneDrive; `tests/runall.sh shapetest` runs one).
- **A test that fails is a finding**: decide whether the app or the test is
  wrong, fix that one, and say which it was.

## 2. Show before you build, when it's visual or the user is unsure

- For a new layout, tool, panel or anything the user describes with "I think",
  "maybe" or "could we": build it on `preview`, send screenshots (desktop and
  phone), and wait for a yes before it goes to `main`.
- Offer two or three options as images when there's a real choice (shapes,
  styles, layouts), with your recommendation.
- If the user is sending several screenshots or messages in a batch, wait for
  the batch to finish before starting.

## 3. Ask about structure, decide the details

- Anything that sets the **data model** (folders, categories, ids, what syncs)
  gets a concrete proposal with an example before any code: "Your library would
  look like: Stamps / Trees / Oak 1..4. Right?" A one-line answer is not
  enough to build a migration-sized decision on.
- Small, local choices (spacing, wording, icons) you decide and mention.
- A question from the user ("do we have X?") is a question: answer it and
  offer to build; don't build unasked.

## 4. Scope

- Do what was asked, completely. When asked to audit or review something, list
  the categories you checked against the reference (e.g. every Inkarnate brush
  setting) so gaps are visible.
- Don't widen a change on your own. If you spot an unrelated bug, fix it in its
  own commit and mention it in one line, or note it for later.
- One feature per release where you can, so a problem is easy to trace.

## 5. Reporting

- Lead with the outcome in 2-4 lines: what changed, the version, how to get it
  (reload), what to look at.
- Then **what you verified and how** (in user terms: "dragged a stamp, undid,
  checked at phone width"), and **what you could not verify** (real OneDrive,
  installing the app, the user's own device). Never write "everything is fixed"
  for things only your own tests have seen.
- Keep it short enough to read on a phone. Details only where they help the
  user act.
- Don't send status messages that need nothing from the user (e.g. "the test
  server stopped").

## 6. Releases

- Bump `js/version.js`, add new files to `sw.js`'s SHELL list, update the
  README's feature list, commit with a clear user-facing message.
- Small fixes go straight to `main`. Larger or visual changes go to `preview`
  first; they reach `main` once the owner has tried them and said yes.
- The preview keeps its own data on the device and its maps in their own
  OneDrive folder (`preview/` in the app folder), so trying it can't damage
  real maps. It shares the art library (assets.json, assets/, thumbs/): a
  change on the preview that rewrites or deletes art reaches the real app.
- The preview's sign-in needs `https://momijisu.github.io/AtlasCartographer/preview/`
  listed as an SPA redirect URI in the Azure app registration.
- Never commit art. Test fixtures in `tests/pack*/` are generated shapes.
