import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
function admin(api){
 const source=readFileSync(new URL('../DLT Admin.dc.html',import.meta.url),'utf8').match(/<script[^>]*data-dc-script[^>]*>([\s\S]*?)<\/script>/)[1];
 class Logic{setState(p,done){Object.assign(this.state,typeof p==='function'?p(this.state):p);done?.();}}
 const Page=new Function('DCLogic','DLT','window',source+'\nreturn Component;')(Logic,{auth:{current:()=>({role:'SUPER_ADMIN'})},...api},{});
 const instance=new Page();
 return instance;
}
test('operations keeps the selected booking when an older detail request arrives later',async()=>{
 const pending={};const p=admin({admin:{bookingDetail:id=>new Promise(r=>pending[id]=r)},bookings:{cancellationQuote:async()=>({amount:0})}});
 const a=p._loadBooking('A');const b=p._loadBooking('B');
 pending.B({id:'B'});await b;pending.A({id:'A'});await a;
 assert.equal(p.state.data.booking.id,'B');
});
test('an older operations search cannot replace a newer search',async()=>{
 const pending={};const p=admin({admin:{bookings:({q})=>new Promise(r=>pending[q]=r)}});p._loadBooking=async()=>{};
 p.state.query='first';const a=p._searchBookings(true);p.state.query='second';const b=p._searchBookings(true);
 pending.second([{id:'B'}]);await b;pending.first([{id:'A'}]);await a;
 assert.equal(p.state.data.bookingList[0].id,'B');
});
test('boarding shows the latest selected trip even if an earlier manifest finishes last',async()=>{
 const pending={};const p=admin({boarding:{manifest:id=>new Promise(r=>pending[id]=r),events:async()=>[]}});
 p.state.boardTripId='A';const a=p._loadBoarding();p.state.boardTripId='B';const b=p._loadBoarding();
 pending.B({trip:{id:'B'},passengers:[]});await b;pending.A({trip:{id:'A'},passengers:[]});await a;
 assert.equal(p.state.data.manifest.trip.id,'B');
});
test('a late seat-map response cannot replace another trip’s seat map',async()=>{
 const pending={};const p=admin({trips:{seatMap:id=>new Promise(r=>pending[id]=r)}});
 p.state.seatTripId='A';const a=p._loadSeatMap('A');p.state.seatTripId='B';const b=p._loadSeatMap('B');
 pending.B({rows:['B']});await b;pending.A({rows:['A']});await a;
 assert.deepEqual(p.state.data.seatMap,['B']);
});

globalThis.window ||= {};
const {DLT}=await import('../dlt-client.js');
function manifestView(role,contacts){
 const p=admin({auth:{current:()=>({role,name:'Operator'})},can:()=>true,fmt:DLT.fmt,fare:DLT.fare,roleLabel:DLT.roleLabel});
 p.state.ready=true;p.state.section='Boarding';p.state.data.manifest={trip:null,passengers:contacts.map((c,i)=>({passengerId:String(i),name:'Student',studentId:'TEST',bookingCode:'DLT-TEST',seatNumber:'2A',seatType:'WINDOW',boardingStatus:'BOARDED',...c}))};
 return p.renderVals();
}
test('manifest call links contain validated Indian numbers and distinguish the booking contact',()=>{
 const v=manifestView('OPS_ADMIN',[{phone:'9876543211',contactPhone:'9876543210',contactSource:'BOOKING'},{phone:'+91 9876543211',contactSource:'PASSENGER'},{phone:'invalid'}]);
 assert.equal(v.boardList[0].callHref,'tel:+919876543210');
 assert.equal(v.boardList[0].contactLabel,'Booking contact');
 assert.equal(v.boardList[1].callHref,'tel:+919876543211');
 assert.equal(v.boardList[2].canCall,false);
});
test('boarding-only accounts do not get a Call control even if a malformed response includes a number',()=>{
 assert.equal(manifestView('BOARDING_STAFF',[{phone:'9876543210'}]).boardList[0].canCall,false);
});

test('operations creates a 1 pm Indian departure even on a device set to another timezone',async()=>{
 const old=process.env.TZ;
 try{for(const zone of ['UTC','America/Los_Angeles','Asia/Kolkata']){
  process.env.TZ=zone;let saved;
  const p=admin({can:()=>true,fmt:DLT.fmt,fare:DLT.fare,roleLabel:DLT.roleLabel,admin:{saveTrip:async v=>{saved=v;return {id:'new-trip'};},validateDraft:async()=>({})}});
  p.state.ready=true;p.state.ntDate='2026-11-29';p.state.ntTime='13:00';p.state.ntVehicle='vehicle';p.state.ntRoute='route';p._reloadTrips=async()=>{};
  await p.renderVals().createDraft();assert.equal(saved.departureAt,'2026-11-29T07:30:00.000Z',zone);
 }}finally{if(old===undefined)delete process.env.TZ;else process.env.TZ=old;}
});
