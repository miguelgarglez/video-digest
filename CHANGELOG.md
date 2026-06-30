# Changelog

## [1.0.0](https://github.com/miguelgarglez/video-digest/compare/v0.2.0...v1.0.0) (2026-06-30)


### ⚠ BREAKING CHANGES

* **cli:** config.v0, opencode-api-key commands, metadata.v0, and affected v0 JSON contracts are removed.

### Features

* **cli:** Add provider-neutral BYOK ([31e281f](https://github.com/miguelgarglez/video-digest/commit/31e281f2501a92867c2cdd41dd7159c21a04a232))
* **config:** Resolve provider and model ([48fe8c1](https://github.com/miguelgarglez/video-digest/commit/48fe8c103e6828b1f435271145501534bb5809a8))
* **credentials:** Isolate provider API keys ([3d8a29b](https://github.com/miguelgarglez/video-digest/commit/3d8a29b6008760d2909bd73fc33a481b5384a43a))
* **metadata:** Record generation provenance ([0e37871](https://github.com/miguelgarglez/video-digest/commit/0e378719063fbf75f7420e9467339ca2b6085a18))
* **providers:** Add Digest Provider registry ([2f9ecda](https://github.com/miguelgarglez/video-digest/commit/2f9ecda74512df6d1bd0d95eb85ee33c99bb2946))
* **summarizer:** Add Anthropic Messages ([3dfb5e1](https://github.com/miguelgarglez/video-digest/commit/3dfb5e169cd9cb836142a91fc049d6f1fa1aecd2))
* **summarizer:** Add Chat Completions adapter ([8a9d163](https://github.com/miguelgarglez/video-digest/commit/8a9d1632513cb5d80198805663040ae9193ad7ef))
* **summarizer:** Add Responses adapter ([205cbe5](https://github.com/miguelgarglez/video-digest/commit/205cbe5927c02e61ed29212cb37cd0317bd52a57))
* **tui:** Configure Digest Providers ([1ced437](https://github.com/miguelgarglez/video-digest/commit/1ced437ba7a2edb287a4936669768b5d16c59004))


### Bug Fixes

* **release:** derive package version in tests ([1b3c853](https://github.com/miguelgarglez/video-digest/commit/1b3c8533ad02051f6e31d828728c238a684ffddd))
* **smoke:** Expect provider Keychain account ([5986f5b](https://github.com/miguelgarglez/video-digest/commit/5986f5b781e07038d0f2793631993e9b3733040f))

## [0.2.0](https://github.com/miguelgarglez/video-digest/compare/v0.1.0...v0.2.0) (2026-06-23)


### Features

* **cli:** Add help output ([f477d28](https://github.com/miguelgarglez/video-digest/commit/f477d286e7c1fdf692c2e51959bc40a7ca9fcb35))
* **cli:** Add progress and interactive mode ([41972f3](https://github.com/miguelgarglez/video-digest/commit/41972f3a7f049f0f54b86135dcb9feceac7e2300))
* **cli:** Add video digest shell ([ae9c0f5](https://github.com/miguelgarglez/video-digest/commit/ae9c0f5846b72f833929f15efea33322c9c9dce6))
* **cli:** Productize local command ([c33cd16](https://github.com/miguelgarglez/video-digest/commit/c33cd160f662a31f66f17b67542b85a1f2bbbb00))
* **cli:** Render animated terminal progress ([04b83c3](https://github.com/miguelgarglez/video-digest/commit/04b83c3dfdf2094ee7c7e92978ac9e6a2ec1fc27))
* **ingestion:** Wire single video digest flow ([dfed263](https://github.com/miguelgarglez/video-digest/commit/dfed26331ddfc0d54bab9095b3645223f184cba8))
* **output:** Write digest artifacts ([a66e42b](https://github.com/miguelgarglez/video-digest/commit/a66e42bfbf5d10679079f9e53318bc869e17ef00))
* **summarizer:** Add OpenCode digest adapter ([a7c3ba6](https://github.com/miguelgarglez/video-digest/commit/a7c3ba6cbfc701e052b62827a7c6f0ace574c2f3))
* **transcript:** Add Python transcript source ([c6df349](https://github.com/miguelgarglez/video-digest/commit/c6df349de72d74e7cfaf3e687f1c5dd16adbd935))
* **transcript:** Add source policy metadata ([e44e412](https://github.com/miguelgarglez/video-digest/commit/e44e4127cb953e495f136588d09821c4bf31c5b8))
* **transcript:** Score transcript quality ([9c02ca1](https://github.com/miguelgarglez/video-digest/commit/9c02ca1b6dc0d7f38120dfd7ef98301ff4867fa2))
* **web:** Add ingestion feedback ([7a625d0](https://github.com/miguelgarglez/video-digest/commit/7a625d058cca68479ea95c5a821c8c1fec1f9f69))


### Bug Fixes

* **summarizer:** Request structured OpenCode output ([3810324](https://github.com/miguelgarglez/video-digest/commit/38103244d665c52791d323b9e75564fee7ee1797))
* **transcript:** Fallback to Spanish captions ([cc2b6e9](https://github.com/miguelgarglez/video-digest/commit/cc2b6e99a94a17b67e1d9392c64caf9eb39d4b03))
* **transcript:** Surface provider block reason ([bbb110b](https://github.com/miguelgarglez/video-digest/commit/bbb110b2a641452e3e09325dffc4984c76a37dc2))

## 0.1.0

- Initial public npm release of `video-digest`.
