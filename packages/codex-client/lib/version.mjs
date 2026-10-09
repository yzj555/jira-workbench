import { readFileSync } from "node:fs";

// Source lives in lib/; release bundles live in dist/. Both share this parent.
export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
export const RUNTIME_PROTOCOL = 1;
