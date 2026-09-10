import { sql } from 'drizzle-orm';
import { db } from '@/db';
import { queueEvent } from './callbacks';

export async function bookAcknowledgedQualifications() {
  let booked = 0, held = 0;
  const rows = await db.execute(sql`SELECT l.installation_id,l.lead_id,l.org_id,l.workflow_run_id,i.config,o.acknowledged_result,
    o.raw_body::jsonb#>'{data,preferred_inspection_windows}' AS windows,org.slug,t.booking_slug
    FROM aurix_lead_links l JOIN aurix_installations i ON i.id=l.installation_id
    JOIN organizations org ON org.id=l.org_id
    JOIN aurix_callback_outbox o ON o.installation_id=l.installation_id AND o.source_key='qualification:'||l.workflow_run_id
    LEFT JOIN bookings t ON t.id::text=i.config->>'appointment_type_id' AND t.org_id=l.org_id AND t.status='template'
    WHERE i.status='active' AND i.config->>'execution_enabled'='true' AND l.workflow_state='completed'
      AND o.event_type='qualification.completed' AND o.status='delivered'
      AND NOT EXISTS(SELECT 1 FROM aurix_booking_links b WHERE b.installation_id=l.installation_id AND b.request_id=l.workflow_run_id::text)
      LIMIT 3`);
  for (const row of rows.rows) {
    if (typeof row.installation_id !== 'string' || typeof row.lead_id !== 'string') continue;
    try {
      const ack = row.acknowledged_result;
      const config = row.config;
      if (!ack || typeof ack !== 'object' || !('canonical_qualified' in ack) || ack.canonical_qualified !== true) throw new Error('canonical_ack_missing');
      if (!config || typeof config !== 'object' || !('appointment_type_id' in config) || typeof config.appointment_type_id !== 'string' ||
          typeof row.slug !== 'string' || typeof row.booking_slug !== 'string') throw new Error('calendar_missing');
      const start = Array.isArray(row.windows) ? row.windows[0] : null;
      if (typeof start !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(start) || !Number.isFinite(Date.parse(start)) || Date.parse(start)<=Date.now()) throw new Error('explicit_time_required');
      const { listPublicBookingSlotsAction } = await import('@/lib/bookings/actions');
      const { slots } = await listPublicBookingSlotsAction({orgSlug:row.slug,bookingSlug:row.booking_slug,date:start.slice(0,10)});
      if (!slots.some(slot => Date.parse(slot) === Date.parse(start))) throw new Error('slot_unavailable');
      await db.execute(sql`SELECT book_aurix_confirmed(${row.installation_id}::uuid,${row.lead_id}::uuid,${row.workflow_run_id},${config.appointment_type_id}::uuid,${start}::timestamptz)`);
      booked++;
    } catch {
      // Missing acknowledgement, real availability or customer-selected time must
      // never become a guessed booking. Operator sees the durable callback.
      await queueEvent(row.installation_id,row.lead_id,`booking-hold:${row.workflow_run_id}`,'handoff.requested',
        {reason:'Inspection needs human confirmation: canonical acknowledgement, selected time or availability could not be verified.'});
      await db.execute(sql`UPDATE aurix_lead_links SET workflow_state='human_hold',updated_at=now()
        WHERE installation_id=${row.installation_id}::uuid AND lead_id=${row.lead_id}::uuid`);
      held++;
    }
  }
  return {booked,held};
}
