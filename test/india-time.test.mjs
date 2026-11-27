import {test} from 'node:test';
import assert from 'node:assert/strict';
globalThis.window ||= {};
const {DLT}=await import('../dlt-client.js');
test('trip and ticket times stay in Indian time regardless of the device timezone',()=>{
 const old=process.env.TZ;
 try{for(const zone of ['UTC','America/Los_Angeles','Asia/Kolkata']){
  process.env.TZ=zone;
  assert.equal(DLT.fmt.time('2026-11-27T07:30:00Z'),'1:00 pm',zone);
  assert.equal(DLT.fmt.time('2026-11-27T12:00:00Z'),'5:30 pm',zone);
  assert.match(DLT.fmt.date('2026-11-27T20:00:00Z'),/28/,zone);
 }}finally{if(old===undefined)delete process.env.TZ;else process.env.TZ=old;}
});
