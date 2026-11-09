# Examples

Each program is a snippet from the package README. They read the key from `PDFCONVERSIONAPI_KEY`
(and `PDFCONVERSIONAPI_BASE_URL` if set), take their input files from the current folder, and
write into `out/`. `files/` holds sample inputs (CC0):

```bash
cd examples/files
PDFCONVERSIONAPI_KEY=... node ../quick-start.mjs
```

`npm run examples` (after `npm run build`) runs all of them against a local test instance of the
API, and `usage.mjs` against the conformance mock.
