import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
function booking(api){
 const source=readFileSync(new URL('../DLT Booking.dc.html',import.meta.url),'utf8').match(/<script[^>]*data-dc-script[^>]*>([\s\S]*?)<\/script>/)[1];
 class Logic{setState(p,done){Object.assign(this.state,typeof p==='function'?p(this.state):p);done?.();}}
 const Page=new Function('DCLogic','DLT','window',source+'\nreturn Component;')(Logic,api,{DLT:api});return new Page();
}
test('a slow departure response cannot replace the trip selected more recently',async()=>{
 const pending={};const p=booking({auth:{current:()=>null},trips:{listPublic:async()=>[],get:id=>new Promise(r=>pending[id]=r),seatMap:async id=>({rows:[id],held:[{seatNumber:id}]})}});
 p.state.tripId='1pm';const first=p._load();p.state.tripId='530pm';const second=p._load();
 pending['530pm']({id:'530pm'});await second;pending['1pm']({id:'1pm'});await first;
 assert.equal(p.state.data.trip.id,'530pm');assert.deepEqual(p.state.data.seatRows,['530pm']);
});
test('an old seat poll cannot attach seats from another departure to the current trip',async()=>{
 let tick,resolve;
 const p=booking({startPolling:fn=>{tick=fn;},trips:{seatMap:()=>new Promise(r=>resolve=r)}});
 p.state.tripId='1pm';p._watchSeats(true);const pending=tick();p.state.tripId='530pm';p.state.data.held=[];
 resolve({rows:['old'],held:[{seatNumber:'2A'}]});await pending;
 assert.deepEqual(p.state.data.held,[]);
});

test('checkout does not open for a departure that changed while booking creation was in flight',async()=>{
 let resolve,charged=0,discarded;
 const p=booking({bookings:{create:()=>new Promise(r=>resolve=r)},payments:{createIntent:async()=>{charged++;return {};}}});
 p.state.tripId='1pm';p.heldSeats=()=>[{seatNumber:'2A'}];p.paxFor=()=>({name:'Student'});p._discardBooking=async id=>{discarded=id;};
 const first=p.startPayment();p.state.tripId='530pm';resolve({id:'old-booking'});await first;
 assert.equal(charged,0);assert.equal(discarded,'old-booking');assert.equal(p.state.busy,false);
});
test('navigation cleanup uses the unpaid-only endpoint and clears the exact retry scope',async()=>{
 let discarded,cleared;
 const p=booking({bookings:{discard:async id=>{discarded=id;},cancel:async()=>{throw new Error('Must not invoke normal cancellation');},clearAttempt:scope=>{cleared=scope;}}});
 await p._discardBooking('paid-on-another-device','trip:2');
 assert.equal(discarded,'paid-on-another-device');assert.equal(cleared,'trip:2');
});

for (const action of ['toggleSeat', 'removeSeat']) test(action + ' ignores a response from the departure the student left', async () => {
 let resolve;
 const p=booking({seats:{hold:()=>new Promise(r=>resolve=r),release:()=>new Promise(r=>resolve=r)}});
 p.state.tripId='1pm';p.state.pax={'2A':{name:'New trip passenger'}};
 p._load=async()=>{throw new Error('Must not load another departure from an old seat response');};
 const pending=p[action]('2A');p.state.tripId='530pm';resolve();await pending;
 assert.equal(p.state.pax['2A'].name,'New trip passenger');
});
