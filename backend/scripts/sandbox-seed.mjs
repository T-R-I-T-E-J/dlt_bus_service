import { assertSandbox } from './sandbox-guard.mjs';
assertSandbox(process.env, { owner: true });
if (!process.env.SANDBOX_REVIEW_PASSWORD || process.env.SANDBOX_REVIEW_PASSWORD.length < 20) throw Error('Generate the sandbox configuration before seeding.');
const [{ default: pg }, { default: argon2 }] = await Promise.all([import('pg'), import('argon2')]);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query('BEGIN');
  if ((await client.query("SELECT id FROM routes WHERE code='DLT-SANDBOX'")).rowCount) {
    await client.query('ROLLBACK'); console.log('Sandbox fixtures already exist; nothing was overwritten.');
  } else {
    if ((await client.query('SELECT id FROM users LIMIT 1')).rowCount) throw Error('Seed requires an empty sandbox, not an existing user database.');
    const hash = await argon2.hash(process.env.SANDBOX_REVIEW_PASSWORD, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const users = {};
    for (const [key, name, role] of [['student', 'Sandbox Student', 'STUDENT'], ['ops', 'Sandbox Operations', 'SUPER_ADMIN'], ['boarding', 'Sandbox Boarding', 'BOARDING_STAFF']]) {
      const { rows: [u] } = await client.query("INSERT INTO users(email,name,phone,role,email_verified_at) VALUES($1,$2,'9876543210',$3,now()) RETURNING id", [`${key}@dlt-sandbox.invalid`, name, role]);
      users[key] = u.id;
      await client.query("INSERT INTO user_credentials(user_id,password_hash,kdf) VALUES($1,$2,'argon2id')", [u.id, hash]);
      await client.query("INSERT INTO student_profiles(user_id,student_id) VALUES($1,$2)", [u.id, 'SANDBOX' + key.toUpperCase()]);
    }
    const { rows: [route] } = await client.query("INSERT INTO routes(code,origin,destination,duration_min) VALUES('DLT-SANDBOX','Woxsen University','Miyapur Metro',120) RETURNING id");
    let firstBoarding;
    for (let i = 0; i < 4; i++) {
      const { rows: [vehicle] } = await client.query("INSERT INTO vehicles(name,registration,row_count) VALUES($1,$2,11) RETURNING id", ['Sandbox Coach ' + (i + 1), 'SANDBOX ' + (i + 1)]);
      const days = i < 2 ? 1 : 2;
      const time = i % 2 ? '17:30' : '13:00';
      const { rows: [trip] } = await client.query(`INSERT INTO trips(route_id,vehicle_id,departure_at,price,status)
        VALUES($1,$2,((((now() AT TIME ZONE 'Asia/Kolkata')::date+$3::int)+$4::time) AT TIME ZONE 'Asia/Kolkata'),320,'DRAFT') RETURNING id`, [route.id, vehicle.id, days, time]);
      await client.query('SELECT materialise_trip_seats($1)', [trip.id]);
      await client.query("UPDATE trips SET status='OPEN' WHERE id=$1", [trip.id]);
      for (let group = 0; group < 2; group++) {
        const numbers = group ? ['3A', '3B'] : ['2A', '2B'];
        for (const number of numbers) await client.query('SELECT hold_seat($1,$2,$3::uuid,NULL)', [trip.id, number, users.student]);
        const passengers = numbers.map((seatNumber, p) => ({ seatNumber, name: p ? 'Sandbox Friend' : 'Sandbox Student', studentId: p ? 'SANDBOXFRIEND' : 'SANDBOXSTUDENT', phone: '9876543210' }));
        await client.query('SAVEPOINT booking_code');
        let booking;
        for (let attempt = 0; ; attempt++) {
          try {
            booking = (await client.query('SELECT * FROM create_booking_from_holds($1,$2::uuid,NULL,$3,$4::jsonb)', [trip.id, users.student, '9876543210', JSON.stringify(passengers)])).rows[0];
            break;
          } catch (e) {
            if (e.code !== '23505' || !['bookings_code_key', 'bookings_boarding_code_key'].includes(e.constraint) || attempt >= 7) throw e;
            await client.query('ROLLBACK TO SAVEPOINT booking_code');
          }
        }
        await client.query('RELEASE SAVEPOINT booking_code');
        const { rows: [payment] } = await client.query("INSERT INTO payments(booking_id,amount,status,provider,provider_payment_id) VALUES($1,640,'SUCCESS','RAZORPAY',$2) RETURNING id", [booking.id, `SANDBOX_SIMULATED_${i}_${group}`]);
        await client.query('SELECT settle_booking($1,$2)', [booking.id, payment.id]);
      }
      if (i < 2) {
        await client.query("UPDATE trips SET status='BOOKING_CLOSED' WHERE id=$1", [trip.id]);
        await client.query("UPDATE trips SET status='BOARDING' WHERE id=$1", [trip.id]);
        if (!firstBoarding) firstBoarding = trip.id;
      }
    }
    await client.query('INSERT INTO trip_staff(trip_id,user_id,assigned_by) VALUES($1,$2,$3)', [firstBoarding, users.boarding, users.ops]);
    await client.query('COMMIT');
    console.log('Seeded 3 synthetic accounts, four 44-passenger coaches and 8 sample bookings. Simulated payment records only.');
  }
} catch (e) { await client.query('ROLLBACK'); throw e; }
finally { await client.end(); }
