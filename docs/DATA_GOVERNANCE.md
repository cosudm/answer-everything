# Data governance

## Classification

Every knowledge object, conversation and project carries a privacy class:

| Class        | Meaning                                                    | Who may process it                                                                 |
| ------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| PUBLIC       | Publicly available material                                | Any approved model                                                                 |
| INTERNAL     | Workspace material fit for any approved model              | Any approved model cleared for INTERNAL                                            |
| CONFIDENTIAL | Requires contractual no-training / limited-retention terms | Models whose provider posture meets that bar (declared in `privacyClassesAllowed`) |
| RESTRICTED   | Private or dedicated deployments only                      | DEDICATED_ENDPOINT / OPEN_WEIGHT / LOCAL deployments cleared for RESTRICTED        |

Workspaces set a default class and a ceiling (`maxPrivacyClass`); nothing in the workspace may be classified above the ceiling. A conversation's class ratchets up when higher-class knowledge is attached, and only models cleared for that class may answer it afterwards.

## AI-use permission

Each knowledge object has `aiUsePermission` ALLOW or DENY. DENY keeps the item visible, searchable and exportable for people while making it invisible to retrieval for models. Enforced in SQL and in policy.

## Provenance

`provenance_records` is append-only lineage: UPLOADED/CREATED → EXTRACTED → EMBEDDED (with model) → INDEXED → RETRIEVED_FOR / CITED_BY (with answer record) → PRIVACY_CHANGED / ARCHIVED / DELETED. Every answer records GENERATED_BY_MODEL with its context manifest. The context manifest itself is immutable and lists every item considered, included or dropped, with the authorization decision that governed it.

## Retention

- Conversations: `conversationRetentionDays` per workspace (null = until deleted). The retention sweep job is defined (`retention.sweep`) and not yet implemented.
- Knowledge: kept until archived or deleted. Delete is a soft delete on the object and a hard delete of its chunks (retrieval stops immediately).
- Audit and provenance: never deleted by the application; archive externally per compliance needs.
- Sessions: expired rows can be pruned; revoked rows are kept for the reuse-detection window.

## Export

`POST /v1/account/export` returns JSON for every workspace the user owns: conversations, messages, knowledge (with text), answer records and model runs (usage and cost, no provider credentials). Self-only, audited. Large accounts move to an asynchronous export with a signed download (roadmap).

## Deletion

`POST /v1/account/delete` requires typing the account email, marks the user `PENDING_DELETION`, revokes every session, and enqueues `account.delete`. The purge handler (cascading workspace deletion for sole-owner workspaces, membership removal otherwise, anonymizing audit actor ids) is specified but not implemented; STATUS.md tracks it.

## Memory

Confirmed memory is opt-in (`memoryEnabled`, default off) and not yet implemented. When it ships, memories are knowledge objects of kind MEMORY with the same classification, permission and deletion semantics as everything else.

## Sharing

Workspaces are the sharing boundary. Members see workspace conversations and knowledge according to role (VIEWER read; MEMBER create and manage own; ADMIN manage all; OWNER delete workspace). Share links and per-conversation visibility are roadmap items; nothing is shared outside a workspace today.

## Model data handling

Providers declare `dataHandling` (trains on data, retention days, region). Privacy classes allowed per model are set by the platform administrator with that posture in mind, and are visible on the Models screen.
