# Delta Sync

**A subscription-free Obsidian Sync alternative built on GitHub.**

Delta Sync uses a private GitHub repository as a versioned transport layer. One desktop Obsidian
vault is the canonical `Writer`; Android, iOS, tablet, and spare computers are `Pull-only
followers`. Everything runs inside Obsidian: no local Git installation, no `.git` directory in
the vault, no Syncthing daemon to maintain, and no conflict-copy files.

## The problem it solves

Obsidian Sync is convenient, but long-term use requires a subscription. Local Git workflows add
setup and maintenance overhead, especially on mobile. Syncthing depends on both applications
remaining available in the background, which is unreliable under Android power management.

Delta Sync addresses those costs directly:

- **No Obsidian Sync subscription**: the plugin is MIT-licensed and free; a GitHub private
  repository uses the account's available free allowance for transport and history.
- **No local synchronization stack**: no Git metadata, Git client, Syncthing pairing, or separate
  service to keep alive.
- **Predictable conflict policy**: one Writer is the only upload source. Followers pull the
  Writer's canonical state, so the workflow does not create Git merge markers or conflicted
  copies.

GitHub still applies storage, API, network, and account limits. The project does not bypass them;
for a typical personal vault, the practical cost can remain zero.

## How it works

```text
Desktop Obsidian (Writer)
        │  incremental commits + release assets
        ▼
GitHub private repository
        │  read-only pull
        ├── Samsung Android (Follower)
        ├── Tablet (Follower)
        └── Other Obsidian devices (Follower)
```

### Writer and pull-only follower roles

The desktop Writer uploads local changes and advances the configured branch. Each follower uses a
separate fine-grained token with `Contents: Read-only`, and the plugin also prevents follower
uploads. If a follower is edited accidentally, the remote Writer version is restored; the
displaced local file is moved to Obsidian's trash for recovery. This deliberately gives up
multi-device simultaneous editing in exchange for a stable, auditable single-source workflow.

### Incremental synchronization

- The first sync reads each included file once.
- Later runs use a persistent local index, file events, modification time, and size to detect
  changes without re-reading unchanged files.
- An unchanged remote branch requires one HEAD check; the cached remote tree is reused.
- Followers download independent files with bounded concurrency.
- Renames are represented as create plus delete, keeping both Obsidian file trees consistent.

### Attachments and large files

Images, PDFs, Office documents, and other binary or large files are stored as private GitHub
Release Assets. The Git branch contains normal small UTF-8 files plus a hidden asset index, so
attachments do not inflate Git history and no sync metadata file appears in the vault. The default
per-file limit is 25 MB, configurable up to GitHub's 100 MB hard limit.

### Integrity and cleanup guarantees

- The Writer checks the remote branch HEAD before publishing, preventing an overwrite of an
  unexpected remote update.
- Large first syncs build complete commit objects before advancing the branch, so followers never
  observe a partial vault.
- Followers verify downloaded file contents before pruning stale empty directories.
- `.obsidian`, `.trash`, `.git`, `.agents`, and configured exclusions remain protected.
- Android vault roots receive a local `.nomedia` marker so photo pickers and apps such as WeChat do
  not index every attachment as a personal photo.

## Recommended setup

| Device                         | Role               | GitHub permission          | Purpose                                       |
| ------------------------------ | ------------------ | -------------------------- | --------------------------------------------- |
| Desktop (`E:\\Obsidian Vault`) | Writer             | `Contents: Read and write` | Edit, upload, and publish the canonical state |
| Samsung Android                | Pull-only follower | `Contents: Read-only`      | View, search, and pull automatically          |
| Other devices                  | Pull-only follower | `Contents: Read-only`      | View, search, and pull automatically          |

Keep exactly one physical vault directory. Do not create a second copy under Desktop, `Program
Files`, or another path, and do not let Obsidian Sync, Syncthing, iCloud, or Remotely Save write
the same vault.

## Install and first sync

1. Install and enable Delta Sync on every device.
2. Create a dedicated GitHub private repository and branch for the vault.
3. On the desktop, select `Writer` and enter the owner, repository, branch, device name, and a
   fine-grained token restricted to that repository with `Contents: Read and write`.
4. On each mobile or secondary device, select `Pull-only follower` and use a separate token with
   `Contents: Read-only`.
5. Run **Test connection**, then **Preview** the initial changes and explicitly confirm the first
   sync.
6. Enable **Automatic sync**. It runs on startup, app foreground, after a short Writer edit
   debounce, and at the configured interval. Successful automatic runs stay quiet; manual runs
   still report their result.

## Cost and limits

| Item                       | Delta Sync                                                       |
| -------------------------- | ---------------------------------------------------------------- |
| Obsidian Sync subscription | Not required                                                     |
| Plugin                     | Free and MIT-licensed                                            |
| Transport and history      | GitHub private repository and Releases within account limits     |
| Local Git / Syncthing      | Not required                                                     |
| Operational limits         | GitHub storage, API rate, network, and Android background policy |

A private GitHub repository is access-controlled but not end-to-end encrypted. Encrypt sensitive
material inside the vault before syncing. The plugin includes no telemetry, advertising, or
third-party tracking.

## Scope

Delta Sync is designed for personal knowledge bases, study notes, research material, and
attachment libraries distributed from one computer to mobile devices. It is not a multi-writer
merge engine or a real-time collaborative editor. Automatic sync runs while Obsidian is alive;
Android resumes on the next app open or foreground event after the OS suspends the process.

## Privacy and exclusions

Included file contents, paths, commit metadata, repository details, and device names are sent
directly to GitHub's API. Tokens are kept in Obsidian Secret Storage and are never written to
settings or logs. `.obsidian`, `.trash`, `.git`, oversized files, and custom glob exclusions are
not uploaded.

## Development

```bash
npm install
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

The repository includes unit tests, release consistency checks, and real Android-device coverage
for create, modify, delete, rename, binary SHA-256 verification, and empty-folder cleanup.

## License

MIT. The original [Docs Sync](https://github.com/luhaifeng666/obsidian-docs-sync) MIT license and
copyright notice are retained.
