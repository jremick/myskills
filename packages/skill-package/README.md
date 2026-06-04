# Skill Package Package

Shared package manifest, validation, scanning, and bundling logic.

Implemented:

- manifest schema and platform variant validation
- local manifest loading from `skill.json`, `skill-manifest.json`, or `ai-skill.json`
- local package directory and `.zip` archive scanning
- local `.zip` archive manifest loading and text-entry extraction
- normalized text-entry package scanning for API/CLI submission
- file-count, archive-entry-count, symlink, encrypted-archive, unsupported-compression, UTF-8 text, archive-byte, and text-byte-budget defenses
- secret, unsafe-command, and install-hook findings

Planned contents:

- package archive creation
- checksums
- install/export bundle metadata
