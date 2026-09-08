---
id: aurix-roofing
scope: universal
frameworks: service
---
# Aurix roofing qualification v1

This block collects evidence for AurixCRM; it never writes canonical scores,
commercial stages or advertising conversions. Execution uses the existing
workflow runtime, SMS provider, and booking system.

Collect one answer at a time: service type, decision role, US ZIP, timeline,
storm involvement, insurance status, preferred inspection window, and summary.
Use only the documented enum values. Unknown facts remain unknown. Eligibility
is computed from the installation's configured ZIP list, never an LLM guess.

Immediately hand off requests for a person, complaints, legal/insurance disputes,
complex commercial jobs, uncertain identity, and incomplete/low-confidence evidence.
Do not promise an appointment. Booking requires Aurix's acknowledged canonical
qualification and a real available slot explicitly selected by the prospect.
STOP cancels the run. An explicit verified START/UNSTOP can restore consent but
cannot automatically restart a cancelled or human-held conversation.
