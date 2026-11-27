import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {Server} from 'node:http';
import pg from 'pg';
import {createApp} from '../src/app.ts';
import {close} from '../src/db/index.ts';
import {resetTables} from './_reset.ts';
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:10});
const q=(sql:string,args:unknown[]=[])=>pool.query(sql,args);
let server:Server,base:string,tripA:string,tripB:string,passenger:string,token:string;
const session='local-boarding-http-context-test';
before(()=>{server=createApp().app.listen(0);base='http://127.0.0.1:'+(server.address() as any).port;});
after(async()=>{await new Promise<void>(r=>server.close(()=>r()));await pool.end();await close();});
beforeEach(async()=>{
 await resetTables(pool,'users,routes,vehicles,trips,bookings,booking_passengers,payments,boarding_passes,boarding_events,trip_staff,audit_logs,sessions');
 const operator=(await q("INSERT INTO users(email,name,role,phone,email_verified_at) VALUES('ops-context@example.invalid','Desk Operator','OPS_ADMIN','9876543210',now()) RETURNING id")).rows[0].id;
 const student=(await q("INSERT INTO users(email,name,role,phone) VALUES('student-context@example.invalid','Same Student','STUDENT','9876543210') RETURNING id")).rows[0].id;
 await q("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 day')",[operator,createHash('sha256').update(session).digest('hex')]);
 const route=(await q("INSERT INTO routes(code,origin,destination,duration_min) VALUES('CTX','Woxsen','Miyapur',120) RETURNING id")).rows[0].id;
 const vehicle=(await q("INSERT INTO vehicles(name,registration,row_count) VALUES('Context Coach','LOCAL CTX',11) RETURNING id")).rows[0].id;
 const c=await pool.connect();
 try{
  await c.query('BEGIN');await c.query('SET LOCAL session_replication_role=replica');
  for(const [label,hour] of [['A','07:30'],['B','12:00']]){
   const trip=(await c.query("INSERT INTO trips(route_id,vehicle_id,departure_at,price,status) VALUES($1,$2,(date_trunc('day',now()+interval '2 days')::date+$3::time) AT TIME ZONE 'UTC',320,'DRAFT') RETURNING id",[route,vehicle,hour])).rows[0].id;
   await c.query('SELECT materialise_trip_seats($1)',[trip]);
   const b=(await c.query("INSERT INTO bookings(code,boarding_code,trip_id,user_id,status,kind,unit_price,total_amount,contact_phone) VALUES($1,$2,$3,$4,'CONFIRMED','ONLINE',320,640,'9876543210') RETURNING id",['DLT-CTX-'+label,'CTX'+label,trip,student])).rows[0].id;
   await c.query("INSERT INTO payments(booking_id,amount,status,provider,provider_payment_id) VALUES($1,640,'SUCCESS','RAZORPAY',$2)",[b,'pay_ctx_'+label]);
   for(const seat of ['2A','2B']){
    const ts=(await c.query("UPDATE trip_seats SET status='BOOKED',booking_id=$1 WHERE trip_id=$2 AND seat_number=$3 RETURNING id",[b,trip,seat])).rows[0].id;
    const p=(await c.query("INSERT INTO booking_passengers(booking_id,trip_seat_id,name,student_id,seat_number,seat_type) VALUES($1,$2,'Same Student','SAME001',$3,'WINDOW') RETURNING id",[b,ts,seat])).rows[0].id;
    const qr='dlt.ctx-'+label+'-'+seat;await c.query('INSERT INTO boarding_passes(passenger_id,booking_id,trip_id,qr_token) VALUES($1,$2,$3,$4)',[p,b,trip,qr]);
    if(label==='B'&&seat==='2A'){passenger=p;token=qr;}
   }
   await c.query("UPDATE trips SET status='BOARDING' WHERE id=$1",[trip]);
   if(label==='A')tripA=trip;else tripB=trip;
  }
  await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
});
async function post(path:string,body:any){
 const r=await fetch(base+'/api'+path,{method:'POST',headers:{'content-type':'application/json',cookie:'dlt_session='+session},body:JSON.stringify(body)});
 return {status:r.status,body:await r.json() as any};
}
async function status(){return (await q('SELECT boarding_status FROM booking_passengers WHERE id=$1',[passenger])).rows[0].boarding_status;}
test('a 5:30 pm QR cannot board the 1 pm departure over HTTP',async()=>{
 const r=await post('/boarding/scan',{code:token,tripId:tripA});
 assert.equal(r.status,200);assert.equal(r.body.result,'INVALID');assert.match(r.body.detail,/IST/);assert.match(r.body.detail,/5:30/i);assert.match(r.body.detail,/1:00/i);assert.equal(await status(),'NOT_BOARDED');
});
test('a multi-passenger typed code is refused on the wrong departure before choosing a person',async()=>{
 const r=await post('/boarding/scan',{code:'CTXB',tripId:tripA});assert.equal(r.body.result,'INVALID');assert.equal(await status(),'NOT_BOARDED');
});
for(const action of ['manual','deny','no-show'])test(`HTTP ${action} preserves the selected departure constraint`,async()=>{
 const r=await post(`/boarding/passengers/${passenger}/${action}`,{reason:'Checked against selected departure',tripId:tripA});
 assert.equal(r.status,409);assert.match(r.body.error.message,/not on the departure/i);assert.equal(await status(),'NOT_BOARDED');
});
test('operations must choose a departure for scans and manual actions',async()=>{
 assert.equal((await post('/boarding/scan',{code:token})).status,400);
 assert.equal((await post(`/boarding/passengers/${passenger}/manual`,{reason:'No selected departure'})).status,400);
 assert.equal(await status(),'NOT_BOARDED');
});
test('50 simultaneous scans admit a matching ticket once and preserve its departure',async()=>{
 const results=await Promise.all(Array.from({length:50},()=>post('/boarding/scan',{code:token,tripId:tripB})));
 assert.ok(results.every(r=>r.status===200));assert.equal(results.filter(r=>r.body.result==='VALID').length,1);
 assert.equal(results.filter(r=>r.body.result==='ALREADY BOARDED').length,49);
 assert.equal(results.find(r=>r.body.result==='VALID')!.body.trip.id,tripB);assert.equal(await status(),'BOARDED');
});

test('unpaid navigation cleanup cannot cancel an already confirmed ticket',async()=>{
 const b=(await q('SELECT booking_id FROM booking_passengers WHERE id=$1',[passenger])).rows[0].booking_id;
 const r=await post(`/bookings/${b}/discard`,{});
 assert.equal(r.status,409);
 assert.equal((await q('SELECT status FROM bookings WHERE id=$1',[b])).rows[0].status,'CONFIRMED');
 assert.equal((await q('SELECT count(*)::int n FROM refunds WHERE booking_id=$1',[b])).rows[0].n,0);
});
