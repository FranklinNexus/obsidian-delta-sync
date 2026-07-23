# Docs Sync

Docs Sync is an Obsidian plugin that synchronizes notes and small attachments through a branch in a private GitHub repository. It is designed for desktop and mobile Obsidian without Git CLI, Node file-system, or Electron dependencies.

> Back up your vault before enabling any synchronization plugin. Do not run Docs Sync together with Obsidian Sync, iCloud vault sync, Remotely Save, Self-hosted LiveSync, or another tool that writes the same files.

## Features

- One verified Git commit per sync operation.
- Optimistic branch-head checks and no force pushes.
- Three-way change detection from the last successful common commit.
- Conflict copies preserve both versions instead of silently overwriting a note.
- Remote deletions use the Obsidian trash.
- Manual, startup, foreground, and interval synchronization.
- `.obsidian`, `.trash`, `.git`, oversized files, and custom globs are excluded.
- GitHub tokens are stored with Obsidian Secret Storage, not plugin `data.json`.

## Setup

1. Back up the vault.
2. Create or select a private GitHub repository and a dedicated branch.
3. Create a fine-grained personal access token limited to that repository with **Contents: Read and write**.
4. Open **Settings → Community plugins → Docs Sync**.
5. Enter the owner, repository, branch, device name, and token.
6. Test the connection and preview the first sync.
7. Review the counts, then explicitly confirm the first sync.

Automatic sync is disabled by default. The plugin only runs while Obsidian is open.

## Development

```bash
npm install
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run install:test
```

Use an isolated vault for development. Reload and inspect the plugin with:

```bash
obsidian plugin:reload id=obsidian-docs-sync
obsidian dev:errors
obsidian dev:console level=error
obsidian dev:mobile on
```

## Privacy and security

See [PRIVACY.md](PRIVACY.md). A private GitHub repository is access-controlled but is not client-side end-to-end encryption. This initial release intentionally preserves readable Git history and diffs.

## Limitations

- The default maximum file size is 25 MB; the UI hard limit is 100 MB.
- GitHub synchronization is periodic, not real-time.
- Rename detection is represented safely as create/delete when Git cannot prove a rename.
- Secret Storage has no delete API in the current Obsidian SDK; disconnecting replaces the stored value with an empty secret.
