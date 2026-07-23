# Releasing Docs Sync

## Before the first release

1. Publish this source repository publicly on GitHub.
2. Enable **Settings → Code security → Private vulnerability reporting** so `SECURITY.md` points to a working private channel.
3. Confirm that `docs-sync` and `Docs Sync` are still available in the current Obsidian community plugin list.
4. Test the plugin on desktop and mobile with an isolated vault and a dedicated private repository.

## Create a release

1. Keep the version identical in `package.json`, `manifest.json`, and `versions.json`. Use an `x.y.z` version without a `v` prefix.
2. Run:

   ```bash
   npm ci
   npm run format:check
   npm run lint
   npm run typecheck
   npm test
   npm run build
   npm run verify:release
   ```

3. Commit and push the release-ready source.
4. Tag the commit with the exact version, for example `0.1.0`, and push the tag. The release workflow creates the GitHub Release and attaches `main.js`, `manifest.json`, and `styles.css`.
5. Download the three assets from the published release and install them in a clean vault as a final smoke test.

## Submit to Obsidian

1. Sign in at <https://community.obsidian.md> and link the GitHub account that owns this repository.
2. Open **Plugins → New plugin** and submit the public repository URL.
3. Review the automated report. For any required fix, increment the version and publish a new release; never replace an already published release asset in place.

The repository default branch must contain the same current `manifest.json`, while installable files must be attached to the GitHub Release whose tag exactly matches its version.
