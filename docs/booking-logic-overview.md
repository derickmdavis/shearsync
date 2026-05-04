# Booking Logic Overview

This document is a one-page product and engineering reference for how booking currently works in ShearSync API.

## Purpose

There are two booking flows:

- Internal booking inside the authenticated app
- External/public booking from the booking page

These flows intentionally behave differently.

## Flow Summary

| Area | Internal App Booking | External/Public Booking |
| --- | --- | --- |
| Auth required | Yes | No |
| Uses saved availability windows | No | Yes |
| Uses lead time rules | No | Yes |
| Uses same-day booking rules | No | Yes |
| Uses max booking window | No | Yes |
| Uses new-client approval | No | Yes |
| Uses new-client service restrictions | No | Yes |
| Uses new-client booking window | No | Yes |
| Overlap protection | Yes | Yes |
| Final authority | Backend | Backend |

## Internal Booking Logic

Internal booking uses authenticated appointment creation and defaults `booking_source` to `internal`.

### What internal booking enforces

- authenticated user ownership
- valid owned client reference
- no overlap with existing non-cancelled appointments

### What internal booking ignores

- weekly availability windows
- lead time
- same-day booking restrictions
- public booking window restrictions
- new-client approval rules
- new-client restricted services
- new-client booking window rules

### Internal slot suggestions

`GET /api/appointments/internal-context` generates suggested internal slots.

Current behavior:

- generates 15-minute slot starts across the full day
- filters only by overlap with existing appointments
- does not use weekly availability windows
- does not use public booking rules

### Product meaning

Staff can place appointments almost anywhere, as long as they do not overlap another appointment.

## Public Booking Logic

Public booking uses intake, client-aware service/slot loading, and the final public booking create endpoint.

### Public slot generation

The public booking page should first run booking intake, then request services and slots with the returned booking context token.

Current behavior:

- requires online booking to be enabled
- requires the selected service to be active
- accepts a short-lived booking context token from intake
- defaults to new-client rules when no booking context token is supplied
- loads weekly availability windows for the target day
- generates 15-minute slot starts inside those windows
- removes slots that violate public booking rules
- removes slots that overlap existing appointments

### Final public booking creation

When a guest submits a booking, the backend validates again before creating the appointment.

Current behavior:

- stylist must allow online booking
- service must be active
- requested time must be in the future
- requested time must satisfy public booking rules
- requested time must still fit public availability
- requested time must still not overlap an existing appointment

The created appointment status is:

- `scheduled` when approval is not required
- `pending` when first-time client approval is required

## Booking Rules Users Can Set

These rules are stored in booking rules settings and affect public booking unless noted otherwise.

| Rule | Meaning | Internal booking | Public booking |
| --- | --- | --- | --- |
| `leadTimeHours` | Minimum notice required before booking | Ignored | Enforced |
| `sameDayBookingAllowed` | Whether a client can book for today | Ignored | Enforced |
| `sameDayBookingCutoff` | Latest local time for same-day booking | Ignored | Enforced |
| `maxBookingWindowDays` | Furthest future date allowed for any public booking | Ignored | Enforced |
| `newClientApprovalRequired` | First-time clients book as `pending` instead of `scheduled` | Ignored | Enforced |
| `newClientBookingWindowDays` | Future-day limit for first-time clients only | Ignored | Enforced |
| `restrictServicesForNewClients` | Turns on restricted services for first-time clients | Ignored | Enforced |
| `restrictedServiceIds` | Services first-time clients cannot book online | Ignored | Enforced |

## Meaning of `newClientBookingWindowDays`

- `> 0`: first-time clients can only book that many days ahead
- `0`: no new-client booking-window restriction

This rule applies only to first-time public clients.

## Returning Client vs New Client Behavior

The public flow attempts to determine whether the guest is already a client using normalized phone and email matching.

### Returning client

- new-client approval does not apply
- new-client service restrictions do not apply
- new-client booking window does not apply

### First-time client

- may require approval
- may be blocked from restricted services
- may have a tighter booking window

Internal booking ignores this distinction.

## Weekly Availability Rules

Weekly availability is the source of truth for public bookable hours.

Current behavior:

- each day can be open or closed
- open days contain one or more time windows
- windows cannot overlap
- public slots are generated only inside active windows
- slot duration comes from the selected service

Internal booking does not use these windows.

## Current Risks And Gaps

### 1. Internal booking can place appointments outside normal working hours

This is intentional, but it means staff can create off-hours bookings unless the UI makes that clear.

### 2. Public services and slots depend on intake context

Product impact:

- when the frontend passes the intake token, returning clients get returning-client service and slot behavior
- when the frontend skips intake or omits the token, the backend intentionally falls back to new-client filtering

### 3. Overlap protection is enforced in service logic, not by a full DB time-range exclusion rule

Normal overlap checking works, but concurrent write protection is weaker than a true database non-overlap constraint.

### 4. Cancellation, reschedule, and late-fee settings are stored but not part of booking creation rules

These settings exist in configuration, but they do not currently drive this booking flow.

### 5. No holiday or one-off blackout model is visible in current booking logic

Public booking uses weekly availability plus appointment conflicts. Temporary closures or special exceptions do not appear to be modeled here.

### 6. Internal slot suggestions only account for appointment conflicts

If the product later adds room, staff, or resource constraints, internal context will need to expand.

## Engineering Reference

Main code areas:

- internal booking and overlap checks: [src/services/appointmentsService.ts](/Users/derick/shearsync-api/src/services/appointmentsService.ts:57)
- public booking validation: [src/services/publicBookingsService.ts](/Users/derick/shearsync-api/src/services/publicBookingsService.ts:93)
- public slot generation and weekly availability: [src/services/availabilityService.ts](/Users/derick/shearsync-api/src/services/availabilityService.ts:1)
- booking rules load/update behavior: [src/services/bookingRulesService.ts](/Users/derick/shearsync-api/src/services/bookingRulesService.ts:155)
- booking rules validation contract: [src/validators/settingsValidators.ts](/Users/derick/shearsync-api/src/validators/settingsValidators.ts:29)

## Recommended Shared Product Language

- "Internal booking ignores public booking rules and only blocks conflicts."
- "Public booking follows availability, timing, and new-client rules."
- "Approval required only affects first-time public clients."
- "`newClientBookingWindowDays = 0` means no first-time-client window restriction."
