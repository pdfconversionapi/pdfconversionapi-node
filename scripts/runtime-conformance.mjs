// Runs every shared conformance case against the ES module build in whichever runtime runs this
// file, without a test framework:
//
//   node scripts/runtime-conformance.mjs
//   bun scripts/runtime-conformance.mjs
//   deno run --allow-net --allow-read --allow-write --allow-env --allow-run --allow-sys scripts/runtime-conformance.mjs
//
// The mock server itself always runs under Node.js (NODE_BINARY, default `node`).

import * as sdk from "../dist/index.js";
import { loadCases, runCase, startMock } from "../tests/conformance-lib.mjs";

const runtime = globalThis.Bun
	? `bun ${Bun.version}`
	: globalThis.Deno
		? `deno ${Deno.version.deno}`
		: `node ${process.versions.node}`;
const suite = await loadCases();
const mock = await startMock();
let failed = 0;
try {
	for (const testCase of suite.cases) {
		try {
			await runCase(sdk, mock.url, testCase, suite.key);
		} catch (error) {
			failed += 1;
			console.log(`FAIL ${testCase.id}: ${error?.message ?? error}`);
		}
	}
} finally {
	await mock.stop();
}
console.log(`${runtime}: ${suite.cases.length - failed}/${suite.cases.length} conformance cases passed`);
process.exitCode = failed ? 1 : 0;
