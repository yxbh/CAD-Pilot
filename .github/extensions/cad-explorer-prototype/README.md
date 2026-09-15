# Retained Explorer data

The maintained application is in [explorer](../../../explorer/README.md), loaded by `.github\extensions\cad-explorer\extension.mjs`. This folder no longer registers a prototype extension.

Keep `.runtime` here. Existing native file-reference chips contain absolute paths to its `references` directory; models, source snapshots, remembered setups, saved drawings and captures are retained alongside them. Removing or moving this folder can break previous conversations and lose saved work.

The former prototype source is preserved under `.runtime\prototype-source-before-v1` as a local backup, not a second maintained application or active provider. Its original relative imports assume the old layout if deliberately restored. Do not restore its entry alongside the maintained provider: that would duplicate tool registration and state ownership.
