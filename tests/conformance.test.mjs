// Runs every shared conformance case against the mock API, once with the ESM build and once with
// the CommonJS build. Needs `npm run build` first.

import { createRequire } from "node:module";
import { after, before, describe, test } from "node:test";
import * as esm from "../dist/index.js";
import { loadCases, runCase, startMock } from "./conformance-lib.mjs";

const cjs = createRequire(import.meta.url)("../dist/index.cjs");
const suite = await loadCases();

for (const [label, sdk] of [
	["esm", esm],
	["cjs", cjs],
]) {
	describe(`conformance (${label})`, () => {
		let mock;
		before(async () => {
			mock = await startMock();
		});
		after(async () => {
			await mock?.stop();
		});
		for (const testCase of suite.cases) {
			test(testCase.id, () => runCase(sdk, mock.url, testCase, suite.key));
		}
	});
}
