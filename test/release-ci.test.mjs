import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requirePassingCI} from '../deploy/vps/check-ci.mjs';
const sha='a'.repeat(40);
const run={head_sha:sha,name:'DLT CI',event:'push',run_number:4,run_attempt:1,status:'completed',conclusion:'success',html_url:'https://github.com/example/actions/runs/4'};
test('a release requires passing push CI for the exact commit',()=>{
 assert.equal(requirePassingCI(sha,[run]),run);
 for(const patch of [{head_sha:'b'.repeat(40)},{event:'pull_request'},{name:'Other workflow'},{status:'in_progress',conclusion:null},{conclusion:'failure'}]){
  assert.throws(()=>requirePassingCI(sha,[{...run,...patch}]),/Release blocked/);
 }
 assert.throws(()=>requirePassingCI(sha,[]),/Release blocked/);
});
test('a later failed rerun overrides an earlier successful run',()=>{
 assert.throws(()=>requirePassingCI(sha,[run,{...run,run_attempt:2,conclusion:'failure'}]),/Release blocked/);
});
