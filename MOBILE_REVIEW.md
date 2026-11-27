# Phone layout review

This update is for local review first. Do not deploy it directly to production. The agreed next stage is an isolated VPS sandbox after the user's review.

## Changes

- Shared phone styles across Home, Booking, My Trips, Account, Operations and Policies. Primary controls are at least 48 px high, phone form text is 16 px, and narrow form grids become one column.
- Bottom navigation for student pages, with safe-area padding. Booking retains its persistent total and primary action. The bus diagram has larger targets and a compact legend.
- The boarding pass clearly says open seating is first come, first served. Its number is labelled as a seat reference. The same notice is drawn into the downloaded PNG; print also includes the notice.
- A booking selector sits above the boarding pass, showing booking codes and departure times. The selected departure is prominent above the QR. Phone QR display is 220 px, with Download and Print controls immediately below it.
- Next trip follows the earliest departure, and prefers a confirmed booking over an unpaid retry for the same departure. Home resolves route details from the public departure instead of displaying missing fields. Departures already boarding show Booking closed.
- Operations retains its role permissions, masked boarding-staff contacts, server-validated scanner and call links. Phone actions are larger; no payment, capacity or boarding authority moved into the browser.

## Validation

62 frontend tests passed. A prepared frontend release includes dlt-mobile.css. Browser checks covered ticket layouts at 320, 360, 390, 430, 768 and 1440 px; Home, Account, Booking and Policies at five widths; and all 13 operations sections at 320, 390 and 768 px. These checks found no horizontal page overflow. Some operations sections contain only empty states in the synthetic review database.

The local booking flow was exercised at 320 px through passenger details and the review showing ₹299 excluding tax + ₹21 GST = ₹320. No provider payment was attempted. Signup layout was checked at 320 px without submitting an account. Selecting another confirmed booking produced the matching downloaded ticket; the actual downloaded PNG QR was decoded with the scanner library and matched that passenger's local database token.

These are desktop browser viewport checks, not physical iOS/Android camera or software-keyboard certification. Production remains unchanged. The CI result for the previous booking/scanner release does not certify this new local patch.
