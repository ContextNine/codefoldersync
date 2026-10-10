import assert from "node:assert/strict";
import {
  cpSync,
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

// Public encrypted native fixture only. Joining the host namespace simulates
// a managed downloader whose credential broker did not inherit the test mount.
const [base, ...args] = process.argv.slice(2);
assert.equal(realpathSync(base), resolve(base));
assert.equal(
  readFileSync(join(base, "SENTINEL"), "utf8"),
  "public-archived-controller-fixture\n",
);
assert.ok(args.includes("download"));
const option = (name) => args[args.indexOf(name) + 1];
const machine = option("--source-machine-id");
assert.ok(["mattbook", "wootbook", "workermacair"].includes(machine));
const destination = option("--destination");
assert.ok(!existsSync(destination));
assert.equal(realpathSync(dirname(destination)), dirname(destination));
assert.match(
  readFileSync(join(dirname(destination), "SENTINEL"), "utf8"),
  /^public-controller-(?:fixture|failure)-[a-z]+\n$/u,
);
mkdirSync(destination, { mode: 0o700 });
assert.ok(lstatSync(join(base, machine)).isDirectory());
cpSync(join(base, machine), destination, {
  recursive: true,
  dereference: false,
});
if (args.includes("--corrupt-download")) {
  const witness = JSON.parse(
    readFileSync(join(destination, "witness.json"), "utf8"),
  );
  appendFileSync(
    join(destination, witness.artifacts[0].name),
    "public-fixture-corruption",
  );
}
console.log(JSON.stringify({ verified: true, publicFixtureOnly: true }));
