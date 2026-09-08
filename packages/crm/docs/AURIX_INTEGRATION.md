# AurixCRM ingress — implementation and release state

Status: **NOT ACTIVATED. Not an end-to-end release.**

Aurix repository: `nadeemnahid/aurixcrm`, draft PR #26. This fork owns the
Seldon side. Aurix remains canonical for qualification, appointments, revenue
and advertising conversions.

## Implemented in this branch

- `POST /api/integrations/aurix/v1/leads`, disabled unless
  `AURIX_INGRESS_ENABLED=true`.
- Directional HMAC-SHA256 over exact raw body bytes; fixed +/-300 second window.
- Header validation before database access; 128 KiB streamed request limit.
- Encrypted key storage through the existing AES-256-GCM encryption utility.
  Active/retiring/revoked keys and validity periods are enforced on ingress.
- Transactional identity and replay receipt creation in `accept_aurix_lead`.
- Identity is installation + Aurix lead ID. Shared phone/email leads remain
  distinct. Email and attribution remain in integration context, avoiding
  native email-based contact merging. Existing contact score/status are untouched.
- Exact-message retries return the saved acknowledgement. Changed bytes conflict.
- Older source updates cannot overwrite newer lead context.
- Existing SMS suppression is read, never cleared by lead synchronization.
- Managed inbound SMS is persisted for human review and never enters native
  phone-based bot routing. Ambiguous identities have no guessed contact ID.
- When this integration flag is on, Twilio webhook verification cannot silently
  fall back to accepting unsigned requests when provider credentials are absent.
- Migration 0079 is journaled, with an isolated-test rollback script.

## Deliberately held

All imported leads remain `hold_for_qa`, `hold_for_consent`, or `human_hold`.
No roofing workflow starts. A successful ingress response proves identity/data
acceptance only. It must not be presented as qualification or appointment success.

## Still required before release

1. Provision an isolated Seldon application and database under the owner's account.
2. Validate the full historical migration chain plus 0079 and role grants on that
   database. Local minimal-schema PGlite tests do not prove full migration history.
3. Complete the roofing BLOCK/workflow execution adapter and structured evidence.
4. Implement and wire the durable signed Seldon callback outbox, retry recovery,
   booking lifecycle and consent-event hooks. No callback delivery exists in this slice.
5. Complete audited explicit opt-in handling and STOP callbacks to Aurix.
6. Run the cross-system POC against Aurix PR #26 with score 85, booking dedupe,
   reschedule, changed-body replay, STOP/opt-in and downstream conversion evidence.
7. Audit/validate operational visibility, failure recovery and activation gates.

The connected Vercel account had no Seldon project when inspected. No deployment
or database credentials were supplied. No production migrations were executed.

## Provisioning requirements

- A staging `DATABASE_URL` and the repository's established Neon HTTP proxy if
  using ordinary Postgres instead of Neon.
- Seldon's `ENCRYPTION_KEY` and authentication configuration.
- A real Seldon organization/workspace UUID.
- The Aurix installation UUID and Aurix organization UUID.
- Distinct inbound and outbound random secrets, exchanged through a secret manager.
  Seldon inbound must equal Aurix outbound; Seldon outbound must equal Aurix inbound.
- A future controlled SMS/voice provider and calendar configuration before automated
  communication. Do not use real prospects for initial validation.

Create installation rows in `draft`. The integration flag alone does not activate
an installation. Do not change rows to active until the missing release gates pass.

## Tests and limits

The new unit suite covers signatures/header rejection, clock skew, request limits,
contract mismatch, replay, identity and consent evidence. Local PGlite validation
used minimal prerequisite tables to exercise migration 0079, atomic replay/conflict,
shared-phone identities, STOP preservation, stale source updates, pause behavior,
browser-role key/function denial and rollback preserving contacts.

Neither mock-store tests nor minimal-schema database tests establish production
end-to-end behavior. Full Seldon CI and build results must be inspected separately.

## Pause and rollback

Apply migration 0079 before deploying the updated Twilio route. Managed-contact
SMS holds remain enforced even when ingress is disabled.

Disable `AURIX_INGRESS_ENABLED` to reject ingress without deleting state. Pause the
installation to reject new transactional acceptance. Preserve inbox/link rows for
diagnosis. Never delete replay rows to force a retry. The rollback removes integration
state while preserving native contacts; it is only for disposable test databases
unless an explicit production data migration plan has been reviewed.
