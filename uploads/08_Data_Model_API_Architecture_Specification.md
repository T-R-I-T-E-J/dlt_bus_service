# DLT Data Model & API Architecture Specification

## 1. Core Entities
- User
- StudentProfile
- Route
- Vehicle
- VehicleSeat
- Trip
- TripSeat
- Booking
- BookingPassenger
- Payment
- Refund
- BoardingPass
- BoardingEvent
- WaitlistEntry
- Review
- AuditLog
- NotificationRequest

## 2. Key Relationships
Route → Trips  
Vehicle → VehicleSeats → TripSeats  
Trip → Bookings → BookingPassengers → BoardingPasses  
Booking → Payments → Refunds  
Trip → WaitlistEntries / Reviews / BoardingEvents

## 3. Backend Authority
Backend is authoritative for seat availability, booking status, payment status, refund status, QR validity and boarding status.

## 4. Concurrency
Atomic seat allocation and unique active seat constraints are mandatory.

## 5. Idempotency
Required for payment webhooks, booking creation, refunds and boarding events.

## 6. Representative API Groups
### Auth
POST /auth/signup
POST /auth/login
POST /auth/verify-email
POST /auth/forgot-password
POST /auth/reset-password

### Trips
GET /trips
GET /trips/:id
GET /trips/:id/seats

### Booking
POST /bookings
GET /bookings/:id
PATCH /bookings/:id
POST /bookings/:id/cancel
POST /bookings/:id/passengers/:passengerId/cancel
POST /bookings/:id/seat-change

### Payments
POST /payments/create
POST /payments/webhook
GET /payments/:id
POST /payments/:id/reconcile

### Boarding
POST /boarding/scan
POST /boarding/manual
GET /trips/:id/manifest

Exact API contracts and database technology are TBD engineering decisions.
