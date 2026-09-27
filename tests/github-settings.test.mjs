import assert from "node:assert/strict";
import test from "node:test";
import {
  compareGithubSettings,
  configuredMergeMethods,
  loadExpectedSettings,
  rulesetPayload,
} from "../scripts/github-repository-settings.mjs";

const expected = await loadExpectedSettings();

function actual() {
  return {
    repository: {
      full_name: expected.repository,
      default_branch: expected.defaultBranch,
      allow_merge_commit: expected.mergeMethods.mergeCommit,
      allow_squash_merge: expected.mergeMethods.squash,
      allow_rebase_merge: expected.mergeMethods.rebase,
      allow_auto_merge: expected.allowAutoMerge,
      delete_branch_on_merge: expected.deleteBranchOnMerge,
    },
    rulesets: expected.rulesets.map((ruleset) => ({
      name: ruleset.name,
      target: ruleset.target,
      enforcement: ruleset.enforcement,
      bypass_actors: structuredClone(ruleset.bypassActors),
      conditions: { ref_name: { include: ruleset.include, exclude: [] } },
      rules: ruleset.rules.map((type) => {
        if (type === "pull_request") {
          return { type, parameters: { allowed_merge_methods: configuredMergeMethods(expected) } };
        }
        if (type === "required_status_checks") {
          return {
            type,
            parameters: {
              required_status_checks: expected.requiredStatusChecks.map((context) => ({ context })),
              strict_required_status_checks_policy: ruleset.requireBranchUpToDate === true,
            },
          };
        }
        return { type };
      }),
    })),
  };
}

function failuresFor(mutator) {
  const state = structuredClone(actual());
  mutator(state);
  return compareGithubSettings(expected, state).join("\n");
}

test("matching configuration passes", () => {
  assert.deepEqual(compareGithubSettings(expected, actual()), []);
});

test("disabled squash or unexpected merge/rebase support fails", () => {
  assert.match(failuresFor((state) => { state.repository.allow_squash_merge = false; }), /squash merges/);
  assert.match(failuresFor((state) => { state.repository.allow_merge_commit = true; }), /merge commits/);
  assert.match(failuresFor((state) => { state.repository.allow_rebase_merge = true; }), /rebase merges/);
});

test("repository identity and automatic branch deletion cannot drift", () => {
  assert.match(failuresFor((state) => { state.repository.full_name = "Other/repository"; }), /repository identity/);
  assert.match(failuresFor((state) => { state.repository.delete_branch_on_merge = false; }), /delete branch on merge/);
});

test("auto-merge availability cannot drift", () => {
  assert.match(failuresFor((state) => { state.repository.allow_auto_merge = false; }), /auto-merge availability/);
});

test("ruleset merge methods must match squash-only authority", () => {
  assert.match(
    failuresFor((state) => {
      const branch = state.rulesets.find((ruleset) => ruleset.target === "branch");
      const pull = branch.rules.find((rule) => rule.type === "pull_request");
      pull.parameters.allowed_merge_methods = ["merge"];
    }),
    /pull request merge methods must match the committed contract/,
  );
});

test("missing main protection ruleset fails", () => {
  assert.match(
    failuresFor((state) => { state.rulesets = state.rulesets.filter((ruleset) => ruleset.target !== "branch"); }),
    /missing ruleset: main-protection/,
  );
});

test("missing required CI check fails", () => {
  assert.match(
    failuresFor((state) => {
      const branch = state.rulesets.find((ruleset) => ruleset.target === "branch");
      const checks = branch.rules.find((rule) => rule.type === "required_status_checks");
      checks.parameters.required_status_checks = checks.parameters.required_status_checks.slice(1);
    }),
    /required status checks do not match/,
  );
});

test("unexpected ruleset bypass actor fails", () => {
  assert.match(
    failuresFor((state) => {
      const branch = state.rulesets.find((ruleset) => ruleset.target === "branch");
      branch.bypass_actors = [{ actor_id: 1, actor_type: "OrganizationAdmin", bypass_mode: "always" }];
    }),
    /bypass actors do not match/,
  );
});

test("main protection requires the branch to be current with main", () => {
  assert.match(
    failuresFor((state) => {
      const branch = state.rulesets.find((ruleset) => ruleset.target === "branch");
      const checks = branch.rules.find((rule) => rule.type === "required_status_checks");
      checks.parameters.strict_required_status_checks_policy = false;
    }),
    /must be current with main/,
  );
});

test("main ruleset payload requires PRs, squash-only merges, CI, and no bypass actors", () => {
  const main = expected.rulesets.find((ruleset) => ruleset.target === "branch");
  const payload = rulesetPayload(expected, main);
  const pull = payload.rules.find((rule) => rule.type === "pull_request");
  const checks = payload.rules.find((rule) => rule.type === "required_status_checks");
  assert.deepEqual(payload.bypass_actors, main.bypassActors);
  assert.equal(checks.parameters.strict_required_status_checks_policy, true);
  assert.deepEqual(pull.parameters.allowed_merge_methods, ["squash"]);
  assert.deepEqual(
    checks.parameters.required_status_checks,
    expected.requiredStatusChecks.map((context) => ({ context })),
  );
  assert.ok(payload.rules.some((rule) => rule.type === "deletion"));
  assert.ok(payload.rules.some((rule) => rule.type === "non_fast_forward"));
});

test("release tag payload blocks updates and deletion", () => {
  const tags = expected.rulesets.find((ruleset) => ruleset.target === "tag");
  const payload = rulesetPayload(expected, tags);
  assert.deepEqual(payload.rules.map((rule) => rule.type).sort(), ["deletion", "update"]);
});

test("missing or weakened release tag ruleset fails", () => {
  assert.match(failuresFor((state) => { state.rulesets = state.rulesets.filter((ruleset) => ruleset.target !== "tag"); }), /missing ruleset: release-tag-immutability/);
  assert.match(failuresFor((state) => {
    const tag = state.rulesets.find((ruleset) => ruleset.target === "tag");
    tag.rules = tag.rules.filter((rule) => rule.type !== "update");
  }), /missing update rule/);
});
