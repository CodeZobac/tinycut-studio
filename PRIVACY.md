# Local processing and network behavior

TinyCut has no media upload endpoint, hosted inference API, user database, or analytics SDK of its own. Imported media is represented by an in-memory File and local Blob URLs. FFmpeg and model workers receive local bytes. Source files are not modified.

## Network requests that can occur

- Static app assets and installed WASM runtime files from the app's host.
- Model, tokenizer and configuration downloads from Hugging Face and its CDN/redirect hosts. These requests disclose ordinary network metadata such as IP address and requested model filenames, not the editor's media/transcript inputs.
- Desert Ant SDK licensing/usage telemetry. This integration does not remove or suppress it. Review the provider's current terms/privacy information before accepting the app's Clear/Uhm checkbox. Local inference must not be described as zero telemetry.
- Browser/extension traffic outside this application's control.

Clear/Uhm are not initialized until the user explicitly acknowledges the linked Desert Ant license. The checkbox is not persisted and is unchecked after page reload. Public model smoke tests do not accept this license or execute these models.

## Storage

Models are cached by their runtimes/Cache API, subject to quota and eviction. Uhm uses the `tinycut-models-v1` cache. Browser site-data settings can remove cached models. Source footage and edits are in memory until the user exports media or saves a project JSON. No automatic cloud backup is provided. Project JSON includes the transcript, original filename/size/modification time and editing decisions; treat it as potentially sensitive even though it contains no video.

Closing/reloading the tab loses unsaved edits. A project JSON reload requires the original file. Clear output is not embedded in JSON.

## Verification boundary

The real editor test observes no non-GET/HEAD requests during synthetic import, scene scan, project edits and MP4 export. Whisper/MiniLM browser tests use actual remote weight downloads and local inference. These checks are not a general audit of third-party code, browser extensions, or provider infrastructure. Clear/Uhm actual inference and their live SDK network behavior remain to be validated after human license acceptance.
