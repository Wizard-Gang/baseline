#!/usr/bin/env node
import {
  loadExpectedSettings,
  verifyLiveGithubSettings,
} from "./github-repository-settings.mjs";

const expected = await loadExpectedSettings();
const token = process.env.GH_ADMIN_TOKEN || process.env.GH_TOKEN || "";

try {
  const { failures } = await verifyLiveGithubSettings(expected, { token });
  if (failures.length > 0) {
    console.error("GitHub repository settings do not match the committed authority:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log("GitHub repository settings match config/github-repository-settings.json.");
} catch (error) {
  console.error(error.message);
  if (error.code === "GITHUB_AUTH_REQUIRED" || error.code === "GITHUB_ADMIN_INACCESSIBLE") {
    console.error("Use a token with Repository Administration read access.");
    process.exit(2);
  }
  throw error;
}
