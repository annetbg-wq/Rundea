# ADR 0012: GitHub App private source stays inside the Control Plane

Status: Accepted for v0

## Context

Rundea must deploy private repositories without placing a permanent GitHub PAT, GitHub App private key or installation access token on a customer VPS. The Source Broker introduced a provider-neutral boundary: the Agent can receive an exact source bundle through a deployment-scoped one-time Rundea ticket.

GitHub private repository archives require authentication. A GitHub App installation access token is appropriate because it can be restricted to selected repositories and `contents:read`, but it is still a credential and must not cross the Control Plane trust boundary.

## Decision

Rundea uses a platform-level GitHub App only in the Control Plane.

Configuration:

- `RUNDEA_GITHUB_APP_ID`
- `RUNDEA_GITHUB_APP_PRIVATE_KEY_BASE64`

Both values are optional as a pair. Public repository Source Broker delivery continues to work without a GitHub App.

For a private repository at an exact commit SHA the Control Plane:

1. attempts the credential-free public archive endpoint;
2. if GitHub reports an authentication/not-found class result and a GitHub App is configured, creates a short-lived RS256 App JWT;
3. resolves the App installation for the exact `owner/repository`;
4. creates an installation token restricted to that one repository and `contents:read`;
5. requests `/repos/{owner}/{repo}/tarball/{sha}` with `redirect: manual`;
6. accepts only an HTTPS redirect to `codeload.github.com`;
7. downloads the temporary archive URL in a new request **without** the installation token;
8. passes the bounded archive to the existing one-time Source Broker endpoint;
9. lets the Agent validate the expected SHA header and apply the existing safe archive extraction rules.

The installation token is held only in process memory for the upstream request. It is never stored in PostgreSQL, returned by an API, written into a deployment event, passed to the Agent or embedded in the archive URL by Rundea.

## GitHub push deployments

A verified GitHub push already contains an exact `after` commit SHA. Webhook-triggered deployments therefore have no reason to use direct Git checkout on a node. The database enforces that a deployment linked to a GitHub webhook delivery is changed to `source_delivery='BROKER'` while it is still `QUEUED` and before dispatch.

Manual branch/tag deployments can continue using the direct Git path in v0 so the two execution paths remain independently useful. Private source should use exact-SHA broker delivery.

## Redirect security

Authenticated GitHub API archive requests do not automatically follow redirects. The first request carries the installation token only to `api.github.com`. The redirect target is parsed and rejected unless it is HTTPS on the exact `codeload.github.com` host with no embedded credentials or fragment. The second request deliberately omits `Authorization`.

This prevents a compromised or unexpected redirect from receiving a GitHub installation token.

## Archive limits

The Control Plane enforces the compressed archive limit while reading the response stream, not after buffering an unbounded response. The Agent independently enforces compressed, uncompressed, per-file and entry-count limits and rejects traversal, multiple roots, links and unsupported special entries.

## Acceptance boundary

CI can prove JWT signing, installation lookup, least-privilege token request, redirect validation, credential stripping and the full public Source Broker runtime path using mocks plus the existing Docker node acceptance.

A claim that private repository deployment works against GitHub itself requires a real Rundea GitHub App installation and a private repository acceptance run. Until those credentials exist, the external private-source integration remains **implemented but not live-accepted**.

## Consequences

- Nodes remain provider-neutral and GitHub-credential-free.
- GitLab or Bitbucket can later implement the same upstream archive-provider contract without changing the Agent.
- Private source access is revocable by removing the GitHub App installation.
- The Control Plane becomes responsible for protecting the GitHub App private key and should eventually move it behind a production secret/KMS boundary.
- Installation token caching is intentionally omitted initially; correctness and least privilege are preferred over avoiding a small number of GitHub API calls.
