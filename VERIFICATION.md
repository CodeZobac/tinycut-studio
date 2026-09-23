# Verification — 23 September 2026

This document distinguishes executed behavior from integrations that are only implemented. Tests ran in Node 24 on Linux with Playwright Chromium against the actual production bundle.

## Passed

- Strict TypeScript checking and Vite production build.
- **84 tests** with `TINYCUT_REAL_MEDIA=1 npm test`, including actual Chromium FFmpeg WASM import/export/cancellation. The default `npm test` runs 83 and deliberately skips the optional real-media test.
- **3 Playwright end-to-end tests** on the full editor: responsive empty state/consent gate; real WebM import, waveform, scene scan, range edits, undo, project save/load, checked-cut application, caption retiming and MP4 export; invalid-project/range handling.
- Actual local Whisper Tiny ONNX inference: an 11-second public speech fixture returned **22 timestamped words**. The final pin is `Xenova/whisper-tiny` at `5332fcc35e32a33b86612b9a57a89be7906102b1`. An initially considered onnx-community export lacked cross-attention outputs and was replaced with this verified export of the same Whisper Tiny model. No equal-spaced/fabricated timestamps are used.
- Actual multilingual MiniLM inference: three finite normalized **384-dimensional vectors** in worker smoke tests. The full editor also generated a real highlight candidate from the recognized speech and downloaded a matching SRT.
- Actual UI model workflow via `scripts/verify-editor-ai.mjs`: import, language selection, transcription, semantic ranking, selecting the candidate and caption download. No page errors or non-GET/HEAD requests were observed. The Desert Ant consent box remained unchecked.
- Actual scene scan found the boundary at **4.0 seconds** in a synthetic red/blue WebM, without a scene model or fabricated marker.
- Full-editor MP4 test: source selection 1–7 seconds minus a deliberately seeded 3–4-second cut yielded approximately **5 seconds**, H.264 video plus AAC audio. The seeded project tests edit restoration/export, not Uhm inference.
- Media-engine test: two noncontiguous one-second intervals produced **2.000-second**, 1280×720 H.264/AAC outputs. Independently decoded video/audio with native FFmpeg; original audio RMS ≈0.088, test replacement silence RMS 0. This replacement is synthetic PCM to test synchronization, not claimed Clear output.
- Worker cancellation, consent rejection at both API/worker boundaries, and separate private ORT runtime assets.
- `npm audit`: **0 known vulnerabilities** at verification time. Vite/Vitest were updated; Node-only sharp was overridden to a patched version. An audit is not a security guarantee.

## Not yet verified

- **Clear and Uhm actual inference/quality/performance.** No agent or automated test accepted their license, downloaded their weights, or ran them. Their real browser adapters, tensor contracts, preprocessing, bundled SDK assets and consent gates are implemented. Initialization errors are surfaced; no output is simulated. Human license acknowledgment and a short real recording are the next acceptance step.
- Clear SDK live reporting behavior during actual inference. The SDK is unmodified and usage reporting is disclosed, not bypassed.
- Portuguese transcription quality and Portuguese filler recall; the app supports selecting Portuguese, but the recorded speech acceptance test is English.
- Very long, 4K or high-bitrate projects, low-memory devices, mobile browsers, Safari and Firefox. The 200 MB / 20-minute guard is not a measured capacity claim.
- Frame-accurate browser preview of edits. Export applies source intervals through FFmpeg; in-browser skipping is an approximate editorial preview.
- Public hosted deployment, application-source licensing, and commercial redistribution compliance.

## Browser codec caveat

The test Chromium build can preview WebM but omits proprietary H.264/AAC playback. FFmpeg WASM still creates valid MP4s, and native FFmpeg independently decodes them. Consequently, full UI tests use WebM inputs. This is not evidence that every user's browser supports every input codec.

## Reproduce

Install Node 22+, npm, native ffmpeg/ffprobe and Playwright Chromium, then:

```sh
npm ci
npm run build
npm test
node scripts/create-fixtures.mjs
npm run test:e2e
TINYCUT_REAL_MEDIA=1 npm test
node scripts/verify-ai.mjs --models
node scripts/verify-editor-ai.mjs
npm audit
```

The optional model scripts download public open-model weights and a public speech fixture. They never consent to Desert Ant licensing. Model tests are opt-in rather than part of normal CI; deterministic CI remains independent of large model downloads. Browser screenshots and export probes are saved under ignored local test-output directories, not added to the public source repository.
