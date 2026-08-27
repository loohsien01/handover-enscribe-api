# Maven Stories piggyback — shared AWS with Enscribe

Enscribe-side record of how **Maven Stories** (`maven-stories-api`) may use this AWS account. Maven is an adult stories + audio product. Enscribe is the clinical API. They share an **account, region, VPC, and RDS instance**. They must **not** share identities, buckets, user pools, mail, or the Enscribe API host.

Maven’s copy of this plan: `maven-stories-api/docs/AWS_RESOURCES.md`. This doc is the Enscribe POV: what we reuse, what we never attach to Maven, and what ops must not break.

This **supersedes** the “new AWS account / new RDS instance” line in [NIFTI_SKELETON_SALVAGE.md](./NIFTI_SKELETON_SALVAGE.md). Skeleton **code** is still a new repo. The **account** is shared; isolation is resource + IAM.

**Status (2026-08-21):** `maven_stories` database and `maven_app` role exist on `enscribe-prod`. Cognito pool for Maven is in progress (new pool, not `enscribe-prod`). Fill ARNs as they land.

Related Enscribe infra:

| Topic | Doc |
|-------|-----|
| RDS instance + SGs | [RDS_POSTGRES_MIGRATION.md](./RDS_POSTGRES_MIGRATION.md) |
| Cognito pool (Enscribe) | [COGNITO_AUTH_MIGRATION.md](./COGNITO_AUTH_MIGRATION.md) |
| Recordings bucket | [S3_AUDIO_FILES_MIGRATION.md](./S3_AUDIO_FILES_MIGRATION.md) |
| Code salvage (allowlist) | [NIFTI_SKELETON_SALVAGE.md](./NIFTI_SKELETON_SALVAGE.md) |

---

## Why share at all

Same laptop, same operator, same `us-east-1` VPC. A second account would mean new IAM, VPC, NAT, and RDS just to host an empty Fastify API. Piggyback is cheaper **if** the blast-radius wall is IAM + separate databases.

What sharing is **not**: one app, one database, one Cognito pool, or Maven processes on the Enscribe EC2 box.

---

## Decision summary

| Service | Maven | Enscribe constraint |
| --- | --- | --- |
| **AWS account** | Reuse `637423355461` | Same account. Do not reuse Enscribe **roles, keys, or pools**. |
| **Region** | Reuse `us-east-1` | — |
| **VPC** | Reuse `vpc-0bfb4ffe543ec4e9b` | Network only. No new VPC. |
| **RDS instance** | Reuse `enscribe-prod` | Shared CPU, disk, backups. Maven load can contend with Enscribe. Split instances later if needed. |
| **RDS database** | **New** `maven_stories` | Never create Maven tables in `enscribe`. |
| **RDS DB user** | New `maven_app` | No `CONNECT` / grants on database `enscribe`. Master `enscribe_admin` is for ops only. |
| **RDS security group** | Reuse `rds-ec2-1`, add Maven compute as a **source SG** | Inbound `5432` stays SG-to-SG. Do **not** add `0.0.0.0/0`. Do **not** put Maven EC2 on `ec2-rds-1` (that SG is Enscribe’s). |
| **S3** | **New** bucket (`maven-audio`) | Not `enscribe-recordings-prod` / archive buckets. |
| **Cognito** | **New** user pool | Not `enscribe-prod` (`us-east-1_UxICChcfK`) or `enscribe-dev`. |
| **SES** | New domain identity | Same SES *service*. Do not send from `enscribe.online`. |
| **Secrets** | New, prefix `maven/` | Not Enscribe GitHub secrets / EC2 `.env`. |
| **KMS** | Reuse AWS-managed / existing RDS encryption | No extra CMK required for “workspace” split. |
| **CloudWatch** | New log groups | Not Enscribe API logs. |
| **ALB / ECS** | Maven’s choice (they plan new ALB + ECS) | Do not put Maven target groups on Enscribe’s listener without a dedicated cert/host. |
| **ECR** | New `maven-stories-api` | — |
| **EC2 (Enscribe API)** | **Do not reuse** | Maven API is not PM2 on the Enscribe instance. |
| **EC2 (DB tunnel)** | Laptop may keep using Enscribe EC2 as SSH jump (`npm run db:tunnel`) | Tunnel is SSH `:22` on `launch-wizard-1`. Maven must not assume `enscribe-api-ec2-instance-role`. |
| **IAM** | **New** Maven roles | See [Do not share with Maven](#do-not-share-with-maven). |
| **GitHub OIDC** | Account-level provider (one per account) | Maven deploy role is a **new** role; do not reuse Enscribe deploy credentials as Maven’s. |

---

## Already done (RDS)

On instance `enscribe-prod` (`enscribe-prod.c8fay082y82d.us-east-1.rds.amazonaws.com`):

| Object | Status |
|--------|--------|
| Database `maven_stories` | Created; empty `public` schema |
| Role `maven_app` | Login role; `CONNECT` + **owner** of `maven_stories` |
| Database `enscribe` | Untouched |
| `enscribe_dryrun` | Leftover cutover rehearsal — not for Maven |
| `rdsadmin` | AWS internal — ignore |

Maven local URL (tunnel, not committed here):

```text
postgresql://maven_app:…@127.0.0.1:15432/maven_stories?sslmode=require
```

Prod URL uses the same RDS hostname as Enscribe, **database name** `maven_stories`, user `maven_app`.

`npm run db:tunnel` in **this** repo still forwards that instance. Maven can use the same local port while the tunnel is up.

---

## Do not share with Maven

These stay Enscribe-only even though the account is shared:

| Resource | Why |
|---------|-----|
| Cognito `enscribe-prod` / `enscribe-dev` | Clinical users, SES templates, `sub` mapping to `auth.users` |
| S3 recordings + archive buckets | PHI audio |
| Secrets not under `maven/` | `DATABASE_URL` for `enscribe`, Stripe, Deepgram, Bedrock, RSA keys |
| SES / Cognito mail on `enscribe.online` | Clinical transactional identity |
| EC2 instance role `enscribe-api-ec2-instance-role` | Can read Enscribe S3 + Cognito + RDS via instance profile |
| Enscribe API instance (PM2 / deploy.yml) | Wrong app, wrong env, blast radius |
| Postgres role that can read `enscribe` | `maven_app` must not |
| `ec2-rds-1` (`sg-0357ef13932ae6694`) | Attaching Maven compute here lets it open **Enscribe** Postgres with any stolen creds that can connect; use a **new** SG as RDS inbound source |

---

## RDS security group (the one risky change)

Today:

```text
EC2 (Enscribe)  --sg ec2-rds-1-->  RDS rds-ec2-1 :5432
Laptop          --SSH 22 launch-wizard-1-->  same EC2  --tunnel-->  RDS
```

For Maven compute (new ECS tasks or a new EC2):

1. Create SG `maven-rds-1` (or similar) on the **Maven** compute.
2. On **RDS** SG `rds-ec2-1`, add inbound **5432** from `maven-rds-1` only.
3. Do **not** add Maven instances to `ec2-rds-1`.
4. Do **not** open `5432` to the internet.

Both databases share the listener. Network access to the instance is necessary for Maven; **authorization** is the `maven_app` role + database `maven_stories`. A Maven bug with Enscribe credentials would still be catastrophic — never put Enscribe `DATABASE_URL` on Maven hosts.

**Noisy neighbor:** one RDS instance. Maven TTS/upload spikes can starve Enscribe. Watch connections, CPU, storage. Split RDS if Maven leaves “side project” scale.

---

## Cognito (Maven)

New pool in `us-east-1`. Console “application type” = **SPA** (sample code only). Real login is Fastify → `AdminInitiateAuth` / `SignUp`, same as Enscribe.

After create, app client must allow:

- `ALLOW_ADMIN_USER_PASSWORD_AUTH`
- `ALLOW_REFRESH_TOKEN_AUTH`
- optional `ALLOW_USER_PASSWORD_AUTH`

Sign-in identifier: **email only**. Required attribute: **email only**. Self-registration on when public signup is wanted. No Hosted UI required for v1. No client secret.

Do not copy `COGNITO_USER_POOL_ID=us-east-1_UxICChcfK` or Enscribe client IDs into Maven.

IAM for Maven’s task role: `cognito-idp:*` on the **Maven pool ARN only**, not `userpool/*`.

---

## IAM (Maven creates; Enscribe operators must not mix)

Maven should create (see their `infra/maven-iam.yaml`):

| Identity | Purpose |
|----------|---------|
| `maven-api-task` | Runtime: Maven Cognito, `maven-audio`, `maven/*` secrets |
| `maven-api-execution` | ECS pull ECR + logs + inject secrets |
| `maven-github-deploy` | GitHub OIDC — ECR push, ECS update, `PassRole` onto the two roles above |
| Laptop / SSO set | `AWS_ACTIONS_*` in Maven `.env.local` only |

**Never** attach `enscribe-api-ec2-instance-role` to Maven tasks or instances. **Never** put Enscribe `AWS_ACTIONS_*` in Maven GitHub secrets.

`rds-monitoring-role` is account-level; one is enough.

---

## Create order (remaining)

1. Maven IAM stack (OIDC + Maven roles) — needs an IAM admin; laptop user may lack `iam:CreateRole`.
2. RDS SG: inbound 5432 from Maven compute SG (when Maven has compute). Database + user already exist.
3. S3 `maven-audio`, Cognito pool, SES domain, Secrets Manager `maven/…`.
4. Maven ECR + compute (ECS/ALB or a **new** EC2). Keep Enscribe EC2 as API + optional SSH bastion.
5. Maven GitHub deploy workflow (`role-to-assume` only).

---

## ARNs / ids (fill in)

| Resource | Value |
| --- | --- |
| Account | `637423355461` |
| VPC | `vpc-0bfb4ffe543ec4e9b` |
| RDS instance | `enscribe-prod` / `enscribe-prod.c8fay082y82d.us-east-1.rds.amazonaws.com` |
| Enscribe database | `enscribe` (user: app role / `enscribe_admin` for ops) |
| Maven database / user | `maven_stories` / `maven_app` |
| RDS SG | `rds-ec2-1` (`sg-0beec9b78a5d28ca8`) |
| Enscribe EC2 extra SG | `ec2-rds-1` (`sg-0357ef13932ae6694`) — Enscribe only |
| Enscribe Cognito prod | `us-east-1_UxICChcfK` — **do not reuse** |
| Maven Cognito pool | |
| Maven Cognito client | |
| Maven S3 | `maven-audio` (create) |
| SES Maven | Maven domain (not `enscribe.online`) |
| Enscribe instance role | `enscribe-api-ec2-instance-role` — **do not reuse** |
| Maven task / execution / deploy roles | |

---

## Operator checklist (Enscribe)

- [ ] Maven tables never appear in `\c enscribe`
- [ ] `maven_app` cannot `CONNECT` to `enscribe` (revoke if granted by mistake)
- [ ] RDS SG inbound 5432 sources are only known app SGs
- [ ] Enscribe deploy still uses Enscribe Cognito, S3, and `DATABASE_URL` → `/enscribe`
- [ ] Maven env never contains Enscribe pool ID, recordings bucket, or Stripe/Deepgram clinical keys
