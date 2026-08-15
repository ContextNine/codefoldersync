import assert from "node:assert/strict";
import test from "node:test";
import { shellQuote } from "../src/executor.js";

test("remote shell arguments preserve quotes and metacharacters as data", () => {
  assert.equal(shellQuote("simple"), "'simple'");
  assert.equal(shellQuote(""), "''");
  assert.equal(shellQuote("a'b;$HOME"), `'a'"'"'b;$HOME'`);
});
