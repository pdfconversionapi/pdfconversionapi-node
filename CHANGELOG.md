# Changelog

## 0.1.0 (unreleased)

- First version: `PdfConversionApi` with `convert`, `convertFile`, `usage`, `conversions`,
  `download`, `downloadTo` and `deleteStoredFile`; `UploadFile` inputs (paths, bytes, Blobs,
  web and Node.js streams); typed errors; retries with `Retry-After` and jitter (SPEC 1.2).
- ESM and CommonJS builds with bundled types; no runtime dependencies. Tested on Node.js,
  Bun, Deno and workerd.
