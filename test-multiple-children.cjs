const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync('server.js','utf8');
const route=source.slice(source.indexOf("app.post('/api/claim-students',"),source.indexOf("app.post('/api/claim-student',"));
function fixture(){
  const students=[1,2,3,4].map(id=>({id,name:'Child '+id,access_code:'AS-'+String(id).repeat(8)}));
  let links=new Set([4]),pending,notes=0,handler,released=false;
  const client={async query(sql,args){
    if(sql==='BEGIN'){pending=new Set(links);return {};}
    if(sql==='ROLLBACK'){pending=null;return {};}
    if(sql==='COMMIT'){links=pending;return {};}
    if(sql.startsWith('SELECT'))return {rows:students.filter(s=>args[0].includes(s.access_code))};
    if(sql.startsWith('INSERT INTO parent_student_access')){assert.equal(args[0],20);const exists=pending.has(args[1]);pending.add(args[1]);return {rowCount:exists?0:1};}
    if(sql.startsWith('INSERT INTO notifications')){notes++;return {};}
    throw Error(sql);
  },release(){released=true;}};
  vm.runInNewContext(route,{app:{post(path,auth,fn){handler=fn;}},auth:()=>null,db:{connect:async()=>client}});
  return {async claim(codes){const res={statusCode:200,status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}};await handler({user:{id:20},body:{codes}},res);return res;},get links(){return [...links];},get notes(){return notes;},get released(){return released;}};
}
test('three children are added without removing an existing child; repeated claims are idempotent',async()=>{
  const f=fixture();const codes=['as-11111111','AS-22222222','AS-33333333','AS-11111111'];
  const r=await f.claim(codes);assert.equal(r.statusCode,200);assert.equal(r.body.students.length,3);assert.deepEqual(f.links,[4,1,2,3]);assert.equal(f.notes,3);assert.equal(f.released,true);
  await f.claim(codes);assert.equal(f.notes,3);assert.deepEqual(f.links,[4,1,2,3]);
});
test('unknown code rolls back the whole submission',async()=>{const f=fixture();const r=await f.claim(['AS-11111111','AS-FFFFFFFF']);assert.equal(r.statusCode,404);assert.deepEqual(f.links,[4]);assert.equal(f.notes,0);assert.equal(f.released,true);});
test('empty and malformed input is rejected',async()=>{for(const codes of [[],null,['bad'],[123]]){const f=fixture();assert.equal((await f.claim(codes)).statusCode,400);assert.deepEqual(f.links,[4]);}});
test('parent screen shows all children and sends distinct codes',async()=>{
  const nodes=new Map();const node=key=>{if(!nodes.has(key))nodes.set(key,{hidden:false,textContent:'',querySelector:()=>({disabled:false})});return nodes.get(key);};
  let sent;const context={localStorage:{},document:{querySelector:node},fetch:async(path,opts)=>{sent=JSON.parse(opts.body);return {ok:true,json:async()=>({students:[{name:'Child 1'},{name:'Child 2'},{name:'Child 3'}]})};}};
  vm.createContext(context);vm.runInContext(fs.readFileSync('app.js','utf8'),context);
  vm.runInContext('load=async()=>{}',context);
  context.data={students:[1,2,3].map(id=>({id,name:'Child '+id})),notes:[]};vm.runInContext('parent(data)',context);
  assert.match(node('#app').innerHTML,/Watoto wangu \(3\)/);
  for(const n of [1,2,3])assert.match(node('#app').innerHTML,new RegExp('Child '+n));
  await node('#claimForm').onsubmit({preventDefault(){},target:{codes:{value:'as-11111111\nAS-22222222,AS-33333333;AS-11111111'},querySelector:()=>({disabled:false})}});
  assert.deepEqual(sent.codes,['AS-11111111','AS-22222222','AS-33333333']);assert.match(node('#claimStatus').textContent,/Child 1, Child 2, Child 3/);
});
