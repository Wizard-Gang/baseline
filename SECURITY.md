# Security policy

Report a vulnerability privately using GitHub's **Report a vulnerability** entry in the repository Security tab, when enabled. If that feature is unavailable, contact the repository owner through a private channel. Do not put exploit details or credentials in a public issue or pull request.

This seed has no runtime service. Its security surface is the dependency graph, GitHub Actions, repository permissions, merge controls, tag and Release identity, and published artifacts. CI uses read-only permissions except the bounded release publication job. Actions are pinned to full commit SHAs. Dependency and workflow update suggestions are inputs to a controlled `SEC` or `BUILD` change; they do not bypass IDs, review, or exact-head CI.

`npm audit --audit-level=high` is a network-backed required check. Dependency and GitHub Actions updates follow the controlled queue. A vulnerable dependency is updated or explicitly removed in a controlled change. Do not add an audit bypass, ignore rule, or broader token scope without a specific risk record and owner review. Keep tokens in environment or GitHub secrets, never in source, PR text, test fixtures, or logs.
