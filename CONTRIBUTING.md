# Contributing

Thanks for helping improve Personal ClickUp Manager. Changes reach `main`
only through a pull request that the maintainer reviews and tests. Releases
(the version number, the release zip and the update notice that every
installed copy follows) are made by the maintainer, in one batch.

## 1. Get the code

```bash
git clone https://github.com/Dipson-bot/personal-clickup-manager.git
cd personal-clickup-manager
git checkout -b fix/short-description
```

Work on your own branch (`fix/...` for a fix, `feature/...` for something
new). `main` is protected: it can't be pushed to directly.

## 2. Run it while you work

Use a **separate Chrome profile** for testing. Your copy has the same
extension ID as the installed extension, and Chrome can't load both in one
profile.

1. In the test profile open `chrome://extensions`, switch on **Developer mode**.
2. **Load unpacked** and pick your folder.
3. After a code change, press the reload icon on the extension's card (the
   background service worker only picks up changes after a reload).

Connect it to ClickUp with your own token (ClickUp setup). Test the part you
changed, and anything that shares code with it.

## 3. Rules for every change

- **One line in `CHANGELOG.md`** in plain words for the people who use it:
  under the top `## vX.Y.Z` heading if that version isn't on the
  [Releases](https://github.com/Dipson-bot/personal-clickup-manager/releases)
  page yet, otherwise under a new `## Unreleased` heading at the top.
- **Don't change the version** in `manifest.json`, and don't edit
  `update-policy.json` or run `release.ps1` - releases are the maintainer's.
- **A new or moved feature people use:** add or update its "How to" entry in
  the `GUIDES` list in `pcm-search.js`, so the extension's search can explain it.
- **A new file that ships with the extension:** add it to both file lists in
  `release.ps1` (`$js` and `$files`) and to the build list in `options.js`
  (next to `"lib-drive.js"`). Otherwise it's missing from the release.
- **Dates:** use the extension's own calendar picker (`PcmCalendar`), never the
  browser's date input.
- **Saving to ClickUp:** show that it's in progress ("Saving…") and only say
  it's done once ClickUp confirmed it.
- **No personal data anywhere** - code, comments, test data, screenshots in the
  PR: no real client or colleague names, emails, tokens, API keys, workspace or
  user IDs, private links. Use invented examples (Acme Plumbing, Sam Rivera).
- **Commits are credited to you only:** no `Co-authored-by` trailers or
  "generated with ..." lines in commits, pull requests or files.
- Keep changes focused: one fix or feature per pull request.

## 4. Open a pull request

1. Before pushing, check every script still parses:
   `node --check yourfile.js` for each file you changed.
2. `git push -u origin fix/short-description`
3. Open a pull request into `main` and write:
   - what changed, and why (the problem it fixes),
   - how you tested it (steps someone else can repeat),
   - a screenshot for anything visible.

The maintainer reviews it, runs the full test suite, tries it, and merges it.
It then goes out with the next release.
