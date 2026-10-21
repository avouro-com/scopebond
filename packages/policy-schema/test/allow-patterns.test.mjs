// Pattern allowances: a rule's recipes (`allow_patterns`) and the bounds an allowance made from one carries
// (`allowance.match`). Bounds are checked on their own words: never wider than one project folder or repository, never
// climbing out of it, never a wildcard where a folder is named.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOW_PATTERN_KINDS, DELETE_RECIPE, allowPatternErrors, validAllowPatterns, validAllowanceMatch, validBounds } from "../dist/index.js";
import * as sub from "../dist/allow-patterns.js";

test("a rule's recipes: well formed, known kinds, unique ids, a short plain title", () => {
  const recipe = (extra = {}) => ({ id: "reads-in-folder", title: "Reading files in {value}", param: "path", kind: "path_prefix", ...extra });
  assert.equal(validAllowPatterns([recipe()]), true);
  assert.equal(validAllowPatterns(ALLOW_PATTERN_KINDS.map((kind, i) => recipe({ id: `r${i}`, kind }))), true);
  for (const [bad, why] of [
    [[], "empty"], [recipe(), "not a list"], [Array.from({ length: 9 }, (_, i) => recipe({ id: `r${i}` })), "too many"],
    [[recipe({ kind: "anything" })], "unknown kind"], [[recipe({ id: "Reads" })], "id case"], [[recipe(), recipe()], "id twice"],
    [[recipe({ title: "" })], "no title"], [[recipe({ title: "x".repeat(81) })], "long title"], [[recipe({ title: "a\u202eb" })], "hidden character"],
    [[recipe({ param: "Path" })], "param"], [[recipe({ extra: 1 })], "unknown field"],
  ]) assert.equal(validAllowPatterns(bad), false, why);
  assert.match(allowPatternErrors([recipe({ kind: "x" })], "rules[0].allow_patterns")[0], /^rules\[0\]\.allow_patterns\[0\]\.kind/);
  assert.equal(sub.validAllowPatterns, validAllowPatterns, "also from the subpath");
});

const deleteMatch = (bounds) => ({ rule: "destructive-shell", action_type: "shell.exec", recipe: DELETE_RECIPE,
  bounds: { kind: "path_prefix", param: "delete_targets", program: "rm", value: "d:/src/app/dist", project: "d:/src/app", ...bounds } });

test("the built-in delete recipe: a folder inside one project or repository, for one program", () => {
  assert.equal(validAllowanceMatch(deleteMatch({})), true);
  assert.equal(validAllowanceMatch(deleteMatch({ value: "d:/src/app" })), true, "the repository itself, at most");
  assert.equal(validAllowanceMatch(deleteMatch({ value: "d:/src/APP/dist" })), true, "a drive path compares without case");
  assert.equal(validAllowanceMatch(deleteMatch({ value: "~/work/app/build", project: "~/work/app" })), true);
  assert.equal(validAllowanceMatch(deleteMatch({ value: "/srv/app/tmp", project: "/srv/app" })), true);
  for (const [bounds, why] of [
    [{ value: "d:/src" }, "wider than the project"],
    [{ value: "d:/src/other/dist" }, "another project"],
    [{ value: "d:/src/app-old/dist" }, "a project whose name only starts the same"],
    [{ value: "d:/src/app/../other" }, "climbs out with .."],
    [{ value: "d:/src/app/./dist" }, "a . segment"],
    [{ value: "d:/src/app//dist" }, "an empty segment"],
    [{ value: "d:/src/app/*" }, "a wildcard"],
    [{ value: "d:/src/app/$X" }, "a value known at run time"],
    [{ value: "c:\\GitHub\\app\\dist" }, "backslashes"],
    [{ value: "e:/src/app/dist" }, "another drive"],
    [{ value: "~/app", project: "~" }, "the home folder as the project"],
    [{ value: "c:/x", project: "c:/" }, "a drive root as the project"],
    [{ value: "/x", project: "/" }, "the root as the project"],
    [{ value: "dist", project: "d:/src/app" }, "a relative value"],
    [{ program: "RM" }, "program case"],
    [{ kind: "host" }, "another kind"],
    [{ extra: "x" }, "an unknown bound"],
  ]) assert.equal(validAllowanceMatch(deleteMatch(bounds)), false, why);
  assert.equal(validAllowanceMatch({ ...deleteMatch({}), action_type: "file.write" }), false, "only a shell command");
  assert.equal(validAllowanceMatch({ ...deleteMatch({}), recipe: "other" }), false, "a program only with the built-in recipe");
  assert.equal(validAllowanceMatch({ ...deleteMatch({}), rule: "Destructive" }), false);
  assert.equal(validAllowanceMatch({ ...deleteMatch({}), extra: 1 }), false);
});

test("the pack recipes' bounds: a relative folder or file pattern in the project, a package, a host, an MCP tool", () => {
  const b = (extra) => ({ param: "path", project: "d:/src/app", ...extra });
  const ok = [
    b({ kind: "path_prefix", value: "src/generated" }),
    b({ kind: "path_prefix", value: "." }),
    b({ kind: "path_glob", value: "src/*.test.ts" }),
    b({ kind: "path_glob", value: "*.md" }),
    b({ kind: "package_name", param: "package", value: "@scope/left-pad", with: { ecosystem: "npm" } }),
    b({ kind: "host", param: "host", value: "api.example.com" }),
    b({ kind: "mcp_tool", param: "tool", value: "create_issue", with: { server: "github" } }),
  ];
  for (const bounds of ok) assert.equal(validBounds(bounds), true, JSON.stringify(bounds));
  const bad = [
    [b({ kind: "path_prefix", value: "../other" }), ".."],
    [b({ kind: "path_prefix", value: "src/../../x" }), ".. inside"],
    [b({ kind: "path_prefix", value: "/etc" }), "absolute"],
    [b({ kind: "path_prefix", value: "c:/x" }), "a drive"],
    [b({ kind: "path_prefix", value: "~/x" }), "home"],
    [b({ kind: "path_prefix", value: "src/*" }), "a wildcard in a folder bound"],
    [b({ kind: "path_glob", value: "src/**/*.ts" }), "**"],
    [b({ kind: "path_glob", value: "*/x.ts" }), "a wildcard folder"],
    [b({ kind: "path_glob", value: "**" }), "everything"],
    [b({ kind: "path_glob", value: "." }), "the folder"],
    [b({ kind: "package_name", value: "left pad" }), "a space"],
    [b({ kind: "package_name", value: "*" }), "a wildcard package"],
    [b({ kind: "host", value: "*.example.com" }), "a wildcard host"],
    [b({ kind: "host", value: "Example.com" }), "upper case host"],
    [b({ kind: "mcp_tool", value: "create_issue" }), "no server"],
    [b({ kind: "mcp_tool", value: "x", with: { server: "a b" } }), "a bad server"],
    [b({ kind: "path_prefix", value: "src", project: "src" }), "a relative project"],
    [b({ kind: "path_prefix", value: "src", project: "~" }), "the home folder as the project"],
    [b({ kind: "path_prefix", value: "src", with: { path: "x" } }), "with repeats the widened parameter"],
    [b({ kind: "path_prefix", value: "src", with: { a: "1", b: "2", c: "3", d: "4", e: "5" } }), "too many"],
    [b({ kind: "path_prefix", value: "src", program: "rm" }), "a program outside the delete recipe's shape"],
  ];
  for (const [bounds, why] of bad) assert.equal(validBounds(bounds), false, why);
});
