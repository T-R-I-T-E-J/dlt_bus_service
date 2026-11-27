# Booking and boarding safety release

This release keeps the bus diagram and the existing ticket format. The booking layout explains that the diagram represents booking capacity, physical seats are not assigned, and passengers sit anywhere on a first-come, first-served basis. Capacity remains 44 for the verified 44-passenger coach; changing the seating explanation does not add bookable places.

## Corrections

- Booking reads, seat polling and hold responses cannot replace the currently selected departure with an older response. A pending checkout cannot open after its departure changes.
- Dates and times use Asia/Kolkata throughout the shared client. Operations creates departures and report date ranges in IST, independent of the operator's device timezone. Tickets identify IST.
- Operations must select a departure before scanning or manually changing boarding status. The HTTP routes preserve that scope for manual boarding, denial and no-show. Boarding-only accounts still derive their departure from their server-side assignment.
- A ticket or group boarding code for a different departure is refused. The scanner explains both departures in IST. It does not transfer a ticket or admit the passenger to a different bus.
- Navigation cleanup uses an unpaid-only endpoint. The server locks the booking and refuses to cancel a confirmed or paid booking through that endpoint. Explicit cancellation in My Trips retains the existing policy.
- A random human-readable booking/boarding-code collision retries the rolled-back creation transaction. Actual seat ownership conflicts are not retried as code collisions. Retries are bounded and exhaustion returns a conflict.

## Validation and limits

The regression tests use disposable local PostgreSQL databases, synthetic users and simulated successful payment records. They cover wrong-departure QR/group-code/manual actions, repeat scans, paid-booking cleanup protection, separate tickets for repeat bookings, device timezone differences and 200 competitors for 44 distinct places. The local HTTP burst exercise covers 100/200 seat-map readers, 200 contenders for one place, 200 duplicate booking clicks, 200 legitimate logins and 100 scans of one pass.

These tests do not reproduce the reported customer's historical 1 pm / 5:30 pm incident: no booking reference or date was available. They do not certify production VPS capacity or physical-camera performance under all lighting conditions. No real payment, passenger boarding or live data correction was performed for testing.

## Deploy

Wait for DLT CI to pass for the exact branch commit. Choose a quiet moment outside active checkout because replacing the single API container can briefly interrupt requests.

```bash
cd /opt/dlt-frontend &&
git pull --ff-only &&
bash deploy/vps/update-main.sh
```

Use the full release script: this patch changes API and frontend. It checks CI, preserves the previous API image, performs production preflight, backs up the database and activates with health checks and rollback. There are no schema migrations or credential changes in this release. See CI_DEPLOYMENT.md.

After deployment, check readiness and the booking notice, then use existing verified bookings for read-only ticket inspection. Confirm staff have the correct departure assignment. A passenger with a ticket for another departure needs an authorised booking change; staff should not bypass the scanner or add them beyond capacity.
