import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window ||= {};
const { DLT } = await import('../dlt-client.js');
const trip = { id: 'trip', departureAt: '2027-02-01T08:00:00Z', reportingAt: '2027-02-01T07:30:00Z', status: 'OPEN' };
const bookings = ['first','second'].map((id,i)=>({ id, code: `DLT-${i+1}`, status:'CONFIRMED', trip,
  unitPrice:320,totalAmount:640,payment:{status:'SUCCESS'},refunds:[],
  passengers:[{name:'Same Student',studentId:'SAME001',seatNumber:`${i+2}A`},{name:'Same Friend',studentId:'SAME002',seatNumber:`${i+2}B`}] }));
const passesFor = id => bookings.find(b=>b.id===id).passengers.map(p=>({...p,bookingCode:bookings.find(b=>b.id===id).code,qrToken:`demo-${id}-${p.seatNumber}`,fareShare:320,total:640,passStatus:'VALID',paymentStatus:'SUCCESS',departureAt:trip.departureAt,reportingAt:trip.reportingAt}));
function page(fetchPasses) {
  const source=readFileSync(new URL('../DLT Dashboard.dc.html',import.meta.url),'utf8').match(/<script[^>]*data-dc-script[^>]*>([\s\S]*?)<\/script>/)[1];
  class Logic {setState(update,done){Object.assign(this.state,typeof update==='function'?update(this.state):update);done?.();}}
  const api={...DLT,auth:{current:()=>({name:'Same Student',role:'STUDENT'})},boarding:{passesFor:fetchPasses}};
  const instance=new (new Function('DCLogic','DLT','window',source+'\nreturn Component;')(Logic,api,{DLT:api}))();
  Object.assign(instance.state,{ready:true,loading:false,activeBookingId:'first'});
  instance.state.data.bookings=bookings;
  return instance;
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('choosing the second booking fetches its tickets even when passenger names and IDs repeat',async()=>{
  const calls=[];
  const p=page(async id=>{calls.push(id);return passesFor(id);});
  await p._loadPasses();
  p.renderVals().rows[1].onAction();
  await settle();
  assert.deepEqual(calls,['first','second']);
  assert.deepEqual(p._passes().map(x=>x.seatNumber),['3A','3B']);
  assert.equal(p.renderVals().paxSeat,'3A');
  p.renderVals().passengers[1].onPick();
  assert.equal(p.renderVals().paxSeat,'3B');
});

test('a late ticket response for the first booking cannot replace tickets from the second',async()=>{
  const pending={};
  const p=page(id=>new Promise(resolve=>{pending[id]=resolve;}));
  const old=p._loadPasses();
  p.state.activeBookingId='second';
  const current=p._loadPasses();
  pending.second(passesFor('second'));await current;
  pending.first(passesFor('first'));await old;
  assert.deepEqual(p._passes().map(x=>x.seatNumber),['3A','3B']);
});

test('old tickets are hidden as soon as another booking is selected',async()=>{
  const p=page(async id=>passesFor(id));
  await p._loadPasses();
  p.state.activeBookingId='second';
  assert.deepEqual(p._passes(),[]);
});

test('a booking-code deep link resolves that booking rather than falling back to the first',()=>{
  const p=page(async id=>passesFor(id));
  p.state.activeBookingId='DLT-2';
  assert.equal(p._activeBooking().id,'second');
});

test('ticket loading errors remain visible and can be retried',async()=>{
  let fail=true;
  const p=page(async id=>{if(fail)throw new Error('temporary');return passesFor(id);});
  await p._loadPasses();
  assert.match(p.renderVals().passClosedCopy,/couldn.t load/i);
  assert.equal(p.renderVals().canOpenPass,true);
  fail=false;p.renderVals().openPass();await settle();
  assert.equal(p._passes().length,2);
});

test('an old cancellation quote cannot move to another selected booking',async()=>{
 const pending={};
 // The same booking context is shared by ticket, receipt and cancellation views.
 const source=readFileSync(new URL('../DLT Dashboard.dc.html',import.meta.url),'utf8').match(/<script[^>]*data-dc-script[^>]*>([\s\S]*?)<\/script>/)[1];
 class Logic{setState(update,done){Object.assign(this.state,typeof update==='function'?update(this.state):update);done?.();}}
 const api={...DLT,auth:{current:()=>({name:'Same Student',role:'STUDENT'})},bookings:{cancellationQuote:id=>new Promise(r=>pending[id]=r)}};
 const Page=new Function('DCLogic','DLT','window',source+'\nreturn Component;')(Logic,api,{DLT:api});
 const view=new Page();Object.assign(view.state,{ready:true,activeBookingId:'first',cancelOpen:true});view.state.data.bookings=bookings;
 const a=view._loadQuote();view.state.activeBookingId='second';const b=view._loadQuote();
 pending.second({amount:640});await b;pending.first({amount:320});await a;
 assert.equal(view.state.data.quote.amount,640);
});

test('the next-trip receipt and cancel controls target that trip even after viewing another booking',async()=>{
 const p=page(async id=>passesFor(id));p.state.activeBookingId='second';
 p.renderVals().openUpcomingReceipt();await settle();assert.equal(p._activeBooking().id,'first');
 p.state.activeBookingId='second';p._loadQuote=async()=>{};
 p.renderVals().openUpcomingCancel();assert.equal(p._activeBooking().id,'first');
});
