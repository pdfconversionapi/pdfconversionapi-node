// Runs every example from examples/files: against the real API running locally (the base URL and
// key come from ../conformance/.local-api.env and are never printed), and usage.mjs against the
// mock, since the local instance doesn't serve /v2/usage. Run one at a time; 8 conversions.
//
//   npm run build && npm run examples

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { conformanceDir, startMock } from "../tests/conformance-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const examples = join(here, "..", "examples");
const files = join(examples, "files");
const local = {};
for (const line of readFileSync(join(conformanceDir, ".local-api.env"), "utf8").split("\n")) {
	const i = line.indexOf("=");
	if (i > 0) local[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}

function run(name, env) {
	console.log(`\n$ node ${name}`);
	const result = spawnSync(process.execPath, [join(examples, name)], {
		cwd: files,
		env: { ...process.env, ...env },
		encoding: "utf8",
	});
	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);
	if (result.status !== 0) throw new Error(`${name} exited with ${result.status}`);
}

await rm(join(files, "out"), { recursive: true, force: true });
const real = {
	PDFCONVERSIONAPI_KEY: local.PDFCONVERSIONAPI_LOCAL_KEY,
	PDFCONVERSIONAPI_BASE_URL: local.PDFCONVERSIONAPI_LOCAL_BASE_URL,
};
for (const name of [
	"quick-start.mjs",
	"pdf-to-jpg.mjs",
	"merge.mjs",
	"inputs.mjs",
	"watermark.mjs",
	"qrcode.mjs",
	"stored-files.mjs",
	"errors.mjs",
	"configuration.mjs",
]) {
	run(name, real);
}
const mock = await startMock();
try {
	run("usage.mjs", { PDFCONVERSIONAPI_KEY: "test-key", PDFCONVERSIONAPI_BASE_URL: mock.url });
} finally {
	await mock.stop();
}
