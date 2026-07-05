# Security Policy

Meridian is a DeFi application that routes real user funds through Soroban smart contracts on the Stellar network. We take security seriously. If you discover a vulnerability, please follow this policy rather than opening a public issue.

---

## Supported Versions

| Version          | Supported         |
| ---------------- | ----------------- |
| `main` branch    | Yes               |
| `develop` branch | Yes (pre-release) |
| All others       | No                |

---

## Scope

### In Scope

The following are considered in scope for vulnerability reports:

- **Soroban smart contracts** (`packages/contracts/`) on Stellar **mainnet** — treat any finding here as **Critical severity**
- **Soroban smart contracts** on Stellar **testnet** — treat as High severity
- **API server** (`apps/api/`) — authentication bypass, injection, SSRF, exposed secrets, improper input validation
- **Frontend** (`apps/web/`) — XSS, insecure wallet interaction, transaction manipulation before signing
- **SDK helpers** (`packages/stellar-sdk-helpers/`) — incorrect transaction construction, signing logic flaws, improper RPC handling
- **Dependency vulnerabilities** that directly affect on-chain behaviour or user funds
- **Private key or seed phrase exposure** anywhere in the codebase or build artifacts

### Out of Scope

The following are explicitly out of scope:

- Vulnerabilities in third-party protocols (Blend Capital, DeFindex) — report those to their respective teams
- Issues that require physical access to a user's device
- Social engineering attacks against users or maintainers
- Findings on testnet that have no realistic path to mainnet exploitation
- Rate limiting or DDoS on the public API (covered by existing mitigations)
- Self-XSS or issues requiring the attacker to already control the victim's browser session
- Theoretical vulnerabilities with no demonstrated impact

---

## How to Report

**Do not open a public GitHub issue for security vulnerabilities.**

Use **GitHub's private vulnerability reporting**:

1. Go to [https://github.com/drydocs/meridian/security/advisories/new](https://github.com/drydocs/meridian/security/advisories/new)
2. Fill in the advisory form with as much detail as possible (see below)
3. Submit — this creates a private draft advisory visible only to you and the maintainer

Alternatively, open a thread in [GitHub Discussions](https://github.com/drydocs/meridian/discussions) with the subject line `[SECURITY] Meridian — <brief description>`.

### What to Include in Your Report

- **Description** — what is the vulnerability and where does it exist
- **Impact** — what can an attacker achieve (e.g. drain funds, steal keys, forge transactions)
- **Reproduction steps** — the minimum steps needed to reproduce the issue
- **Affected component** — contract address / file path / endpoint
- **Network** — testnet or mainnet
- **Suggested fix** — optional, but appreciated

---

## Response SLA

| Stage                                  | Target                                        |
| -------------------------------------- | --------------------------------------------- |
| Acknowledgement                        | Best effort within **48 hours** — see note¹   |
| Initial triage and severity assessment | Within **5 business days**                    |
| Fix or mitigation for Critical/High    | Within **14 days** where technically feasible |
| Public disclosure                      | Coordinated with reporter after fix deploys   |

¹ Meridian is solo-maintained. For Critical reports, open a GitHub Discussions thread in addition to the advisory to improve response time.

We will keep you informed at each stage. If you do not receive an acknowledgement within 48 hours, follow up via GitHub Discussions.

---

## Severity Guidance

| Severity     | Examples                                                       |
| ------------ | -------------------------------------------------------------- |
| **Critical** | Drain funds via mainnet contract exploit; private key exposure |
| **High**     | Unauthorised tx signing; testnet exploit with mainnet path     |
| **Medium**   | API auth bypass without fund access; XSS in wallet flow        |
| **Low**      | Information disclosure; input gap with no fund risk            |

**On-chain contracts deployed to mainnet are always treated as Critical severity regardless of the apparent difficulty of exploitation.** Even a theoretical vulnerability in a contract holding user funds warrants immediate response.

---

## Disclosure Policy

Meridian follows **coordinated disclosure**:

- We ask reporters to allow us reasonable time to fix the issue before public disclosure
- We will not take legal action against researchers acting in good faith under this policy
- We will credit reporters in the security advisory and release notes unless they request anonymity
- We do not currently offer a monetary bug bounty, but we will advocate for Wave program recognition for significant findings

---

## Known Limitations (Current Development Phase)

Meridian `v0.1.0` is a pre-mainnet scaffold. No real user funds are at risk in the current release. However, smart contract code merged into `main` that is intended for mainnet deployment must be reviewed as if funds are already at stake.
