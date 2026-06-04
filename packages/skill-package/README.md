# Skill Package Package

Shared package manifest, validation, scanning, and bundling logic.

Implemented:

- manifest schema and platform variant validation
- local manifest loading from `skill.json`, `skill-manifest.json`, or `ai-skill.json`
- local package directory scanning
- normalized text-entry package scanning for API/CLI submission
- file-count, symlink, and text-byte-budget defenses
- secret, unsafe-command, and install-hook findings

Planned contents:

- package archive parsing
- checksums
- install/export bundle metadata
