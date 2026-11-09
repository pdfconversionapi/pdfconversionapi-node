import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm", "cjs"],
	target: "es2022",
	platform: "neutral",
	dts: true,
	clean: true,
	sourcemap: false,
	splitting: false,
	treeshake: true,
	minify: false,
});
