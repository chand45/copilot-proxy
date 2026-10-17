# Original package verification

This is the historical verification record for the source ZIP, produced in the "Package remote session adapter" chat. The repository import preserves its runtime, installer, prerequisite checker, command launchers, and tests unchanged; documentation has been adapted for the repository. The checks below describe the original packaging run, not a new installation from this checkout.

Package: `codex-copilot-adapter-windows-v1.0.0.zip`

Verified locally on 17 October 2026 using Node.js 24.18.0 and Windows PowerShell (`powershell.exe`).

- The packaged `adapter.mjs` has the same SHA-256 hash as the installed source adapter.
- All 10 adapter tests passed: authentication and token rotation, header filtering, decompression and size limits, HTTP fallback, upstream errors, model-list format, SSE delivery and cancellation, timeouts, and tool/history forwarding.
- Seven configuration checks passed: four enable/disable round trips, duplicate-key rejection, preserving a newer route during rollback, and preserving concurrent edits.
- A fresh install in an isolated Windows profile passed. The test used a synthetic Codex token and the existing local proxy's authenticated model catalog. No real sign-in file was copied.
- Authenticated catalog access through the installed test adapter passed. Rollback restored the previous quoted/indented route, retained a later unrelated edit, removed test startup and stopped its owned process. Repeating rollback was safe.
- An injected post-install verification failure caused automatic routing rollback and process cleanup.
- The real desktop's Codex config file hash and startup entry were unchanged by the installation tests. Test startup used a dedicated registry key outside Windows' Run key.
- Archive contents are allowlisted source, scripts, documentation, tests and checksums. No credentials, logs, personal config, machine-specific settings or running-process state are included.

This run did not execute model inference or create a phone chat on the destination desktop. The source adapter's phone-created chat, tool call and follow-up behavior was verified in the referenced setup; the destination must still be checked with a new phone chat. Catalog/health success alone is not inference verification.

The original ZIP included `SHA256SUMS.txt` and a companion archive checksum. Those generated distribution files are not part of this source folder; the original hashes would not describe the updated repository documentation. They were transfer-integrity checks, not a digital publisher signature.
