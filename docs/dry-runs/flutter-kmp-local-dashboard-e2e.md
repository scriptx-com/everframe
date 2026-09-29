<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Flutter and KMP local dashboard end-to-end dry run

Date: 2026-09-29. This used unreleased source from the Flutter/KMP feature branch and a disposable **local** Everframe project. It did not send traffic to production or publish packages.

## Setup

The private `everframe-platform` checkout ran the development API on `localhost:8787`, admin UI on `localhost:5173`, and Postgres on `localhost:5433`. Quay rejected the configured MinIO image pull with HTTP 401, so this run used a temporary loopback Moto S3-compatible server on port 9000. All SDK keys came from four newly created local dashboard apps in one project. Replay was explicitly enabled for each app in the admin API; new apps default to `replayEnabled: false`.

The Android SDK debug AARs were rebuilt with `EVERFRAME_DEV_INGEST_URL=http://10.0.2.2:8787` and published only to a temporary Maven directory. Flutter Android and iOS used app IDs and SDK keys supplied as Dart defines. KMP Android used build environment inputs; KMP iOS used test launch environment inputs. The iOS sample Info.plists point at `http://127.0.0.1:8787`. The iOS SDK validator had to accept current dashboard-issued `evf_live_` keys in addition to legacy `txx_live_` keys; its focused test failed before the fix and passed afterward.

## Observed reports

Every row below was submitted by the running emulator or simulator, appeared in the local admin Reports page, and opened in its dashboard detail view. The detail view rendered a masked screenshot and a playable replay timeline. Both stored attachments for every row returned HTTP 200 through their signed media URLs, with byte length and SHA-256 matching the report envelope.

| Host | Dashboard event ID | Replay shown in dashboard |
| --- | --- | --- |
| Flutter Android, API 36 Pixel 9 Pro XL emulator | `72bc4977-52a0-44d9-9865-3679698cdd2f` | `everframe-vtree-v1`, 29.8 seconds |
| KMP Android Compose, same emulator | `32c308a8-9b6f-476c-93a6-0c3a31a9874f` | `everframe-vtree-v1`, 14.0 seconds |
| Flutter iOS, iPhone 18 Pro iOS 27.0 simulator | `3e6795de-df4a-48e5-9ee5-f00fc186b55d` | `everframe-vtree-v1`, 14.3 seconds |
| KMP SwiftUI host, same simulator | `05dfadb7-4cfa-4eff-9f71-bf3b3e608f2f` | `everframe-video-v1`, 1.4 seconds |
| KMP Compose iOS host, same simulator | `0b765054-f16d-4380-8030-2bbb5046ed3d` | `everframe-video-v1`, 1.8 seconds |

The downloaded screenshots showed readable public content and black sensitive regions in the tested scenes. Flutter handled Dart error events reached the same local project from both Android and iOS. KMP Android sent its coded and throwable handled-error events. KMP iOS context breadcrumbs appeared in the manual report, but separate handled-error wire delivery was not established by this run.

The first Flutter dashboard screenshots were only 175 px wide on Android and 186 px on iOS because the sample `RepaintBoundary` shrank to its content column. Full-width body capture was added to both samples with a regression test in each. Fresh reports above have masked screenshots at the full logical body widths: Android 448 × 889 and iOS 402 × 756. Their screenshot and replay attachments returned HTTP 200 with matching byte lengths and SHA-256 hashes. The dashboard rendered both new detail views and replay timelines. The Flutter sample capture still covers the Scaffold body, not the app bar or system chrome.

The final five dashboard detail URLs use `/admin/projects/mobile-sdk-e2e/reports/<event ID>` on `localhost:5173`. Local screenshot and browser evidence was saved under `/tmp/everframe-*` and was not committed. The temporary Flutter iOS XCTest driver launched the installed Flutter app, tapped the native reporter, and asserted `Reporter: submitted`; it was removed from the KMP test source after the run. The KMP iOS UI tests use local app ID/key launch inputs for the real stack.

## Limits

These are simulator and emulator runs of minimal sample scenes. They do not prove package release readiness, React Native feature parity, physical-device behavior, embedded platform-view masking, rotation and dynamic layout privacy, automatic Dart/network interception, offline retry after process restart, or production storage and traffic. The Flutter and KMP packages remain unreleased. The local Moto store proves the API's S3-compatible attachment path here; it is not a production R2 or MinIO validation.
