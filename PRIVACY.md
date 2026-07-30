# Privacy

Delta Sync sends the selected vault files, file paths, Git commit metadata, repository owner, repository name, branch, and device name directly from Obsidian to GitHub's API.

- No telemetry, analytics, advertisements, or third-party tracking are included.
- File contents are never sent to the plugin author.
- The GitHub token is stored using Obsidian Secret Storage and is never written to plugin settings or logs.
- Sync logs contain timestamps, counts, commit identifiers, and error messages, but not tokens or file contents.
- `.obsidian`, `.trash`, `.git`, configured exclusions, and files over the size limit are not uploaded by this plugin.

A private GitHub repository is not end-to-end encrypted by this plugin. GitHub can technically process repository contents according to its service terms. Do not use this release for material that requires client-side encryption.

Disconnecting clears the local baseline and replaces the stored token with an empty value. It does not delete local files, remote files, commits, or the repository.
