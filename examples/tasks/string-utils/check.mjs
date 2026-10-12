import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const workspace = path.resolve(process.argv[2] ?? process.cwd());
const { reverseText } = await import(pathToFileURL(path.join(workspace, "string-utils.mjs")));

assert.equal(reverseText("hello"), "olleh");
assert.equal(reverseText("A👩‍💻B"), "B👩‍💻A");
assert.equal(reverseText("e\u0301x"), "xe\u0301");
console.log("All acceptance checks passed.");
