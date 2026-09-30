---
"@everframe/protocol": minor
"@everframe/sdk-core": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Adds the `dom-snapshot` attachment kind and a versioned page-snapshot format (`DomSnapshotV1`, validated by `parseDomSnapshot`) for smart-TV screenshots that are rendered on the server, together with the render endpoint's request and response types and the shared report limits (`MAX_REPORT_SHOTS`, `MAX_INGEST_FILE_PARTS`). Report upload now labels `dom-snapshot` and `dom-snapshot-N` parts with their own kind. Existing reports and SDK behaviour are unchanged.
