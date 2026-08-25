# CodeFolderSync V3 protocol

Local and SSH hubs expose the same V3 operations. Local mode calls `HubStore`; SSH mode runs:

```text
ssh -T -o BatchMode=yes -o ConnectTimeout=10 <host> \
  <command> hub serve --stdio --hub-base64 <base64url-absolute-path>
```

The first operation is `hello`. Anything other than protocol version 3 is rejected before folder state is read or changed.

## Framing

Each request and response contains:

```text
4-byte big-endian JSON-header length
4-byte big-endian binary-payload length
UTF-8 JSON header
binary payload
```

Headers are capped at 256 MiB and payloads at 512 MiB. The larger metadata ceiling accommodates explicit mutation evidence for bounded large recursive snapshots. Ordinary object batches cap at 256 objects and roughly 8 MiB. Truncation, invalid JSON, oversized lengths, response-ID mismatch, invalid slice bounds, or a failed response aborts the request.

One persistent SSH subprocess serializes request/response pairs. The hub path is base64url encoded as one inert argument; host and command components pass conservative validation. SSH owns transport authentication and encryption.

## Operations

| Operation                 | Meaning                                                      | Mutates hub |
| ------------------------- | ------------------------------------------------------------ | ----------- |
| `hello`                   | Return protocol version                                      | No          |
| `create-folder`           | Pin initial signed authority config                          | Yes         |
| `checkpoint`              | Return accepted config, sequence, and snapshot               | No          |
| `update-config`           | Authority-signed revision CAS and optional adoption barrier  | Yes         |
| `missing-objects`         | Negotiate immutable objects                                  | No          |
| `put-objects`             | Verify and store bounded object bytes                        | Yes         |
| `get-objects`             | Return bounded immutable object bytes                        | No          |
| `accept-snapshot`         | Verify signature, peer sequence, mutations, closure, and CAS | Yes         |
| `add-conflict`            | Retain conflict/recovery record                              | Yes         |
| `conflicts`               | List retained conflicts                                      | No          |
| `verify-adoption`         | Bind a peer to one source sequence and digest                | Yes         |
| `verified-adoption-peers` | Read adoption readiness                                      | No          |
| `history`                 | Read ordered snapshot and barrier evidence                   | No          |

Unknown operations fail explicitly.

## Commit order and retry

The client persists the exact signed snapshot, peer sequence, deterministic mutation list, embedded normal conflicts, and object closure in its outbox before transport. Objects commit on the hub before metadata. The hub verifies the peer signature, requires the peer sequence to advance, independently derives the expected mutations from the accepted checkpoint, validates their immutable object closure, then commits the checkpoint, event evidence, and conflicts atomically. Peer-sequence gaps are allowed because a stale queued proposal can be discarded after another peer advances the global checkpoint; reuse or regression is rejected. A lost acknowledgement leaves the outbox intact.

Retry reuses event ID, peer sequence, base sequence, mutations, payload, and signature. The hub checks an existing event before evaluating its now-stale base sequence and returns the stored sequence only when the payload hash is identical. Reusing an ID with changed JSON fails.

A genuine stale CAS is not silently rewritten. The client proves the event was not accepted, retains the proposal in the live tree, removes only the obsolete serialization, and performs a fresh three-way causal merge.

## Configuration and peer authority

The hub verifies every configuration revision with the pinned authority public key. It rejects authority replacement and any lifecycle transition except `adoption -> normal`. The adoption barrier additionally proves that every required target verified the current source sequence and digest.

Each snapshot signature is checked against the publishing peer's enrolled public key. During adoption any non-authority snapshot is rejected. Ordered history exposes the global sequence, peer sequence, snapshot digest, and exact mutation JSON for accepted snapshot events.
