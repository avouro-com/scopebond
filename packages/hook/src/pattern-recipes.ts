// "Similar commands in this project": what a person may allow instead of the one action that was blocked. A rule's recipe
// (policy-schema allow-patterns.ts) turns the blocked action into bounds: the same rule and action type, and the parameter
// the rule matched widened only so far (a folder of the project, a file pattern in it, a package in any version, a host, an
// MCP server's tool). The person reads it in words, with an example it covers and one it does not, before choosing it.
//
// Where recipes come from:
//   - the starter destructive-shell rule has one built in: the same deleting program, every target inside one folder of one
//     project or repository (git names the repository a target is in; a target in none is offered nothing);
//   - a rule pack's rule carries its own (`allow_patterns`), applied to the actions of that rule's types.
// Never for the always-on protections (they take no person's answer). An offer is checked with the same narrow-bounds check
// an allowance is (`validAllowanceMatch`); one that fails is not offered.
//
// The workspace decides whether a person may make one (`override.patterns`: "person", "needs_admin", "off"; anything else,
// or nothing, is "off").

import { DELETE_RECIPE, fullPathSegments, relativeSegments, validAllowPatterns, validAllowanceMatch, withinSegments, type AllowPattern, type AllowanceMatch } from "@scopebond/policy-schema/allow-patterns";
import type { Pack } from "@scopebond/policy-schema/pack";
import { DELETE_PROGRAMS, namesProtectedPlace } from "./delete-scope.js";
import { NEVER_OFF_RULE_IDS } from "./managed.js";
import { activePacks } from "./packs.js";
import { canonProgram } from "./shell.js";

/** Who may make a pattern allowance under a rule's terms: the person, the person with an admin's approval, or no one. */
export type PatternSetting = "person" | "needs_admin" | "off";
/** The workspace's `override.patterns`, read: an unknown value (a newer workspace's word) or none is "off". */
export function patternSetting(terms: { patterns?: unknown } | undefined | null): PatternSetting {
  const p = terms?.patterns;
  return p === "person" || p === "needs_admin" ? p : "off";
}

/** What the Unblock form shows for "Similar commands in this project": the recipe, the words, an example of what it covers and
 *  one of what it does not, and whether it waits for an admin. */
export interface SimilarOffer { recipe_id: string; words: string; covers: string[]; not_covers: string[]; needs_admin?: boolean }
/** An offer and the bounds an allowance made from it carries. */
export interface SimilarProposal { offer: SimilarOffer; match: AllowanceMatch }

const NEVER: ReadonlySet<string> = new Set(NEVER_OFF_RULE_IDS);
/** Whether a rule may ever be widened: never one of the always-on protections. */
export const rulePatternable = (rule: string): boolean => !NEVER.has(rule);

/** Paths compare without case on Windows, and a drive path anywhere. */
export const foldCase = (path: string): boolean => process.platform === "win32" || /^[a-z]:\//i.test(path);
/** A path as compared: forward slashes, no trailing slash, without case where `foldCase`. */
export function pathKey(path: string): string {
  let s = path.replace(/\\/g, "/");
  let end = s.length;
  while (end > 1 && s[end - 1] === "/") end--;
  s = s.slice(0, end);
  return foldCase(s) ? s.toLowerCase() : s;
}
/** A working folder as the engine writes a path: forward slashes, a drive letter in lower case (the home folder is masked by
 *  the caller). */
export function enginePath(path: string): string {
  const s = path.replace(/\\/g, "/");
  let end = s.length;
  while (end > 1 && s[end - 1] === "/") end--;
  const t = s.slice(0, end);
  return /^[A-Za-z]:\//.test(t) ? t[0].toLowerCase() + t.slice(1) : /^\/[A-Za-z]\//.test(t) ? `${t[1].toLowerCase()}:${t.slice(2)}` : t;
}

const rootOf = (path: string): string => (path.startsWith("~/") ? "~/" : /^[a-z]:\//i.test(path) ? path.slice(0, 3) : "/");
const joinFull = (root: string, segs: readonly string[]): string => root + segs.join("/");
/** The leading segments two paths share. */
function shared(a: readonly string[], b: readonly string[], fold: boolean): string[] {
  let n = 0;
  while (n < a.length && n < b.length && (fold ? a[n].toLowerCase() === b[n].toLowerCase() : a[n] === b[n])) n++;
  return a.slice(0, n);
}

/** Where a recipe finds what it needs: the call's working folder (engine form, home masked), the repository a path is in
 *  (engine form; null when none), and the pack recipes for a rule. */
export interface RecipeContext {
  project: string | null;
  repositoryTop?: (path: string) => string | null;
  packRecipes?: (rule: string) => { recipes: AllowPattern[]; action_types: string[] } | null;
}

/** The recipes the packs in force give a rule: the first pack (by the packs' order) whose rule of that id carries
 *  well-formed `allow_patterns`, with the action types that rule governs. */
export function packRecipesFor(rule: string, packs: readonly Pack[] = activePacks()): { recipes: AllowPattern[]; action_types: string[] } | null {
  for (const pack of packs) {
    const r = pack.rules.find((x) => String(x.id) === rule);
    if (!r) continue;
    const types = Array.isArray(r.action_types) ? r.action_types.filter((t): t is string => typeof t === "string") : [];
    return validAllowPatterns(r.allow_patterns) && types.length ? { recipes: r.allow_patterns, action_types: types } : null;
  }
  return null;
}

/** What may be offered as "Similar commands in this project" for this blocked action under this rule, or null: no recipe
 *  fits, the action is not one a recipe can bound, or the rule is always on. */
export function similarFor(rule: string, intent: { action_type?: string; params?: Record<string, unknown> }, ctx: RecipeContext): SimilarProposal | null {
  if (!rulePatternable(rule) || !intent.action_type || !intent.params) return null;
  try {
    const made = rule === "destructive-shell" && intent.action_type === "shell.exec" ? deleteProposal(intent.params, ctx) : packProposal(rule, intent.action_type, intent.params, ctx);
    return made && validAllowanceMatch(made.match) && made.match.rule === rule ? made : null;
  } catch { return null; }
}

/** The built-in delete recipe: one folder holding every target, inside the one repository (or working folder) they are all in. */
function deleteProposal(params: Record<string, unknown>, ctx: RecipeContext): SimilarProposal | null {
  const program = typeof params.program === "string" ? canonProgram(params.program) : "";
  if (!DELETE_PROGRAMS.has(program) || params.program_scope !== params.program) return null;
  const targets = params.delete_targets;
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > 8 || !targets.every((t): t is string => typeof t === "string")) return null;
  let project: string | null = null;
  let common: string[] | null = null;
  let root = "";
  for (const target of targets) {
    const segs = fullPathSegments(target);
    if (!segs || namesProtectedPlace(segs)) return null;
    // The repository the target is in, or the working folder when it is inside it.
    const inWorking = ctx.project && fullPathSegments(ctx.project) && rootOf(ctx.project).toLowerCase() === rootOf(target).toLowerCase()
      && withinSegments(segs, fullPathSegments(ctx.project)!, foldCase(target)) ? ctx.project : null;
    const top = inWorking ?? ctx.repositoryTop?.(target) ?? null;
    const topSegs = top ? fullPathSegments(top) : null;
    if (!top || !topSegs || rootOf(top).toLowerCase() !== rootOf(target).toLowerCase() || !withinSegments(segs, topSegs, foldCase(target))) return null;
    if (project !== null && pathKey(project) !== pathKey(top)) return null;
    project = top;
    root = rootOf(target);
    // The target's folder, or the target itself when it is the repository: never above the repository.
    const prefix = segs.length > topSegs.length ? segs.slice(0, -1) : segs;
    common = common === null ? prefix : shared(common, prefix, foldCase(target));
  }
  if (!project || !common) return null;
  const projectSegs = fullPathSegments(project)!;
  if (!withinSegments(common, projectSegs, foldCase(project))) return null;
  const value = joinFull(root, common);
  const first = targets[0];
  const inside = fullPathSegments(first)!.length > common.length ? first : `${value}/dist`;
  const parent = projectSegs.length > 1 ? joinFull(rootOf(project), projectSegs.slice(0, -1)) : rootOf(project);
  return {
    offer: { recipe_id: DELETE_RECIPE, words: `Deleting folders inside ${value} with ${program}`, covers: [`${program} -r ${inside}`], not_covers: [`${program} -rf ${parent}`] },
    match: { rule: "destructive-shell", action_type: "shell.exec", recipe: DELETE_RECIPE, bounds: { kind: "path_prefix", param: "delete_targets", program, value, project } },
  };
}

/** A pack recipe for the rule, the first that fits the action. */
function packProposal(rule: string, actionType: string, params: Record<string, unknown>, ctx: RecipeContext): SimilarProposal | null {
  const found = ctx.packRecipes?.(rule);
  if (!found || !found.action_types.includes(actionType) || !ctx.project || !fullPathSegments(ctx.project)) return null;
  const project = ctx.project;
  for (const recipe of found.recipes) {
    const raw = params[recipe.param];
    if (typeof raw !== "string" || raw === "") continue;
    const made = proposal(recipe, raw, params);
    if (!made) continue;
    const words = recipe.title.includes("{value}") ? recipe.title.replace("{value}", made.shown) : `${recipe.title}: ${made.shown}`;
    return {
      offer: { recipe_id: recipe.id, words, covers: made.covers, not_covers: made.not_covers },
      match: { rule, action_type: actionType, recipe: recipe.id, bounds: { kind: recipe.kind, param: recipe.param, value: made.value, project, ...(made.with ? { with: made.with } : {}) } },
    };
  }
  return null;
}

/** One recipe applied to the action's value: the bound, how it reads, and the examples. */
function proposal(recipe: AllowPattern, raw: string, params: Record<string, unknown>): { value: string; shown: string; covers: string[]; not_covers: string[]; with?: Record<string, string> } | null {
  switch (recipe.kind) {
    case "path_prefix": {
      const segs = relativeSegments(raw);
      if (!segs || segs.length === 0 || namesProtectedPlace(segs)) return null;
      const folder = segs.slice(0, -1);
      const value = folder.length ? folder.join("/") : ".";
      const name = segs[segs.length - 1];
      const dot = name.lastIndexOf(".");
      const ext = dot > 0 ? name.slice(dot) : "";
      const outside = folder.length ? [...folder.slice(0, -1), name].join("/") : `../${name}`;
      return { value, shown: value === "." ? "this project" : value, covers: [`${folder.length ? `${value}/` : ""}another${ext}`], not_covers: [outside] };
    }
    case "path_glob": {
      const segs = relativeSegments(raw);
      if (!segs || segs.length === 0 || namesProtectedPlace(segs)) return null;
      const name = segs[segs.length - 1];
      const dot = name.lastIndexOf(".");
      if (dot <= 0 || dot === name.length - 1) return null;
      const dir = segs.slice(0, -1).join("/");
      const at = dir ? `${dir}/` : "";
      const value = `${at}*${name.slice(dot)}`;
      return { value, shown: value, covers: [`${at}another${name.slice(dot)}`], not_covers: [`${at}deeper/another${name.slice(dot)}`] };
    }
    case "package_name": {
      const extra: Record<string, string> = {};
      for (const k of ["ecosystem", "registry", "manager"]) {
        const same = params[k];
        if (k !== recipe.param && typeof same === "string" && same !== "") extra[k] = same;
      }
      return { value: raw, shown: raw, covers: [`${raw} in any version`], not_covers: ["any other package"], ...(Object.keys(extra).length ? { with: extra } : {}) };
    }
    case "host": {
      const host = raw.toLowerCase();
      return { value: host, shown: host, covers: [`https://${host}/any/path`], not_covers: [`https://other.${host}`] };
    }
    case "mcp_tool": {
      const server = typeof params.server === "string" ? params.server : "";
      if (!server) return null;
      return { value: raw, shown: `${server}: ${raw}`, covers: [`${server}: ${raw} with any arguments`], not_covers: [`${server}: any other tool`], with: { server } };
    }
  }
  return null;
}
