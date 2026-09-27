#!/usr/bin/env node
import {
  compareGithubSettings,
  fetchLiveGithubSettings,
  githubApi,
  loadExpectedSettings,
  rulesetPayload,
} from "./github-repository-settings.mjs";

const expected = await loadExpectedSettings();
const token = process.env.GH_ADMIN_TOKEN || process.env.GH_TOKEN || "";

if (!token) {
  console.error("GH_ADMIN_TOKEN or GH_TOKEN is required.");
  process.exit(2);
}

const [owner, name] = expected.repository.split("/");
const root = `/repos/${owner}/${name}`;

try {
  await githubApi(root, {
    token,
    method: "PATCH",
    body: {
      default_branch: expected.defaultBranch,
      allow_merge_commit: expected.mergeMethods.mergeCommit,
      allow_squash_merge: expected.mergeMethods.squash,
      allow_rebase_merge: expected.mergeMethods.rebase,
      allow_auto_merge: expected.allowAutoMerge,
      delete_branch_on_merge: expected.deleteBranchOnMerge,
    },
  });

  const existing = await githubApi(`${root}/rulesets`, { token });
  for (const expectedRuleset of expected.rulesets) {
    const payload = rulesetPayload(expected, expectedRuleset);
    const current = existing.find((ruleset) => ruleset.name === expectedRuleset.name);
    if (current) {
      await githubApi(`${root}/rulesets/${current.id}`, {
        token,
        method: "PUT",
        body: payload,
      });
    } else {
      await githubApi(`${root}/rulesets`, {
        token,
        method: "POST",
        body: payload,
      });
    }
  }

  const actual = await fetchLiveGithubSettings(expected, { token });
  const failures = compareGithubSettings(expected, actual);
  if (failures.length > 0) {
    console.error("GitHub settings were mutated but do not verify:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log("GitHub repository settings applied and independently re-read as compliant.");
} catch (error) {
  console.error(error.message);
  if (error.code === "GITHUB_ADMIN_INACCESSIBLE") {
    console.error("Use a token with Repository Administration write access.");
    process.exit(2);
  }
  throw error;
}
