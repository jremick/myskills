# Skill Package Package

Shared package manifest, validation, scanning, and bundling logic.

Implemented:

- strict manifest schema and platform variant validation
- local manifest loading from `skill.json`, `skill-manifest.json`, or `ai-skill.json`
- local package directory and `.zip` archive scanning
- local and uploaded `.zip` archive manifest loading and text-entry extraction
- normalized text-entry package scanning for API/CLI submission
- normalized package-file manifest discovery for API submission integrity
- `readPackageSnapshot(path)` returns the manifest, normalized files, and scan from one bounded read; upload these held files without reading the source again
- file-count, archive-entry-count, symlink, encrypted-archive, unsupported-compression, UTF-8 text, archive-byte, and text-byte-budget defenses
- secret, unsafe-command, and install-hook findings

Local path readers require macOS or Linux. They reject input and entry symlinks,
including user-created ancestor symlinks, and detect files or directories changed
during a read. macOS uses `O_NOFOLLOW_ANY`; Linux resolves paths through pinned
directory descriptors. macOS system aliases `/var`, `/tmp`, and `/etc` are accepted
only with their standard `/private` destinations. No weaker read mode is used on
an unsupported operating system. ZIP-buffer intake remains portable for web/API
uploads.

Directory, ZIP, and normalized text input share a 1 MiB text budget, 500-file limit,
32-component path-depth limit, and strict UTF-8/NUL validation. Directory and ZIP
walks also cap entries at 1,000; compressed archives are limited to 10 MiB. Readers
preserve valid UTF-8 bytes, including a text BOM, in the held file contents.

Planned contents:

- package archive creation
- checksums
- install/export bundle metadata

New submissions use the core SemVer 2 parser. It accepts prerelease plus build
metadata and rejects leading zeros in numeric version and prerelease identifiers.
`loadStoredSkillManifestFromPackageFiles` retains the previous version grammar
only for reading immutable historical artifacts; do not use it for new intake.

`validatePortableFilePaths` is the shared intake/install filename contract. Local
reads, ZIP uploads, and text-package scans reject case-folded or Unicode-normalized
collisions, inconsistent directory spelling, Windows-reserved names, control
characters, trailing dots/spaces, and file/directory conflicts. The path normalizer
continues to enforce traversal safety separately. Historical API bundle downloads
retain their original bytes and filenames; filesystem extraction still requires
portable paths. No filename, release identity, or artifact hash is rewritten.
