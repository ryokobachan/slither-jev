// Observed poses test a catch-up decision; they do not prove a live kill.
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync(require('path').join(__dirname,'..','src','slither-reflex.js'),'utf8');
const rows=JSON.parse(fs.readFileSync(require('path').join(__dirname,'replay20-catchup-regression.json'),'utf8'));
function setup(row) {
  const s=row.state,mamu=.033;let now=1000,timer,heading=s.self.angle;
  const me={id:s.self.id,xx:s.self.x,yy:s.self.y,ang:s.self.angle,wang:s.self.angle,
    sc:s.self.radius/14.5,sp:s.self.speed/31.25,ssp:s.self.normal_speed/31.25,
    msp:s.self.boost_speed/31.25,scang:1,spang:s.self.speed/s.self.turn_radius/(mamu*125),
    sct:80,pts:s.self.points.map(p=>({xx:p[0],yy:p[1]}))};
  const enemies=s.enemies.map(e=>({id:e.id,xx:e.head.x,yy:e.head.y,ang:e.angle,wang:e.target_angle,
    sc:e.radius/14.5,sp:e.speed/31.25,ssp:181/31.25,msp:14,scang:1,spang:e.turn_rate/(mamu*125),
    sct:e.points.length+(e.body_complete?0:1),pts:e.points.map(p=>({xx:p[0],yy:p[1]}))}));
  const ctx={Math,performance:{now:()=>now},innerWidth:1600,innerHeight:900,
    MouseEvent:class{constructor(type,p){Object.assign(this,{type},p)}},
    setInterval:f=>{timer=f;return 1},clearInterval:()=>{}};
  ctx.window={slither:me,slithers:[me,...enemies],foods:[],playing:true,mamu,
    grd:s.arena.cx,flux_grd:s.arena.radius,follow_view:true,
    dispatchEvent:e=>{if(e.type==='mousemove')heading=Math.atan2(e.clientY-450,e.clientX-800);}};
  vm.runInNewContext(source,ctx);const c=ctx.window.__jevReflex;
  const plan={mode:'hunt_position',attack_intent:true,enemy_id:row.attack_plan.enemy_id,
    attack_started:now,attack_stage:'position',angle:me.ang,boost:false,
    plan_id:'recorded-catch-up-'+row.t};
  c.setPlan(plan);
  return {c,ctx,me,enemies,plan,tick:()=>{now+=50;timer();},heading:()=>heading};
}
for(const row of rows) {
  const f=setup(row);f.tick();
  assert.equal(f.c.plan.enemy_id,row.attack_plan.enemy_id,'Keep the selected opponent');
  assert.equal(f.c.plan.attack_stage,'position','This is an approach, before the crossing is feasible');
  assert(f.c.plan.catchup,'Mark the bounded catch-up approach explicitly');
  assert(f.c.boost&&!f.c.last.override,
    `At ${row.t}, safe same-direction pursuit must gain on the slower opponent instead of following at matching speed`);
  assert(f.c.events.some(e=>e.type==='catchup_boost'&&e.enemy_id===row.attack_plan.enemy_id),
    'Emit evidence of the actual catch-up input for the intended opponent');
  assert(f.c.last.clearance>=25&&f.c.last.hardClearance>0,'The actual accelerated approach must clear bodies');
}
console.log('Recorded t186/t216/t231 parallel approach gains forward position with a checked boost: PASS');
{
  const f=setup(rows[0]),enemy=f.enemies.find(e=>e.id===f.plan.enemy_id);
  f.ctx.window.slithers=[f.me,enemy];enemy.sp=f.me.msp;f.tick();
  assert(!f.c.boost,'Do not waste mass chasing a rival as fast as our maximum speed');
  console.log('Equal-maximum-speed rival does not trigger catch-up boost: PASS');
}
{
  const f=setup(rows[0]),enemy=f.enemies.find(e=>e.id===f.plan.enemy_id);
  const dx=Math.cos(enemy.ang)*1800,dy=Math.sin(enemy.ang)*1800;
  enemy.xx+=dx;enemy.yy+=dy;enemy.pts=enemy.pts.map(p=>({xx:p.xx+dx,yy:p.yy+dy}));
  f.ctx.window.slithers=[f.me,enemy];f.tick();
  assert(!f.c.boost,'A remote rival with an excessive catch time must not cause empty-space boosting');
  console.log('Unrelated distant opponent does not trigger a speculative boosted chase: PASS');
}
{
  const f=setup(rows[0]),enemy=f.enemies.find(e=>e.id===f.plan.enemy_id);
  const ux=Math.cos(f.me.ang),uy=Math.sin(f.me.ang),cx=f.me.xx+ux*140,cy=f.me.yy+uy*140;
  const blocker={id:999,xx:cx-uy*300,yy:cy+ux*300,ang:f.me.ang+Math.PI/2,
    wang:f.me.ang+Math.PI/2,sc:1,sp:0,ssp:5,msp:14,scang:1,spang:1,sct:13,
    pts:Array.from({length:13},(_,i)=>({xx:cx-uy*(-300+i*50),yy:cy+ux*(-300+i*50)}))};
  f.ctx.window.slithers=[f.me,enemy,blocker];f.tick();
  assert(!(f.c.plan.attack_stage==='position'&&(f.c.plan.boost||f.c.plan.boost_when_aligned)),
    'A body across the catch-up lane must reject that accelerated attack plan');
  if(f.c.boost)assert(f.c.last.override,'Any remaining boost must be collision avoidance, never catch-up');
  console.log('Body across the approach lane vetoes the accelerated attack: PASS');
}
