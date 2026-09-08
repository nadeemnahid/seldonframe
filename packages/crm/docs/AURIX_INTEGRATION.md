# AurixCRM integration — release state

**NOT ACTIVATED. Draft implementation; cloud staging and provider POC are not yet verified.**

Aurix: `nadeemnahid/aurixcrm`, draft PR #26. Seldon: this fork, draft PR #1.
Aurix remains canonical for qualification, appointments, revenue and conversions.

## Implemented

- Disabled-by-default `POST /api/integrations/aurix/v1/leads`: exact-byte HMAC,
  encrypted directional keys, fixed ±300-second window, bounded body, tenant mapping,
  installation + lead identity, immutable replay receipts and stale-update protection.
- Migration 0080 adds a transactional callback outbox. Booking, suppression and
  workflow state changes enqueue callbacks in the same transaction as their source.
  Frozen raw bodies, event IDs and transport IDs survive retries and key rotation.
- Existing workflow-tick cron dispatches callbacks and starts the roofing block.
  One outstanding callback per installation preserves preference/booking ordering.
  Network retries use bounded backoff; expired delivery leases recover. Dead letters
  block later events until an operator resolves the cause. Terminal remote failures
  cannot be manually retried through the recovery action.
- Native SMS conversation runtime collects structured roofing evidence. Eligibility
  comes from configured ZIPs. Missing evidence/escalation becomes human handoff.
  The block never assigns a canonical score or writes commercial lead state.
- Existing Realtime voice runtime receives a restricted roofing evidence tool for
  an unambiguous managed caller. Generic booking tools are excluded from that call.
  A voice-first installation starts on the incoming call; simultaneous/already-running
  conversations are held. Unfinished calls eventually become visible workflow failures.
- Verified missed-call callbacks record an exact identity when resolvable; ambiguous
  shared-phone calls cause handoffs rather than guessed lead attribution.
- Managed inbound SMS bypasses native phone-matched bots. STOP cancels the run and
  persists suppression. Verified START/UNSTOP fetches the original Twilio message timestamp and validates
  its account, sender, recipient and message ID before storing consent evidence.
  Replaying an old START after a later STOP cannot clear suppression. Generic
  suppression deletion is rejected for managed phones.
- Automatic local Seldon booking requires a delivered Aurix canonical-qualified
  acknowledgement, an explicit customer-selected timestamp and a real available
  slot. A database calendar lock prevents concurrent local overlap. Booking and
  request IDs remain stable; reschedules/cancellations/completion/no-show generate
  ordered callbacks. Uncertain booking inputs go to human review.
- Owner-only configuration/health API, explicit QA activation, pause, encrypted key
  rotation/revocation and restricted dead-letter retry. Browser roles cannot directly
  access integration tables/functions. Health output excludes raw payloads/secrets.

## Configuration API

`/api/integrations/aurix/v1/installations` uses the standard v1 identity resolver,
then requires the workspace owner (shared workspace tokens and ordinary members
cannot configure signing keys). GET requires `workspace_id` and returns aggregate
lead/hold/callback counts, oldest pending age source and dead-letter error codes.

POST always requires `workspace_id`, `installation_id`, and one action:

| Action | Additional fields | Result |
|---|---|---|
| `provision` | `aurix_org_id`, `callback_url`, `key_id`, distinct `inbound_secret` and `outbound_secret` (32+ characters) | Draft installation; no activation |
| `configure` | `config.timezone`, `config.appointment_type_id`, `config.service_postal_codes`, optional `config.primary_channel` (`sms`/`voice`) | Pauses execution and invalidates prior QA |
| `activate` | `confirmation=ACTIVATE_AURIX_INTEGRATION`, `staging_passed=true`, at least two `evidence_urls` | Explicit owner QA attestation; both valid directional keys required |
| `pause` | None | Retains state and stops new execution/delivery |
| `rotate_key` | `direction`, new `key_id`, `secret` | Old keys retire after a one-hour overlap |
| `revoke_key` | `direction`, `key_id` | Immediate key revocation |
| `retry_delivery` | `event_id`, `confirmation=RETRY_AURIX_CALLBACK` | Only recoverable dead letters return to retry |

Keep credentials in a secret manager; never paste secrets into Git or logs.
These machine integration routes are intentionally separate from generic MCP tools.

## Deployment and activation gates

1. Create an isolated Seldon staging app and database with a real workspace.
2. Validate the full historical migration chain, then 0079 and 0080, including
   cloud role grants. Apply migrations before routing traffic to the updated SMS,
   voice and workflow handlers; these paths depend on the new tables.
3. Configure `ENCRYPTION_KEY`, authentication, and a nonempty `CRON_SECRET`.
   The existing workflow cron now rejects requests if its secret is missing.
4. Set `AURIX_CALLBACK_HOSTS` to the exact permitted Aurix hostname, without scheme.
   Only HTTPS `/api/integrations/seldon/v1/events` is accepted; redirects are refused.
5. Set `AURIX_INGRESS_ENABLED`, `AURIX_CALLBACKS_ENABLED`, and
   `AURIX_EXECUTION_ENABLED` to `true` only in the isolated QA environment initially.
   Flags alone do not activate installations. Configure the mapped native booking
   template/timezone, ZIP allowlist, Twilio/OpenAI credentials and controlled numbers.
6. Prove real SMS and voice callbacks, booking/calendar behavior, and the complete
   Aurix POC including canonical score 85, appointment dedupe and conversion outboxes.
   Verify the actual configured calendar provider's write/confirmation path before
   production use; a local Seldon booking row is not proof of an external calendar write.
7. Record genuine QA evidence, review final exact-SHA CI, backups and rollback plan,
   then explicitly activate one controlled production installation.

No Seldon project/database/provider credentials were supplied in this session.
No production deployment, migration or activation has been performed.

## Recovery and practical limits

- A callback timeout safely retries the exact event; a 202 pending acknowledgement
  does not release the next event. Authentication/schema/identity conflicts dead-letter.
- If Aurix processed qualification but its response was lost, a duplicate ACK may
  lack the original canonical result. Booking is held for review; it is not guessed.
- An interrupted SMS execution may already have sent through the provider. Its stale
  run becomes failed/human-held instead of blindly sending twice. Operator review
  is necessary for that uncertain external side effect.
- STOP/opt-in synchronizes identity and preference, but does not automatically restart
  a cancelled or human-held conversation. Imported lead replay cannot restart a run.
- Disabling intake does not release existing contacts to native bots. Pause the
  installation or turn off execution to stop outbound execution. Callback delivery
  has its own switch so intake and messaging can pause independently.
- SQL rollback is for disposable test databases. It preserves contacts/bookings;
  it cannot undo callbacks already processed remotely. Never delete receipts to
  force a retry in a production installation.

## Verification

The checked-in unit tests exercise HMAC, timestamp rejection, identity/replay,
consent evidence, destination restrictions, retry policy, uncertainty handoff and
native workflow-spec shape. Test-only snapshots of Aurix contracts/policy are pinned
to `a69be1bedee86fbe07b3c49698be11d9f329f9c1`; Seldon evidence passes that parser and
produces Aurix canonical score **85** for the specified POC input.

`tests/integration/aurix-database.spec.mjs` executes the actual 0079/0080 migrations
against isolated PGlite PostgreSQL with minimal prerequisite tables. It verifies
transactional callbacks, changed-body conflicts, immutable bytes, STOP/old opt-in
replay, booking request conflict, local overlap, rescheduling/cancellation, browser
permission denial, and rollback. It is **not** full historical/cloud migration or
live provider proof. CI installs pinned PGlite only in an isolated temporary prefix;
production dependencies are unchanged.

Run the dedicated `Aurix ingress qualification` workflow for focused tests,
database checks, typecheck and production build; require the full repository CI too.
