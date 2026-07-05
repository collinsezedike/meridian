# Contributing to Meridian

Thank you for considering a contribution to Meridian. Meridian is an open-source stablecoin yield aggregator on Stellar and Soroban, and contributions across TypeScript, Rust, and frontend UI are welcome.

This document is the single source of truth for contributing. Please read it in full before opening an issue or pull request.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Ways to Contribute](#ways-to-contribute)
- [First-Time Contributors](#first-time-contributors)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [Project Structure](#project-structure)
- [Opening Issues](#opening-issues)
- [Security Vulnerabilities](#security-vulnerabilities)
- [Branch Naming](#branch-naming)
- [Commit Convention](#commit-convention)
- [Code Standards](#code-standards)
- [Pull Request Process](#pull-request-process)
- [Running Checks Locally](#running-checks-locally)
- [Getting Help](#getting-help)

---

## Code of Conduct

Participation in this project is governed by the [Meridian Code of Conduct](CODE_OF_CONDUCT.md). By contributing, you agree to uphold it. Violations may be reported via [GitHub Discussions](https://github.com/drydocs/meridian/discussions) (select the Q&A category and mark it private if needed).

---

## Ways to Contribute

**In scope:**

- Bug reports and bug fixes
- Features that have been discussed and approved in a GitHub Discussion
- Documentation -- README, JSDoc, guides, inline comments
- Additional test coverage for any package
- Performance improvements with benchmarks
- Dependency updates and CI improvements

**Not accepted:**

- Unsolicited refactors of code you did not introduce -- if cleanup is needed, open a `[Chore]` issue first
- Features that have not been approved in a GitHub Discussion -- PRs for unapproved features will be closed without review
- PRs that bundle multiple unrelated changes -- one PR per issue, always
- Changes to formatting or naming conventions that contradict the existing code style

If you are unsure whether a contribution fits, open a GitHub Discussion before writing any code.

---

## First-Time Contributors

If this is your first open-source contribution, start here:

1. Filter issues by [`good first issue`](https://github.com/drydocs/meridian/issues?q=is%3Aopen+label%3A%22good+first+issue%22) -- these are fully isolated tasks that do not require deep knowledge of Stellar or Soroban.
2. Comment on the issue to signal you are picking it up before starting.
3. Follow the [Getting Started](#getting-started) guide below to set up the project.
4. When your PR is ready, follow the [Pull Request Process](#pull-request-process) section exactly.

---

## Prerequisites

Before cloning, confirm you have the required tools installed:

| Tool           | Required version | Check               |
| -------------- | ---------------- | ------------------- |
| Node.js        | `>=20`           | `node --version`    |
| pnpm           | `9.x`            | `pnpm --version`    |
| Rust toolchain | stable (latest)  | `rustc --version`   |
| Soroban CLI    | latest           | `soroban --version` |

Rust and Soroban CLI are only required if you are working on the smart contracts in `packages/contracts`. TypeScript-only contributors can skip them.

To install pnpm at the correct version:

```bash
npm install -g pnpm@9
```

---

## Getting Started

1. Fork the repo on GitHub, then clone your fork:

   ```bash
   git clone https://github.com/<your-username>/meridian.git
   cd meridian
   ```

2. Add the upstream remote so you can keep your fork in sync:

   ```bash
   git remote add upstream https://github.com/drydocs/meridian.git
   ```

3. Before starting any work, sync your fork with upstream:

   ```bash
   git fetch upstream
   git checkout main
   git rebase upstream/main
   ```

4. Install dependencies:

   ```bash
   pnpm install
   ```

5. Copy and configure your environment:

   ```bash
   cp .env.example .env
   ```

   Edit `.env` and set the values you need:

   | Variable            | Required for | Description                                                                                                      |
   | ------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------- |
   | `PORT`              | API          | Port for the Fastify API server. Default `3001`.                                                                 |
   | `ALLOWED_ORIGIN`    | API          | CORS allowed origin. Default `http://localhost:3000`.                                                            |
   | `DEFINDEX_VAULT_ID` | API          | DeFindex vault contract address (C-address). Leave empty to disable DeFindex; only Blend positions are returned. |
   | `VITE_API_URL`      | Web          | URL the web app uses to reach the API. Default `http://localhost:3001`.                                          |

6. Start the development servers:

   ```bash
   pnpm dev
   # Web:    http://localhost:3000
   # API:    http://localhost:3001
   # Health: http://localhost:3001/health
   ```

7. Confirm the full check suite passes before making any changes:

   ```bash
   pnpm lint && pnpm typecheck && pnpm test
   ```

---

## Project Structure

Meridian is a pnpm monorepo managed with Turborepo:

```text
meridian/
  apps/
    web/        -- Vite + React frontend (Freighter wallet, yield dashboard)
    api/        -- Fastify API (yield aggregation, Soroban tx building)
    docs/       -- Documentation site
    landing/    -- Landing page
  packages/
    contracts/  -- Soroban smart contracts (Rust)
    shared/     -- Shared utilities used by both api and web
    stellar-sdk-helpers/ -- Typed wrappers around @stellar/stellar-sdk
```

Changes to `packages/` affect multiple apps. If you modify a shared package, run the full check suite from the repo root.

---

## Opening Issues

Use one of the two GitHub issue templates. Blank issues are disabled.

### Title format

Every issue title must use the bracket prefix format:

```text
[Type] Short imperative description
```

| Prefix             | When to use                                 |
| ------------------ | ------------------------------------------- |
| `[Bug]` or `[Fix]` | Something is broken or behaving incorrectly |
| `[Feature]`        | New capability or significant enhancement   |
| `[Frontend]`       | Frontend-scoped work (React, UI, Tailwind)  |
| `[Test]`           | Adds or improves test coverage              |
| `[Docs]`           | Documentation, README, JSDoc, guides        |
| `[Chore]`          | Refactor, cleanup, dependency update, CI    |

### Which template to use

- **Bug Report** -- for anything broken, incorrect, or behaving unexpectedly
- **Feature Request** -- for features, frontend tasks, tests, docs, and chores

### Labels

Apply labels from all three categories before submitting. PRs linked to unlabelled issues will be asked to add labels before review begins.

| Category   | Pick           | Options                                                                         |
| ---------- | -------------- | ------------------------------------------------------------------------------- |
| Purpose    | one            | `bug`, `enhancement`, `docs`, `testing`, `chore`, `security`                    |
| Area       | all that apply | `frontend`, `api`, `sdk`, `contracts`, `ci`, `ui`, `i18n`, `stellar`, `soroban` |
| Complexity | one            | `trivial`, `medium`, `hard`                                                     |

Use `good first issue` in place of a complexity label for tasks that are fully isolated and require no Stellar or Soroban knowledge.

---

## Security Vulnerabilities

**Do not open a public GitHub issue for security vulnerabilities.**

Report security issues via [GitHub's private vulnerability reporting](https://github.com/drydocs/meridian/security/advisories/new). Include:

- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fix (optional)

You will receive a response within 72 hours. Please allow time for the issue to be triaged and patched before public disclosure.

---

## Branch Naming

All branches must follow this pattern:

```text
<type>/<short-description>
```

**Types:** `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`

**Examples:**

```text
feat/freighter-wallet-integration
fix/apy-cache-stale-data
docs/blend-integration-guide
test/yield-routing-edge-cases
```

Branches that do not match this pattern will fail the branch naming ruleset and cannot be merged.

---

## Commit Convention

Meridian uses [Conventional Commits](https://www.conventionalcommits.org/). Every commit must follow this format:

```text
<type>[(<scope>)]: <subject>
```

**Types:** `feat`, `fix`, `test`, `docs`, `refactor`, `perf`, `chore`, `ci`

**Scopes (optional):** Use the relevant package or app: `api`, `web`, `contracts`, `sdk`, `shared`, `ci`, `docs`

**Rules:**

- Subject line under 72 characters
- Use imperative mood: "add" not "added" or "adds"
- No period at the end of the subject

**Examples:**

```text
feat(api): add Blend pool APY aggregation endpoint
fix(sdk): handle Soroban RPC timeout on testnet
test(api): add edge case coverage for empty pool response
docs: update CONTRIBUTING with Soroban contract standards
chore: pin Node.js to v20 in GitHub Actions workflow
```

> Issue references (`Closes #N`) go in the **PR body**, not in commit messages. Squash merge is enforced -- the PR title becomes the squash commit, so issue refs in individual commits are discarded.

Commits that do not match the `^(feat|fix|docs|chore|refactor|test|style|ci|perf)(\(.+\))?: .{1,72}$` pattern will be blocked by the commit message ruleset.

---

## Code Standards

### TypeScript (`apps/web`, `apps/api`, `packages/*`)

- **Formatting:** Run `pnpm format` before committing. Prettier with default settings.
- **Linting:** Must pass `pnpm lint` with zero errors.
- **Types:** No `any`. Use `unknown` and narrow explicitly. Zod schemas are the source of truth for all external data shapes.
- **Naming:**
  - `PascalCase` for types, interfaces, classes, and React components
  - `camelCase` for variables, functions, and object keys
  - `UPPER_SNAKE_CASE` for module-level constants
  - `kebab-case` for filenames
- **Error handling:** Never swallow errors silently. Log with context and re-throw or return a typed error result.
- **No side effects at module load time.** Protocol clients must be instantiated inside functions, not at the top level of a module. Module-level `localStorage`, `navigator`, or SDK `.init()` calls are violations.
- **Comments:** Only comment on WHY, not what the code does. If the code needs a what-comment, the code should be rewritten.

### Rust / Soroban (`packages/contracts`)

- **Formatting:** Run `cargo fmt --all` before committing.
- **Linting:** Must pass `cargo clippy --all-targets -- -D warnings` with zero warnings.
- **Naming:**
  - `snake_case` for functions and variables
  - `PascalCase` for types and traits
  - `UPPER_SNAKE_CASE` for constants
- **Error handling:** Use `Result<T, E>` everywhere. No `.unwrap()` in contract code except on values that are provably infallible; explain why in an inline comment.
- **Documentation:** All public functions must have doc comments (`///`). Include a one-line summary and a note on any panics or preconditions.
- **Security:** Validate all inputs. Assume callers are adversarial. Never read from storage without checking the key exists first.

---

## Pull Request Process

### PR body format

Every PR must use this structure (the GitHub PR template pre-fills it):

```markdown
## Summary

- What changed and why (bullet points, not a list of files touched)

## Test plan

- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass locally
- [ ] What you manually verified

Closes #N
```

`Closes #N` must reference the issue this PR resolves. PRs with no linked issue will not be reviewed.

### Changelog

Maintainers own the changelog. Contributors do not need to update it.

### Rules

1. **One PR per issue.** Do not bundle multiple issues into a single PR.
2. **Keep PRs small.** A PR that changes more than 400 lines of non-test code will be asked to split.
3. **Fill out the PR template fully.** Incomplete templates will be closed without review.
4. **All CI checks must pass** before a review will begin. Do not open a PR with known failures.
5. **Resolve all review comments** before requesting a re-review. Mark a thread as resolved only after you have addressed it.
6. **Do not force-push** after a review has started. Add new commits to address feedback so the reviewer can see what changed.
7. **Squash on merge** is enforced. Your commit history inside the branch does not need to be clean, but your PR title must follow the commit convention -- it becomes the squash commit message.

### What to expect

Pull requests are reviewed within 72 hours of submission. You will receive one of:

- **Approved** -- the PR will be merged promptly
- **Changes requested** -- address the comments and request a re-review
- **Closed** -- the PR is out of scope, a duplicate, or does not meet the standards in this guide; the closing comment will explain why

---

## Running Checks Locally

Run all checks before pushing. CI will catch failures, but fixing them locally is faster.

```bash
# Full check suite (run this before every push)
pnpm lint && pnpm typecheck && pnpm test

# Individual checks
pnpm lint          # ESLint across all packages
pnpm typecheck     # tsc --noEmit across all packages
pnpm test          # Vitest across all packages
pnpm format        # Prettier (auto-fix)

# Run tests for a single package
pnpm --filter @meridian/stellar-sdk-helpers test

# Run a single test file
pnpm test -- packages/stellar-sdk-helpers/src/__tests__/tx.test.ts

# Soroban contract checks (only needed when modifying packages/contracts)
cargo fmt --all
cargo clippy --all-targets -- -D warnings
cargo test --all
```

---

## Getting Help

- **Questions about an issue?** Comment on the issue directly.
- **Dev setup broken?** Open a GitHub Discussion under the Q&A category.
- **Found a bug not covered by an existing issue?** Open a new issue using the Bug Report template before starting any work.
- **Have a feature idea?** Open a Discussion first. Do not open a PR for a feature that has not been discussed and approved.
- **Security issue?** Use [GitHub private vulnerability reporting](https://github.com/drydocs/meridian/security/advisories/new) -- do not open a public issue.

---

By contributing to Meridian, you agree that your contributions will be licensed under the project's [MIT License](LICENSE).
