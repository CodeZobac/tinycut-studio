# Third-party dependencies and model terms

These summaries do not replace the authoritative licenses shipped by each dependency. Runtime assets are copied from npm packages by build scripts, not checked into source. Model weights download on demand and are not distributed in this repository.

| Component                     | Version / pin                                                                               | License / source                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Desert Ant Clear and SDK core | 3.3.0                                                                                       | [Desert Ant Labs Source-Available License 1.0](https://license.desertant.com/1.0); package LICENSE.md                     |
| Desert Ant Uhm ONNX           | `a0445b85e2da898f19b3cb07cc3cf7f2ee47f05d`                                                  | [Model card and license](https://huggingface.co/desert-ant-labs/uhm); Desert Ant terms apply to weights                   |
| Whisper Tiny ONNX             | `Xenova/whisper-tiny` @ `5332fcc35e32a33b86612b9a57a89be7906102b1`                          | [Model card](https://huggingface.co/Xenova/whisper-tiny), Apache-2.0 declared by export; based on OpenAI Whisper          |
| Multilingual MiniLM ONNX      | `Xenova/paraphrase-multilingual-MiniLM-L12-v2` @ `2c4055b12046f11709e9df2c122e59ffbdc2f900` | [Model card](https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2), Apache-2.0                             |
| Transformers.js               | 3.8.1                                                                                       | Apache-2.0                                                                                                                |
| ONNX Runtime Web              | 1.22.0 plus Transformers' privately resolved version                                        | MIT                                                                                                                       |
| LiteRT.js                     | 2.5.1                                                                                       | Apache-2.0                                                                                                                |
| FFmpeg JS wrapper             | 0.12.15                                                                                     | MIT                                                                                                                       |
| FFmpeg WASM core              | 0.12.10                                                                                     | GPL-2.0-or-later; [upstream](https://github.com/ffmpegwasm/ffmpeg.wasm) and bundled dependency notices/source obligations |
| React / React DOM             | 19.1.1                                                                                      | MIT                                                                                                                       |
| Lucide icons                  | 0.468.0                                                                                     | ISC                                                                                                                       |

[Powered by Desert Ant Labs](https://desertant.com/). TinyCut Studio is an independent application, not endorsed by or affiliated with Desert Ant Labs.

Desert Ant licensing includes a free threshold of 100,000 monthly active devices per model/platform, attribution and commercial terms above that threshold. Consult the full license rather than relying on this summary. Uhm's underlying distilhubert architecture and training-data notices are described in the provider's model card; they do not replace the license on the resulting weights.

The FFmpeg core build includes x264 and other third-party codecs. Hosting or packaging the built application distributes those runtime binaries. Review corresponding-source availability, notices, codec patent obligations where applicable, and compatibility with the model/SDK terms before distributing a product. This document does not claim legal clearance.

`sharp` is overridden to 0.35.4 to remove native libvips/libheif advisories in Transformers' Node dependency graph. This editor uses the browser Transformers bundle, not sharp's Node image path. Keep the override and lockfile reviewed when upgrading Transformers.

No license has yet been selected for the original TinyCut application source. Public repository visibility alone does not grant an open-source license.
