# Delta Sync

Delta Sync synchronizes an Obsidian vault through a GitHub repository without a local Git
installation. It is designed for one writer device and any number of pull-only follower devices.
It runs only while Obsidian is open.

This project is a local fork of
[Docs Sync](https://github.com/luhaifeng666/obsidian-docs-sync). The original MIT license and
copyright notice are retained.

[中文说明](README.zh-CN.md)

## Why it is incremental

- The first sync reads each included local file once.
- Later syncs enumerate paths and compare `mtime` and size against a persistent local index.
- Vault file events force a re-read even when a filesystem timestamp is unchanged.
- Unchanged files reuse their cached Git blob SHA and are not opened or hashed again.
- If the GitHub branch HEAD is unchanged, the cached remote tree is reused after one HEAD request.
- If the branch changed, only tree metadata is fetched and only changed blobs are downloaded.
- Blob downloads use raw bytes instead of a base64 text copy.
- Initial and large follower pulls download independent files with four bounded workers.
- Binary files and large text files use private GitHub Release Assets. The sync branch contains only
  normal small UTF-8 files plus a hidden asset index, so attachments do not create a large Git history.

## Device roles

### Writer

A writer uploads local changes, pulls remote changes, and advances the sync branch atomically.
Large first syncs construct a short private commit chain in batches before the branch moves, so
other devices never observe a partial tree. Small UTF-8 notes are created inline in Tree requests.
Binary and large files are uploaded with bounded concurrency to a dedicated GitHub Release, then a
hidden index is committed with the normal files. The branch head is checked before the update and
force pushes are never used.

Use a fine-grained GitHub token restricted to the selected repository with:

- `Contents: Read and write`

### Pull-only follower

A follower never creates commits or updates a Git reference. Remote content is authoritative.
If a follower file was edited locally, Delta Sync saves that version as a timestamped
`sync-conflict-local` copy before restoring or deleting the canonical path.

Use a fine-grained GitHub token restricted to the selected repository with:

- `Contents: Read-only`

The read-only token also enforces the role on GitHub.

## Setup

1. Install and enable Delta Sync on each device.
2. Select the same GitHub repository and branch.
3. Set the desktop device to `Writer` and mobile devices to `Pull-only follower`.
4. Store the appropriate fine-grained token in Obsidian Secret Storage.
5. Test the connection.
6. Preview and explicitly confirm the first sync.
7. Enable automatic sync to run on startup, app foreground, after a short local-edit debounce on a
   writer, and on the configured interval.

The dedicated repository may start empty. Delta Sync initializes it with one real vault file, then
constructs the remaining first-sync changes before atomically advancing the configured sync branch.
Its hidden Release Asset index is never created inside the Vault.

Do not run another tool that writes the same vault files. `.obsidian`, `.trash`, `.git`, oversized
files, and custom glob patterns are excluded. Remote deletions use the Obsidian trash.

## Limits

- GitHub repositories only.
- Default maximum file size: 25 MB. Configurable up to the GitHub hard limit of 100 MB.
- The GitHub branch is not a complete attachment browser: attachments and large files are stored as
  Release Assets and recovered through Obsidian using the hidden index.
- First sync must read or download every included file once.
- Synchronization is periodic, not real-time.
- Rename operations are represented as create plus delete.
- The repository is access-controlled but files are not end-to-end encrypted.

## Development

```bash
npm install
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

Install a local build into one or more test vaults with:

```bash
node scripts/install-local.mjs /path/to/vault
```
