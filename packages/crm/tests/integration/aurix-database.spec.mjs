import test from 'node:test';
import { parseSeldonEvent, parseBookingEventData } from '../fixtures/aurix/contracts.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
const { PGlite } = createRequire(resolve(process.env.AURIX_TEST_DB_ROOT || '/tmp/sf-validation', 'package.json'))('@electric-sql/pglite');
const org = '00000000-0000-4000-8000-000000000001', install = '00000000-0000-4000-8000-000000000002', lead = '00000000-0000-4000-8000-000000000003';
const template = '00000000-0000-4000-8000-000000000004';
const migration = (name) => readFileSync(resolve('drizzle', name), 'utf8');
test('actual SQL: callbacks, STOP replay, booking identity/lifecycle, role denial and rollback', async () => {
    const db = new PGlite();
    try {
        await db.exec(`CREATE TABLE organizations(id uuid PRIMARY KEY,slug text);
 CREATE TABLE contacts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid REFERENCES organizations(id),first_name text,last_name text,phone text,email text,source text,updated_at timestamptz DEFAULT now());
 CREATE TABLE suppression_list(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid,channel text,phone text,reason text,created_at timestamptz DEFAULT now());
 CREATE TABLE workflow_runs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid,archetype_id text,spec_snapshot jsonb,trigger_payload jsonb,current_step_id text,variable_scope jsonb,status text DEFAULT 'running',updated_at timestamptz DEFAULT now());
 CREATE TABLE bookings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid,contact_id uuid,title text,booking_slug text,status text,starts_at timestamptz,ends_at timestamptz,provider text,metadata jsonb DEFAULT '{}',external_event_id text);
 CREATE TABLE sms_messages(org_id uuid,provider text,external_message_id text,direction text,metadata jsonb);`);
        await db.exec(migration('0079_aurix_ingress.sql'));
        await db.exec(migration('0080_aurix_execution.sql'));
        await db.query('INSERT INTO organizations(id) VALUES($1)', [org]);
        await db.query("INSERT INTO aurix_installations(id,org_id,aurix_org_id,status,config) VALUES($1,$2,$2,'active',$3)", [install, org, JSON.stringify({ timezone: 'America/Chicago', appointment_type_id: template, service_postal_codes: ['75230'], execution_enabled: true })]);
        const raw = JSON.stringify({ lead: { consent: { sms_status: 'allowed' } } });
        const accept = async (msg) => db.query('SELECT accept_aurix_lead($1,$2,$3,$4,$5,$6,$7,NULL,now(),true) AS response', [install, msg, 'hash', raw, lead, '+12025550123', 'Test']);
        const contact = (await accept('one')).rows[0].response.contact_id;
        const event = async (source, data = { reason: 'human' }) => db.query('SELECT enqueue_aurix_event($1,$2,$3,$4,$5)', [install, lead, source, 'handoff.requested', JSON.stringify(data)]);
        await event('one');
        await event('one');
        assert.equal((await db.query('SELECT count(*)::int n FROM aurix_callback_outbox')).rows[0].n, 1);
        await assert.rejects(() => event('one', { reason: 'changed' }), /aurix_event_body_conflict/);
        await assert.rejects(() => db.exec("UPDATE aurix_callback_outbox SET raw_body='{}'"), /aurix_callback_immutable/);
        const start = await db.query('SELECT start_aurix_workflow($1,$2,$3) id', [install, lead, '{"steps":[]}']);
        const run = start.rows[0].id;
        assert.ok(run);
        assert.equal((await db.query('SELECT start_aurix_workflow($1,$2,$3) id', [install, lead, '{}'])).rows[0].id, null);
        await db.query("INSERT INTO suppression_list(org_id,phone,channel,reason) VALUES($1,'+12025550123','sms','stop_keyword')", [org]);
        await accept('replay-after-stop');
        assert.equal((await db.query('SELECT status FROM workflow_runs WHERE id=$1', [run])).rows[0].status, 'cancelled');
        await assert.rejects(() => db.exec('DELETE FROM suppression_list'), /aurix_explicit_consent_required/);
        await assert.rejects(() => db.query('SELECT aurix_explicit_opt_in($1,$2,$3,$4)', [org, 'bad', '+12025550123', JSON.stringify({ status: 'allowed', explicit: false, captured_at: new Date().toISOString(), source: 'test' })]), /aurix_consent_invalid/);
        const evidence = { status: 'allowed', explicit: true, captured_at: new Date().toISOString(), source: 'twilio_verified_start' };
        await db.query('SELECT aurix_explicit_opt_in($1,$2,$3,$4)', [org, 'start-1', '+12025550123', JSON.stringify(evidence)]);
        await db.query("INSERT INTO suppression_list(org_id,phone,channel,reason) VALUES($1,'+12025550123','sms','stop_keyword')", [org]);
        await db.query('SELECT aurix_explicit_opt_in($1,$2,$3,$4)', [org, 'start-1', '+12025550123', JSON.stringify(evidence)]);
        assert.equal((await db.query('SELECT count(*)::int n FROM suppression_list')).rows[0].n, 1);
        // Bookings derive exact contact identity; retries never create a second request mapping.
        await db.query("INSERT INTO bookings(id,org_id,title,booking_slug,status,metadata) VALUES($1,$2,'Inspection','roof','template','{\"durationMinutes\":30}')", [template, org]);
        const book = async (id, request, start = '2027-01-01T15:00:00Z') => db.query("INSERT INTO bookings(id,org_id,contact_id,title,booking_slug,status,starts_at,ends_at,metadata) VALUES($1,$2,$3,'Inspection','roof','scheduled',$4,$4::timestamptz+interval '30 minutes',$5)", [id, org, contact, start, JSON.stringify({ aurix_booking_request_id: request })]);
        const booking = '00000000-0000-4000-8000-000000000005';
        await book(booking, 'request-1');
        await assert.rejects(() => book('00000000-0000-4000-8000-000000000006', 'request-1', '2027-01-02T15:00:00Z'), /unique constraint/);
        await assert.rejects(() => book('00000000-0000-4000-8000-000000000007', 'request-2'), /aurix_calendar_slot_conflict/);
        await db.query("UPDATE bookings SET starts_at='2027-01-03T15:00:00Z',ends_at='2027-01-03T15:30:00Z' WHERE id=$1", [booking]);
        await db.query("UPDATE bookings SET status='cancelled' WHERE id=$1", [booking]);
        const types = await db.query("SELECT event_type FROM aurix_callback_outbox WHERE event_type LIKE 'booking.%' ORDER BY id");
        assert.deepEqual(types.rows.map(r => r.event_type), ['booking.created', 'booking.rescheduled', 'booking.cancelled']);
        await assert.rejects(() => db.query("UPDATE bookings SET status='scheduled' WHERE id=$1", [booking]), /aurix_booking_terminal/);
        await db.exec('CREATE ROLE browser; GRANT USAGE ON SCHEMA public TO browser; SET ROLE browser;');
        await assert.rejects(() => db.exec('SELECT * FROM aurix_callback_outbox'), /permission denied/);
        await assert.rejects(() => event('browser'), /permission denied/);
        await db.exec('RESET ROLE');
        const queued = await db.query('SELECT raw_body FROM aurix_callback_outbox ORDER BY id');
        for (const row of queued.rows) {
          const envelope=parseSeldonEvent(JSON.parse(row.raw_body));
          assert.equal(envelope.organization_id,org);assert.equal(envelope.workspace_id,org);
          if (envelope.event_type.startsWith('booking.')) parseBookingEventData(envelope.data,['booking.created','booking.rescheduled'].includes(envelope.event_type));
        }

        await db.exec(migration('rollbacks/0080_aurix_execution.sql'));
        await db.exec(migration('rollbacks/0079_aurix_ingress.sql'));
        assert.equal((await db.query('SELECT count(*)::int n FROM contacts')).rows[0].n, 1);
    }
    finally {
        await db.close();
    }
});
