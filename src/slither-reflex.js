(() => {
  // Input-only safety controller. It never modifies game objects or the socket.
  window.__jevReflex?.stop();
  const C = {
    plan:null, updated:0, stopped:false, boost:false, boostSince:0, cooldown:0,
    seq:0,revision:0,events:[],followSeconds:0,firstInputRevision:0,
    record(type,data={}) {this.events.push({seq:++this.seq,t:performance.now(),type,...data});if(this.events.length>512)this.events.shift();},
    drainEvents() {const events=this.events;this.events=[];return events;},
    lastTick:performance.now(), lastEscape:0, escapeAngle:0, escapeUntil:0,pursuit:null,clearSince:0,
    metrics:{version:'attack-control-v20-efficient-pursuit',ticks:0, emergency_turns:0, boost_bursts:0, boost_seconds:0, boost_vetoes:0, escape_boosts:0, proactive_boosts:0,pursuit_episodes:0,local_loot_entries:0,local_attack_entries:0},
    setPlan(plan) {
      if(this.plan?.local_loot&&performance.now()<this.plan.local_until&&
          ['forage','escape','disengage','seek_action','hunt_position'].includes(plan.mode))
        return {accepted:false,reason:'verified_local_loot_in_progress',plan_id:this.plan.plan_id};
      if(this.plan?.local_attack&&performance.now()<this.plan.local_until&&
          ['forage','seek_action'].includes(plan.mode))
        return {accepted:false,reason:'local_attack_in_progress',plan_id:this.plan.plan_id};
      // commit has already assessed the new route. An expired threat latch
      // must not veto a newly safe attack; current dangers are checked each tick.
      if(plan.coil||plan.attack_intent||plan.mode==='cut_ahead')this.escapeUntil=0;
      if(plan.plan_id!==this.plan?.plan_id)this.followSeconds=0;
      const sameTarget=JSON.stringify(plan.target)===JSON.stringify(this.plan?.target);
      this.plan={...plan,revision:++this.revision}; this.updated=performance.now();
      if(['scavenge','collect_rich_food'].includes(plan.mode))this.plan.loot_anchor=plan.target;
      if(!sameTarget)this.arrived=false;
      this.record('accepted',{plan_id:plan.plan_id,revision:this.revision,mode:plan.mode});
      return {accepted:true,plan_id:plan.plan_id,revision:this.revision};
    },
    setBoost(on,x,y) {
      if (on===this.boost) return;
      window.dispatchEvent(new MouseEvent(on?'mousedown':'mouseup',
        {clientX:x,clientY:y,button:0,buttons:on?1:0,bubbles:true}));
      this.boost=on;
      if(on) {this.boostSince=performance.now();this.metrics.boost_bursts++;}
      else this.cooldown=performance.now()+250;
    },
    stop() {this.stopped=true;clearInterval(this.timer);this.setBoost(false,innerWidth/2,innerHeight/2);},
  };
  const delta=(a,b)=>((a-b+Math.PI)%(Math.PI*2)+Math.PI*2)%(Math.PI*2)-Math.PI;
  const rewardIntent=p=>p.attack_intent||['cut_ahead','scavenge','collect_rich_food'].includes(p.mode);
  const segmentDistance=(x,y,ax,ay,bx,by)=>{
    const dx=bx-ax,dy=by-ay;
    const t=Math.max(0,Math.min(1,((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy||1)));
    return Math.hypot(x-ax-t*dx,y-ay-t*dy);
  };
  const segmentsDistance=(ax,ay,bx,by,cx,cy,dx,dy)=>{
    const cross=(ux,uy,vx,vy)=>ux*vy-uy*vx;
    const denominator=cross(bx-ax,by-ay,dx-cx,dy-cy);
    if(Math.abs(denominator)>1e-9) {
      const t=cross(cx-ax,cy-ay,dx-cx,dy-cy)/denominator;
      const u=cross(cx-ax,cy-ay,bx-ax,by-ay)/denominator;
      if(t>=0&&t<=1&&u>=0&&u<=1)return 0;
    }
    return Math.min(segmentDistance(ax,ay,cx,cy,dx,dy),segmentDistance(bx,by,cx,cy,dx,dy),
      segmentDistance(cx,cy,ax,ay,bx,by),segmentDistance(dx,dy,ax,ay,bx,by));
  };
  const boxesNear=(ax,ay,bx,by,cx,cy,dx,dy,r)=>
    Math.max(ax,bx)+r>=Math.min(cx,dx)&&Math.max(cx,dx)+r>=Math.min(ax,bx)&&
    Math.max(ay,by)+r>=Math.min(cy,dy)&&Math.max(cy,dy)+r>=Math.min(ay,by);
  function ownLoopClosed(s,prey) {
    const hx=s.xx+(s.fx||0),hy=s.yy+(s.fy||0),ex=prey.xx+(prey.fx||0),ey=prey.yy+(prey.fy||0);
    let px=hx,py=hy,prior=Math.atan2(hy-ey,hx-ex),winding=0;
    for(let i=(s.pts||[]).length-1;i>=0;i--) {
      const p=s.pts[i],x=p.xx+(p.fx||0),y=p.yy+(p.fy||0);
      if(p.dying||Math.hypot(x-px,y-py)>100)break;
      const angle=Math.atan2(y-ey,x-ex);winding+=delta(prior,angle);prior=angle;px=x;py=y;
      if(Math.abs(winding)>5.8&&Math.hypot(x-hx,y-hy)<14.5*s.sc*1.5)return true;
    }
    return false;
  }

/* Pure geometric helper; no browser state, timers, or input dispatch.
 * obstacle.r is own radius + enemy radius + the caller's safety padding (15).
 * Connectivity uses the physical capsule. The caller must still test turning,
 * moving heads and its desired safety clearance before using a returned path.
 */
function escapeConnectivityV16({sx, sy, ownR, obstacles, arena, extent=1000, cellSize=40, padding=15}) {
  const half=Math.max(2,Math.ceil(extent/cellSize)),size=half*2+1,total=size*size;
  const radius=half*cellSize,bucketSize=cellSize*3,buckets=new Map();
  const pointSegment=(x,y,a,b,c,d)=>{
    const ux=c-a,uy=d-b,t=Math.max(0,Math.min(1,((x-a)*ux+(y-b)*uy)/(ux*ux+uy*uy||1)));
    return Math.hypot(x-a-t*ux,y-b-t*uy);
  };
  const segmentGap=(ax,ay,bx,by,p)=>{
    const ux=bx-ax,uy=by-ay,vx=p.x-p.ax,vy=p.y-p.ay;
    const denominator=ux*vy-uy*vx,wx=p.ax-ax,wy=p.ay-ay;
    if(Math.abs(denominator)>1e-9) {
      const t=(wx*vy-wy*vx)/denominator,u=(wx*uy-wy*ux)/denominator;
      if(t>=0&&t<=1&&u>=0&&u<=1)return -p.r;
    }
    return Math.min(pointSegment(ax,ay,p.ax,p.ay,p.x,p.y),pointSegment(bx,by,p.ax,p.ay,p.x,p.y),
      pointSegment(p.ax,p.ay,ax,ay,bx,by),pointSegment(p.x,p.y,ax,ay,bx,by))-p.r;
  };
  const key=(x,y)=>`${x},${y}`;
  const physical=obstacles.map(p=>({...p,r:Math.max(0,p.r-padding)}));
  // A short grid edge is queried at its midpoint. This dilation guarantees that
  // its complete capsule candidates are present even across bucket boundaries.
  const edgeReach=cellSize*Math.SQRT2;
  for(const p of physical) {
    const reach=p.r+edgeReach;
    for(let ix=Math.floor((Math.min(p.ax,p.x)-reach)/bucketSize);ix<=Math.floor((Math.max(p.ax,p.x)+reach)/bucketSize);ix++)
      for(let iy=Math.floor((Math.min(p.ay,p.y)-reach)/bucketSize);iy<=Math.floor((Math.max(p.ay,p.y)+reach)/bucketSize);iy++) {
        const k=key(ix,iy);if(!buckets.has(k))buckets.set(k,[]);buckets.get(k).push(p);
      }
  }
  const arenaGap=(x,y)=>arena?arena.radius-ownR-Math.hypot(x-arena.cx,y-arena.cy):Infinity;
  const shortClear=(ax,ay,bx,by)=>{
    if(arenaGap(ax,ay)<=0||arenaGap(bx,by)<=0)return false;
    for(const p of buckets.get(key(Math.floor((ax+bx)/2/bucketSize),Math.floor((ay+by)/2/bucketSize)))||[])
      if(segmentGap(ax,ay,bx,by,p)<=0)return false;
    return true;
  };
  const lineClear=(ax,ay,bx,by)=>{
    const steps=Math.max(1,Math.ceil(Math.hypot(bx-ax,by-ay)/cellSize));
    let px=ax,py=ay;
    for(let i=1;i<=steps;i++) {
      const x=ax+(bx-ax)*i/steps,y=ay+(by-ay)*i/steps;
      if(!shortClear(px,py,x,y))return false;px=x;py=y;
    }
    return true;
  };
  const xs=new Float64Array(total),ys=new Float64Array(total),inside=new Uint8Array(total),free=new Uint8Array(total),adj=new Uint8Array(total);
  const dirs=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]],opposite=[1,0,3,2,5,4,7,6];
  for(let iy=0;iy<size;iy++)for(let ix=0;ix<size;ix++) {
    const id=iy*size+ix,x=sx+(ix-half)*cellSize,y=sy+(iy-half)*cellSize;
    xs[id]=x;ys[id]=y;inside[id]=Math.hypot(x-sx,y-sy)<=radius+1e-7?1:0;
    if(inside[id]&&shortClear(x,y,x,y))free[id]=1;
  }
  for(let iy=0;iy<size;iy++)for(let ix=0;ix<size;ix++) {
    const id=iy*size+ix;if(!free[id])continue;
    for(const d of [0,2,4,6]) {
      const [dx,dy]=dirs[d],nx=ix+dx,ny=iy+dy;if(nx<0||nx>=size||ny<0||ny>=size)continue;
      const to=ny*size+nx;if(free[to]&&shortClear(xs[id],ys[id],xs[to],ys[to])) {
        adj[id]|=1<<d;adj[to]|=1<<opposite[d];
      }
    }
  }
  const distance=new Float64Array(total);distance.fill(Infinity);
  const next=new Int32Array(total);next.fill(-1);
  const heap=[];
  const push=(id,cost)=>{
    let i=heap.length;heap.push([id,cost]);while(i>0){const p=(i-1)>>1;if(heap[p][1]<=cost)break;heap[i]=heap[p];i=p;}heap[i]=[id,cost];
  };
  const pop=()=>{
    const result=heap[0],tail=heap.pop();if(heap.length){let i=0;while(i*2+1<heap.length){let j=i*2+1;if(j+1<heap.length&&heap[j+1][1]<heap[j][1])j++;if(heap[j][1]>=tail[1])break;heap[i]=heap[j];i=j;}heap[i]=tail;}return result;
  };
  let boundaryCount=0;
  for(let id=0;id<total;id++) {
    if(!free[id]||Math.hypot(xs[id]-sx,ys[id]-sy)<radius-cellSize*Math.SQRT2)continue;
    // A disk-edge cell is a seed only if a physical path actually crosses the
    // analysis boundary. An arena wall is never an exterior escape.
    const angle=Math.atan2(ys[id]-sy,xs[id]-sx),bx=sx+Math.cos(angle)*(radius+cellSize),by=sy+Math.sin(angle)*(radius+cellSize);
    if(lineClear(xs[id],ys[id],bx,by)){distance[id]=0;push(id,0);boundaryCount++;}
  }
  while(heap.length) {
    const [id,cost]=pop();if(cost!==distance[id])continue;
    for(let d=0;d<8;d++)if(adj[id]&(1<<d)) {
      const to=id+dirs[d][0]+dirs[d][1]*size,newCost=cost+cellSize*(d<4?1:Math.SQRT2);
      if(newCost<distance[to]){distance[to]=newCost;next[to]=id;push(to,newCost);}
    }
  }
  const center=half*size+half;
  let seed=-1,startDistance=Infinity;
  // Never snap through a body to a nearby free cell. This also handles a start
  // inside safety padding but outside the physical capsule.
  for(let iy=half-1;iy<=half+1;iy++)for(let ix=half-1;ix<=half+1;ix++) {
    const id=iy*size+ix,extra=Math.hypot(xs[id]-sx,ys[id]-sy);
    if(free[id]&&distance[id]+extra<startDistance&&lineClear(sx,sy,xs[id],ys[id])){seed=id;startDistance=distance[id]+extra;}
  }
  const connected=seed>=0,path=[];
  if(connected)for(let id=seed,guard=0;id>=0&&guard<total;id=next[id],guard++)path.push({x:xs[id],y:ys[id]});
  let waypoint=null;
  if(path.length) {
    waypoint=path[0];
    for(const p of path){if(!lineClear(sx,sy,p.x,p.y))break;waypoint=p;}
    if(Math.hypot(waypoint.x-sx,waypoint.y-sy)<cellSize/2&&path[1])waypoint=path[1];
  }
  function endpoint(x,y) {
    if(!connected)return {reachable:false,progress:-Infinity,reachesBoundary:false,followsExit:false};
    const displacement=Math.hypot(x-sx,y-sy);
    if(displacement>=radius) {
      const boundary=path[path.length-1];
      const reaches=!!boundary&&lineClear(boundary.x,boundary.y,x,y);
      return {reachable:reaches,progress:reaches?startDistance:-Infinity,reachesBoundary:reaches,followsExit:reaches};
    }
    const gx=(x-sx)/cellSize+half,gy=(y-sy)/cellSize+half;
    let remaining=Infinity;
    for(let iy=Math.floor(gy);iy<=Math.ceil(gy);iy++)for(let ix=Math.floor(gx);ix<=Math.ceil(gx);ix++) {
      if(ix<0||ix>=size||iy<0||iy>=size)continue;
      const id=iy*size+ix,extra=Math.hypot(xs[id]-x,ys[id]-y);
      if(free[id]&&distance[id]+extra<remaining&&lineClear(x,y,xs[id],ys[id]))remaining=distance[id]+extra;
    }
    const progress=startDistance-remaining;
    return {reachable:Number.isFinite(remaining),distanceToBoundary:remaining,progress,reachesBoundary:remaining<=cellSize,
      followsExit:Number.isFinite(remaining)&&progress>=Math.max(cellSize*.75,displacement*.15)};
  }
  const physicalClearance=Math.min(arenaGap(sx,sy),...physical.map(p=>pointSegment(sx,sy,p.ax,p.ay,p.x,p.y)-p.r));
  return {connected,status:connected?'connected':'closed_or_unresolved_narrow_gap',waypoint,
    angle:waypoint?Math.atan2(waypoint.y-sy,waypoint.x-sx):null,distanceToBoundary:startDistance,
    cellSize,extent:radius,boundaryCount,startPhysicalClearance:physicalClearance,
    startInsideSafetyPadding:physicalClearance>=0&&physicalClearance<padding,
    resolutionNote:'A returned path is capsule-clear. A missing path may be a passage narrower than the grid; it is not a proof of continuous-space closure.',
    endpoint,path};
}

  function tick(D=C,preview=false) {
    const now=performance.now(), dt=Math.min(.2,(now-D.lastTick)/1000);D.lastTick=now;
    if(D.boost) D.metrics.boost_seconds+=dt;
    const s=window.slither;
    if(D.stopped||!window.playing||!s||s.dead) {
      if(!preview)D.setBoost(false,innerWidth/2,innerHeight/2);
      return {can_follow:false,reason:'not_live'};
    }
    const planAgeLimit=D.plan?.coil?12000:D.plan?.attack_intent?8000:3000;
    if(!D.plan||now-D.updated>planAgeLimit) {
      D.plan={angle:s.ang,boost:false,mode:'survival_fallback',plan_id:null};D.arrived=false;
    }
    if(D.plan.local_attack&&now>D.plan.local_until) {
      D.plan={angle:s.ang,boost:false,mode:'survival_fallback',plan_id:null};D.arrived=false;
    }
    D.metrics.ticks++;
    const sx=s.xx+(s.fx||0),sy=s.yy+(s.fy||0),ownR=14.5*s.sc;
    const speed=s.sp*31.25,normalSpeed=s.ssp*31.25,maxSpeed=s.msp*31.25;
    const turnRate=window.mamu*s.scang*s.spang*125;
    let goal=D.plan.angle;
    if(D.plan.coil) {
      let c=D.plan.coil;
      const prey=(window.slithers||[]).find(o=>o.id===c.enemy_id&&!o.dead);
      if(!preview&&prey&&!c.closure_observed&&ownLoopClosed(s,prey)) {
        c={...c,closure_observed:true,stage:'tighten'};D.plan.coil=c;
      }
      if(!preview&&c.closure_observed&&D.closedEnemy!==c.enemy_id) {
        D.closedEnemy=c.enemy_id;D.record('coil_closed',{enemy_id:c.enemy_id,radius:c.radius});
      }
      if(!preview&&!prey&&D.closedEnemy===c.enemy_id&&(window.slithers||[]).some(o=>window.__jevObservedIdentities?.objects.get(o)?.id===c.enemy_id&&o.dead))
        D.record('trapped_prey_died',{enemy_id:c.enemy_id});
      // Cancel stale orbit immediately if the target disappears or leaves it.
      const escaped=!prey||Math.hypot(prey.xx+(prey.fx||0)-c.cx,
        prey.yy+(prey.fy||0)-c.cy)>c.radius+ownR+14.5*prey.sc;
      if(escaped&&preview)return {can_follow:false,reason:'prey_missing_or_outside'};
      if(escaped) {if(!preview)D.record('aborted',{plan_id:D.plan.plan_id,reason:'prey_missing_or_outside'});D.plan={angle:s.ang,boost:false,mode:'survival_fallback'};D.arrived=false;goal=s.ang;}
      else {
        const bearing=Math.atan2(sy-c.cy,sx-c.cx),distance=Math.hypot(sx-c.cx,sy-c.cy);
        const correction=Math.max(-1.1,Math.min(1.1,Math.atan2(2*(distance-c.radius),c.radius)));
        goal=bearing+c.direction*(Math.PI/2+correction);
      }
    }
    if(D.plan.target&&!D.arrived) {
      const distance=Math.hypot(D.plan.target.x-sx,D.plan.target.y-sy);
      if(distance<Math.max(22,ownR+8)) {D.arrived=true;D.arrivalAngle=D.plan.exit_angle??s.ang;}
      else goal=Math.atan2(D.plan.target.y-sy,D.plan.target.x-sx);
    }
    if(D.arrived) goal=D.arrivalAngle;
    const obstacles=[], heads=[];let liveThreat=null,maxCoverage=0;
    const enemyCoverage=new Map();
    for(const o of window.slithers||[]) {
      if(o===s||o.dead) continue;
      const r=ownR+14.5*o.sc+10,hx=o.xx+(o.fx||0),hy=o.yy+(o.fy||0);
      if(Math.hypot(hx-sx,hy-sy)<1000) {
        // Follow the same bounded turn toward the known heading as the client.
        const path=[{x:hx,y:hy}];let a=o.ang,x=hx,y=hy;
        const rate=window.mamu*o.scang*o.spang*125,velocity=o.sp*31.25;
        for(let i=1;i<=28;i++) {
          a+=Math.max(-rate*.085,Math.min(rate*.085,delta(o.wang??a,a)));
          x+=Math.cos(a)*velocity*.085;y+=Math.sin(a)*velocity*.085;
          path.push({x,y});
        }
        const distance=Math.hypot(hx-sx,hy-sy);
        const toward=((sx-hx)*Math.cos(o.ang)+(sy-hy)*Math.sin(o.ang))/Math.max(1,distance);
        const relative=velocity*toward-normalSpeed*((sx-hx)*Math.cos(s.ang)+(sy-hy)*Math.sin(s.ang))/Math.max(1,distance);
        heads.push({id:o.id,r:r+8,path,velocity,fast:o.sp>(o.ssp||5)*1.25,distance,
          closing:toward>.15,catchTime:relative>1?(distance-r)/relative:Infinity});
      }
      let previous=null,bodyLength=0;const coverage=new Set();
      for(const p of [...(o.pts||[]),{xx:hx,yy:hy}]) {
        if(p.dying) {previous=null;continue;}
        const x=p.xx+(p.fx||0),y=p.yy+(p.fy||0);
        const ax=previous&&Math.hypot(x-previous.x,y-previous.y)<=100?previous.x:x;
        const ay=previous&&Math.hypot(x-previous.x,y-previous.y)<=100?previous.y:y;
        bodyLength+=Math.hypot(x-ax,y-ay);
        const steps=Math.max(1,Math.ceil(Math.hypot(x-ax,y-ay)/30));
        for(let j=0;j<=steps;j++) {
          const dx=ax+(x-ax)*j/steps-sx,dy=ay+(y-ay)*j/steps-sy,d=Math.hypot(dx,dy);
          if(d>40&&d<700)coverage.add(Math.floor((Math.atan2(dy,dx)+Math.PI)*12/Math.PI)%24);
        }
        if(segmentDistance(sx,sy,ax,ay,x,y)<1000)obstacles.push({x,y,ax,ay,r:r+5});
        previous={x,y};
      }
      const capable=bodyLength>=2*Math.PI*Math.max(ownR*3,normalSpeed/Math.max(.1,turnRate)*1.3)
        ||(o.pts||[]).length<(o.sct||0);
      enemyCoverage.set(o.id,coverage.size);
      if(capable) {
        maxCoverage=Math.max(maxCoverage,coverage.size);
        const distance=Math.hypot(hx-sx,hy-sy),radial=((hx-sx)*Math.cos(o.ang)+(hy-sy)*Math.sin(o.ang))/Math.max(1,distance);
        // Coverage is warning evidence, not a command to flee from a departing
        // head. A wrap needs a head currently laying a tangential closing arc.
        const wrapping=coverage.size>=5&&distance>100&&distance<650&&Math.abs(radial)<.75;
        const fastClosing=o.sp>(o.ssp||5)*1.25&&o.sc>=s.sc*.8&&distance<650&&radial<-.25;
        const severity=coverage.size+(fastClosing?5:0);
        if((wrapping||fastClosing)&&(!liveThreat||severity>liveThreat.severity))
          liveThreat={enemy_id:o.id,x:hx,y:hy,severity};
      }
    }
    // Remember the rival, but keep memory distinct from today's reachable exits.
    if(liveThreat) {
      if(!D.pursuit&&!preview){D.metrics.pursuit_episodes++;D.record('pursuit_started',liveThreat);}
      D.pursuit={...liveThreat,until:now+6000};D.clearSince=0;
    } else if(D.pursuit) {
      const pursuer=(window.slithers||[]).find(o=>o.id===D.pursuit.enemy_id&&!o.dead);
      const distance=pursuer?Math.hypot(pursuer.xx-sx,pursuer.yy-sy):Infinity;
      const clear=distance>850&&(enemyCoverage.get(D.pursuit.enemy_id)||0)<4;
      D.clearSince=clear?(D.clearSince||now):0;
      if(now>D.pursuit.until&&D.clearSince&&now-D.clearSince>=1500) {
        if(!preview)D.record('pursuit_cleared',{enemy_id:D.pursuit.enemy_id});
        D.pursuit=null;D.clearSince=0;
      }
    }
    D.metrics.pursuit_remembered=!!D.pursuit;D.metrics.pursuer_id=D.pursuit?.enemy_id??null;
    // Nearby capsules only: evaluating every visible body segment for every
    // trajectory would stall the very input loop that must escape the closing gap.
    const obstacleCells=new Map(),cellSize=200;
    for(const p of obstacles) {
      const reach=p.r+180+maxSpeed*.085;
      const x0=Math.floor((Math.min(p.ax,p.x)-reach)/cellSize),x1=Math.floor((Math.max(p.ax,p.x)+reach)/cellSize);
      const y0=Math.floor((Math.min(p.ay,p.y)-reach)/cellSize),y1=Math.floor((Math.max(p.ay,p.y)+reach)/cellSize);
      for(let ix=x0;ix<=x1;ix++)for(let iy=y0;iy<=y1;iy++) {
        const key=ix*131071+iy;
        if(!obstacleCells.has(key))obstacleCells.set(key,[]);
        obstacleCells.get(key).push(p);
      }
    }
    function assess(angle,velocity,followPlan=false,steps=18,alignBoost=false) {
      let x=sx,y=sy,a=s.ang,min=1000,first=10,hardMin=1000,hardFirst=10,arrived=D.arrived,closingMargin=10;
      let arrivalTime=arrived?0:null;
      for(let i=1;i<=steps;i++) {
        const t=i*.085;
        let desired=angle;
        if(followPlan&&D.plan.coil) {
          const c=D.plan.coil,d=Math.hypot(x-c.cx,y-c.cy);
          desired=Math.atan2(y-c.cy,x-c.cx)+c.direction*(Math.PI/2+Math.max(-1.1,Math.min(1.1,Math.atan2(2*(d-c.radius),c.radius))));
        } else if(followPlan&&D.plan.target&&!arrived) {
          if(Math.hypot(D.plan.target.x-x,D.plan.target.y-y)<Math.max(22,ownR+8)) {
            arrived=true;if(arrivalTime===null)arrivalTime=(i-1)*.085;
          }
          desired=arrived?(D.plan.exit_angle??a):Math.atan2(D.plan.target.y-y,D.plan.target.x-x);
        } else if(followPlan&&arrived)desired=D.plan.exit_angle??a;
        const stepVelocity=alignBoost&&Math.abs(delta(desired,a))>=.65?normalSpeed:
          followPlan&&arrived&&Number.isFinite(D.plan.exit_angle)?normalSpeed:
          followPlan&&D.plan.boost_when_aligned&&!arrived
          ? (Math.abs(delta(desired,a))<.45&&now+i*85>=D.cooldown?maxSpeed:normalSpeed):velocity;
        a+=Math.max(-turnRate*.085,Math.min(turnRate*.085,delta(desired,a)));
        const px=x,py=y;
        x+=Math.cos(a)*stepVelocity*.085;y+=Math.sin(a)*stepVelocity*.085;
        if(followPlan&&D.plan.target&&arrivalTime===null&&
            segmentDistance(D.plan.target.x,D.plan.target.y,px,py,x,y)<Math.max(22,ownR+8))arrivalTime=t;
        let gap=Math.min(180,(window.flux_grd||window.grd*.98)-Math.hypot(x-window.grd,y-window.grd)-ownR-15);
        let hard=gap+15;
        for(const p of obstacleCells.get(Math.floor(x/cellSize)*131071+Math.floor(y/cellSize))||[]) {
          if(!boxesNear(px,py,x,y,p.ax,p.ay,p.x,p.y,p.r+Math.max(0,gap)))continue;
          const d=segmentsDistance(px,py,x,y,p.ax,p.ay,p.x,p.y)-p.r;gap=Math.min(gap,d);hard=Math.min(hard,d+15);
        }
        for(const h of heads) for(let j=1;j<=i;j++) {
          const p=h.path[j-1],q=h.path[j];
          if(!boxesNear(px,py,x,y,p.x,p.y,q.x,q.y,h.r+Math.max(0,gap)+55))continue;
          const d=segmentsDistance(px,py,x,y,p.x,p.y,q.x,q.y)-h.r;
          // The user explicitly prefers a closer, riskier interception. Reduce
          // uncertainty padding for that chosen victim only; physical radii and
          // unrelated rivals remain unchanged.
          const uncertainty=D.plan.attack_intent&&h.id===D.plan.enemy_id?
            Math.min(20,h.velocity*t*.06):Math.min(55,h.velocity*t*.16);
          gap=Math.min(gap,d-uncertainty);hard=Math.min(hard,d+18);
        }
        // A currently traversable gate can close just after we reach it. Keep
        // that time margin, including the rival's newly laid body, not distance.
        if(steps>18)for(const h of heads)for(let j=i+1;j<h.path.length;j++) {
          const p=h.path[j-1],q=h.path[j];
          if(!boxesNear(px,py,x,y,p.x,p.y,q.x,q.y,h.r+20))continue;
          if(segmentsDistance(px,py,x,y,p.x,p.y,q.x,q.y)<h.r+20)
            closingMargin=Math.min(closingMargin,(j-i)*.085);
        }
        min=Math.min(min,gap);hardMin=Math.min(hardMin,hard);
        if(hard<0&&hardFirst===10) hardFirst=t;
        if(gap<0&&first===10) first=t;
      }
      return {angle,clearance:min,collisionTime:first,hardClearance:hardMin,hardCollisionTime:hardFirst,closingMargin,arrivalTime,x,y};
    }
    // Rival ETA is a short-horizon projection, not a guarantee. Include the
    // whole rich patch: another head can consume its near edge before its center.
    function foodRace(food) {
      let rivalEta=Infinity;
      for(const h of heads)for(let j=1;j<h.path.length;j++) {
        const a=h.path[j-1],b=h.path[j];
        if(segmentDistance(food.x,food.y,a.x,a.y,b.x,b.y)<80) {
          rivalEta=Math.min(rivalEta,(j-1)*.085);break;
        }
      }
      const normalEta=food.distance/Math.max(1,normalSpeed)+Math.abs(delta(food.angle,s.ang))/Math.max(.1,turnRate);
      return {rivalEta,normalEta,contested:rivalEta<normalEta+.75};
    }
    // Rich trails can appear and disappear between API decisions. Code may
    // interrupt ordinary travel for a nearby verified pickup-and-exit route;
    // record this local decision separately from Jev's accepted choices.
    if(!preview&&!D.plan.coil&&(!D.plan.attack_intent||D.plan.attack_stage==='position')&&
        (!D.plan.local_loot||now>D.plan.local_until)&&now-(D.lastLootScan||0)>250) {
      D.lastLootScan=now;
      const foods=(window.foods||[]).filter(f=>f&&!f.eaten&&f.sz>=6&&Math.hypot(f.xx-sx,f.yy-sy)<430);
      const candidates=foods.map(f=>({x:f.xx,y:f.yy,size:f.sz,distance:Math.hypot(f.xx-sx,f.yy-sy),
        angle:Math.atan2(f.yy-sy,f.xx-sx),value:foods.reduce((v,g)=>v+(Math.hypot(g.xx-f.xx,g.yy-f.yy)<80?g.sz:0),0)}))
        .filter(f=>f.value>=65&&f.distance>Math.max(25,2*normalSpeed/turnRate*Math.sin(Math.min(Math.abs(delta(f.angle,s.ang)),Math.PI/2))+18))
        .map(f=>({...f,...foodRace(f)}))
        .sort((a,b)=>b.value/(b.normalEta+.35)-a.value/(a.normalEta+.35)).slice(0,3);
      const base=D.plan,wasArrived=D.arrived;let pickup=null;
      for(const food of candidates) {
        let best=null;
        for(const accelerate of ((food.contested&&food.distance>45)||(food.distance>160&&food.value>=110)?[true,false]:[false]))
        for(const exitAngle of [s.ang,food.angle,food.angle+Math.PI/2,food.angle-Math.PI/2,s.ang+Math.PI]) {
          D.plan={mode:'scavenge',target:{x:food.x,y:food.y},exit_angle:exitAngle,boost:false,boost_when_aligned:accelerate};D.arrived=false;
          const path=assess(food.angle,normalSpeed,true,28);
          const utility=food.value/(Math.max(.085,path.arrivalTime??10)+.35)*
            (food.contested?(path.arrivalTime<food.rivalEta?1.25:.6):1);
          if(path.arrivalTime!==null&&path.clearance>=25&&path.hardCollisionTime>2.3&&
              (!best||utility>best.utility||utility===best.utility&&path.clearance>best.path.clearance))best={food,path,exitAngle,accelerate,utility};
        }
        if(best&&(!pickup||best.utility>pickup.utility))pickup=best;
      }
      D.plan=base;D.arrived=wasArrived;
      if(pickup) {
        const food=pickup.food;
        D.plan={mode:pickup.accelerate?'collect_rich_food':'scavenge',target:{x:food.x,y:food.y},loot_anchor:{x:food.x,y:food.y},exit_angle:pickup.exitAngle,
          angle:food.angle,boost:false,boost_when_aligned:pickup.accelerate,plan_id:'local-rich:'+Math.round(food.x)+':'+Math.round(food.y),
          revision:++D.revision,local_loot:true,local_until:now+2200};
        D.updated=now;D.arrived=false;goal=food.angle;D.metrics.local_loot_entries++;
        D.record('local_loot_entry',{plan_id:D.plan.plan_id,target:D.plan.target,exit_angle:pickup.exitAngle,
          patch_value:food.value,clearance:pickup.path.clearance,accelerated_approach:pickup.accelerate,
          contested:food.contested,predicted_arrival_seconds:pickup.path.arrivalTime,
          predicted_rival_arrival_seconds:Number.isFinite(food.rivalEta)?food.rivalEta:null});
      }
    }
    if(['scavenge','collect_rich_food'].includes(D.plan.mode)&&D.plan.target) {
      const base=D.plan,anchor=base.loot_anchor||base.target;
      const consumed=(window.foods||[]).some(f=>f&&f.eaten&&Math.hypot(f.xx-base.target.x,f.yy-base.target.y)<18);
      if(D.arrived||consumed) {
        const candidates=(window.foods||[]).filter(f=>f&&!f.eaten&&f.sz>=6&&
          Math.hypot(f.xx-anchor.x,f.yy-anchor.y)<300&&Math.hypot(f.xx-sx,f.yy-sy)<240)
          .map(f=>({x:f.xx,y:f.yy,size:f.sz,distance:Math.hypot(f.xx-sx,f.yy-sy),angle:Math.atan2(f.yy-sy,f.xx-sx)}))
          .filter(f=>Math.abs(delta(f.angle,s.ang))<1.5&&f.distance>2*normalSpeed/turnRate*Math.sin(Math.min(Math.abs(delta(f.angle,s.ang)),Math.PI/2))+18)
          .sort((a,b)=>b.size/(b.distance+50)-a.size/(a.distance+50)).slice(0,6);
        let next=null;
        for(const food of candidates) {
          const race=foodRace(food);
          for(const accelerate of (race.contested&&food.distance>45?[true,false]:[false])) {
            D.plan={...base,target:{x:food.x,y:food.y},loot_anchor:anchor,boost:false,
              boost_when_aligned:accelerate,mode:accelerate?'collect_rich_food':'scavenge'};D.arrived=false;
            const check=assess(food.angle,normalSpeed,true,28);
            if(check.arrivalTime!==null&&check.clearance>=25&&check.collisionTime>=2.3){next=food;break;}
          }
          if(next)break;
        }
        if(next) {
          goal=next.angle;
          if(!preview)D.record('loot_follow_target',{plan_id:base.plan_id,death_event_id:base.death_event_id,target:D.plan.target,
            accelerated_approach:D.plan.boost_when_aligned});
        } else {D.plan=base;D.arrived=true;D.arrivalAngle=base.exit_angle??s.ang;goal=D.arrivalAngle;}
      }
    }
    if(!preview&&!D.plan.coil&&!D.plan.attack_intent&&!D.plan.local_loot&&s.sct>10&&
        !D.metrics.escape_required&&['forage','seek_action','survival_fallback'].includes(D.plan.mode)&&
        now-(D.lastAttackScan||0)>600) {
      D.lastAttackScan=now;
      const rivals=(window.slithers||[]).filter(o=>o!==s&&!o.dead&&
        Math.hypot(o.xx-sx,o.yy-sy)<450&&Math.abs(delta(o.wang??o.ang,o.ang))<.65)
        .sort((a,b)=>Math.hypot(a.xx-sx,a.yy-sy)-Math.hypot(b.xx-sx,b.yy-sy));
      if(rivals.length) {
        const rival=rivals[0];
        D.plan={mode:'hunt_position',attack_intent:true,local_attack:true,local_until:now+2800,
          enemy_id:rival.id,attack_started:now,angle:s.ang,boost:false,
          plan_id:'local-attack:'+rival.id+':'+Math.round(now),revision:++D.revision};
        D.updated=now;D.arrived=false;D.metrics.local_attack_entries++;
        D.record('local_attack_opportunity',{plan_id:D.plan.plan_id,enemy_id:rival.id});
      }
    }
    if(D.plan.attack_intent) {
      const base=D.plan,rival=(window.slithers||[]).find(o=>o.id===base.enemy_id&&!o.dead);
      if(!rival) {
        if(preview)return {can_follow:false,reason:'attack_target_missing'};
        D.plan={angle:s.ang,boost:false,mode:'survival_fallback'};goal=s.ang;
      } else {
        const ex=rival.xx+(rival.fx||0),ey=rival.yy+(rival.fy||0);
        const ux=Math.cos(rival.ang),uy=Math.sin(rival.ang),ev=rival.sp*31.25;
        const initialSide=(sx-ex)*(-uy)+(sy-ey)*ux,side=initialSide>0?1:-1;
        let best=null,bestScore=-Infinity;
        const consider=p=>{
          D.plan=p;D.arrived=false;
          const heading=Math.atan2(p.target.y-sy,p.target.x-sx);
          const check=assess(heading,p.boost?maxSpeed:normalSpeed,true);
          if(check.clearance>=25&&check.collisionTime>=1.25) {
            const score=(p.attack_stage==='position'?-1000:0)-Math.abs(delta(heading,s.ang))*50
              -Math.abs((p.arrival_advantage||.45)-.45)*100;
            if(score>bestScore){best=p;bestScore=score;}
          }
        };
        const locked=D.lockedAttack;
        if(locked&&locked.enemy_id===base.enemy_id&&now<locked.until&&Math.hypot(locked.target.x-sx,locked.target.y-sy)>ownR+25)
          consider({...base,...locked,mode:'cut_ahead',boost:true,boost_when_aligned:false,attack_stage:'cross'});
        if(!best&&Math.abs(initialSide)>ownR+14.5*rival.sc+25&&Math.abs(delta(rival.wang??rival.ang,rival.ang))<.45) {
          for(const lead of [.75,1,1.25,1.5,1.8,2,2.3]) {
            const target={x:ex+ux*ev*lead+side*uy*110,y:ey+uy*ev*lead-side*ux*110};
            const heading=Math.atan2(target.y-sy,target.x-sx);
            if(Math.abs(delta(heading,s.ang))>1.05)continue;
            let x=sx,y=sy,a=s.ang,crossing=null;
            for(let i=1;i<=60;i++) {
              const desired=Math.atan2(target.y-y,target.x-x);
              const v=Math.abs(delta(desired,a))<.45&&now+i*50>=D.cooldown?maxSpeed:normalSpeed;
              a+=Math.max(-turnRate*.05,Math.min(turnRate*.05,delta(desired,a)));
              x+=Math.cos(a)*v*.05;y+=Math.sin(a)*v*.05;
              if(((x-ex)*(-uy)+(y-ey)*ux)*initialSide<=0) {
                const along=(x-ex)*ux+(y-ey)*uy,advantage=along/Math.max(1,ev)-i*.05;
                if(along>0&&advantage>.25&&advantage<1.2)crossing={x,y,advantage};
                break;
              }
            }
            if(!crossing)continue;
            const ready=Math.abs(delta(heading,s.ang))<.45&&now>=D.cooldown;
            consider({...base,mode:'cut_ahead',target,angle:heading,boost:ready,boost_when_aligned:!ready,
              attack_stage:ready?'cross':'align',arrival_advantage:crossing.advantage,
              crossing_axis:{x:ex,y:ey,ux,uy},crossing_side:side});
          }
        }
        // If the exact gap closed during the API call, hold a safe parallel
        // position beside the same chosen rival and look again next input tick.
        if(!best) {
          const margin=ownR+14.5*rival.sc+85;
          const target={x:ex+ux*ev*.6-side*uy*margin,y:ey+uy*ev*.6+side*ux*margin};
          const behind=-((sx-ex)*ux+(sy-ey)*uy);
          const catchup=behind>80&&maxSpeed>ev*1.15&&(behind-60)/(maxSpeed-ev)<=2.5&&
            Math.hypot(sx-ex,sy-ey)<700&&Math.abs(delta(s.ang,rival.ang))<.55&&
            Math.abs(delta(rival.wang??rival.ang,rival.ang))<.45&&
            Math.abs(initialSide)>ownR+14.5*rival.sc+25;
          // Parallel prey at the same normal speed cannot be caught by normal
          // pursuit. Spend bounded boost only when it can close this real gap.
          if(catchup)consider({...base,mode:'hunt_position',target,boost:false,
            boost_when_aligned:true,attack_stage:'position',catchup:true});
          if(!best)consider({...base,mode:'hunt_position',target,boost:false,
            boost_when_aligned:false,attack_stage:'position',catchup:false});
        }
        if(!best) {
          D.plan=base;
          if(preview)return {can_follow:false,reason:'no_safe_intercept_or_staging'};
          D.plan={angle:s.ang,boost:false,mode:'survival_fallback'};goal=s.ang;
        } else {
          D.plan=best;D.arrived=false;goal=Math.atan2(best.target.y-sy,best.target.x-sx);
          if(!preview&&best.attack_stage==='cross'&&(!locked||locked.enemy_id!==best.enemy_id||now>=locked.until))
            D.lockedAttack={enemy_id:best.enemy_id,target:best.target,crossing_axis:best.crossing_axis,
              crossing_side:best.crossing_side,arrival_advantage:best.arrival_advantage,until:now+1600};
        }
      }
    }
    // Evaluate the requested speed first: a crossing may be safe with boost
    // but unsafe at walking speed. Never veto the boost using that slower path.
    const wantsBoost=!!(D.plan.boost||D.plan.boost_when_aligned)&&!D.arrived&&now>=D.cooldown&&s.sct>6
      &&Math.abs(delta(goal,s.ang))<.5;
    const regular=assess(goal,wantsBoost?maxSpeed:Math.max(normalSpeed,speed),true);
    let chosen=regular,override=false;
    if(regular.collisionTime<1.25||regular.clearance<(D.plan.coil?30:rewardIntent(D.plan)?25:45)) {
      const angles=[goal,s.ang,D.escapeAngle,...[-2.8,-2.1,-1.55,-1.1,-.65,-.3,0,.3,.65,1.1,1.55,2.1,2.8].map(d=>s.ang+d)];
      const choices=angles.map(a=>assess(a,Math.max(speed,normalSpeed)));
      function utility(o) {
        const collisionPenalty=o.collisionTime<2 ? -3000+o.collisionTime*1000 : 0;
        return collisionPenalty+Math.min(180,o.clearance)*2-Math.abs(delta(o.angle,goal))*13
          +(now-D.lastEscape<500 ? 35*Math.cos(delta(o.angle,D.escapeAngle)) : 0);
      }
      choices.sort((a,b)=>utility(b)-utility(a));
      if(utility(choices[0])>utility(regular)+10) {
        chosen=choices[0];override=true;
        if(now-D.lastEscape>150) D.metrics.emergency_turns++;
        D.lastEscape=now;D.escapeAngle=chosen.angle;
      }
    }
    let boost=wantsBoost&&!override;
    if(boost) {
      const fast=assess(chosen.angle,maxSpeed,true);
      if(fast.collisionTime<1||fast.clearance<25) {boost=false;D.metrics.boost_vetoes++;} else chosen=fast;
    }
    // Look through the opening and outside a potential ring, rather than merely
    // away from its moving head. Fast paths cover ~900 units in this horizon;
    // short normal-speed paths can look safe while staying inside a closing ring.
    let fieldCache=D.escapeField;
    if(!fieldCache||now-fieldCache.t>=250||Math.hypot(sx-fieldCache.sx,sy-fieldCache.sy)>60) {
      fieldCache={t:now,sx,sy,field:escapeConnectivityV16({sx,sy,ownR,obstacles,
        extent:Math.min(1000,(window.flux_grd||window.grd*.98)*.45),
        arena:{cx:window.grd,cy:window.grd,radius:window.flux_grd||window.grd*.98}})};
      D.escapeField=fieldCache;
    }
    const field=fieldCache.field;
    let topology=D.topology;
    if(!topology||now-topology.t>=125||Math.hypot(sx-topology.sx,sy-topology.sy)>60) {
      const count=24,step=Math.PI*2/count;
      const routes=Array.from({length:count},(_,i)=>assess(s.ang-Math.PI+i*step,maxSpeed,false,28,true));
      const open=routes.map(p=>p.hardClearance>12&&p.clearance>0&&p.hardCollisionTime>2.3&&field.endpoint(p.x,p.y).followsExit);
      let longest=0,span=0;
      for(let i=0;i<count*2;i++){span=open[i%count]?Math.min(count,span+1):0;longest=Math.max(longest,span);}
      for(let i=0;i<count;i++) {
        let local=open[i]?1:0;
        for(const sign of [-1,1])for(let j=1;j<count&&open[(i+sign*j+count*2)%count];j++)local++;
        routes[i].width=Math.min(count,local)*step;
        routes[i].followsExit=open[i];
      }
      if(field.connected&&Number.isFinite(field.angle)) {
        const exact=assess(field.angle,maxSpeed,false,28,true);
        exact.followsExit=exact.hardClearance>12&&exact.clearance>0&&exact.hardCollisionTime>2.3&&field.endpoint(exact.x,exact.y).followsExit;
        exact.width=longest?longest*step:step/2;routes.push(exact);
      }
      topology={t:now,sx,sy,routes,exit_count:open.filter(Boolean).length,exit_width:longest*step};
      if(!topology.exit_count&&routes[count]?.followsExit){topology.exit_count=1;topology.exit_width=step/2;}
      D.topology=topology;
    }
    const viable=topology.routes.filter(p=>p.followsExit&&p.hardClearance>12&&p.clearance>0&&p.hardCollisionTime>2.3);
    const routeUtility=p=>Math.min(200,p.hardClearance)+Math.min(2,p.width)*85+
      Math.min(1.5,p.closingMargin)*55-Math.abs(delta(p.angle,s.ang))*25+
      (D.metrics.escape_required?70*Math.cos(delta(p.angle,D.escapeAngle)):15*Math.cos(delta(p.angle,goal)));
    viable.sort((a,b)=>routeUtility(b)-routeUtility(a));
    const exit=viable[0];
    const racingThreat=heads.some(h=>h.fast&&h.closing&&h.catchTime<2.4)&&
      assess(goal,normalSpeed,true,28).hardCollisionTime<2.38;
    const surrounded=topology.exit_width<1.85&&maxCoverage>=8;
    const earlyWrap=!!liveThreat;
    // Exit samples depend on our heading. Turning around a small prey can
    // reduce their angular width even though no opponent is closing the gate.
    // Require enclosing body geometry or an actually advancing rival before
    // treating that sampling change as a reason to abandon the current tactic.
    const narrowing=D.previousExits&&now-D.previousExits.t<800&&
      topology.exit_width<D.previousExits.width-.35&&
      (maxCoverage>=8||heads.some(h=>h.velocity>normalSpeed*.5&&h.closing&&h.distance<650));
    const gateClosing=!!exit&&exit.closingMargin<.85;
    // Remembered pursuit or nearby bodies alone never justify a boost. A wrap
    // or pinch needs restricted reachable exits and a currently closing threat.
    const pinched=topology.exit_width<2.8&&(earlyWrap||gateClosing||narrowing||
      heads.filter(h=>h.closing&&h.distance<650).length>=2);
    const closingDanger=(heads.length>0||obstacles.length>0)&&(!field.connected||racingThreat||pinched||
      (maxCoverage>=8&&topology.exit_width<1.85)||(maxCoverage>=16&&topology.exit_width<2.8));
    // A nearby trail on a currently usable exit is an opportunity to collect
    // while leaving, not a reason to abandon that whole side of the arena.
    const lootPath=['scavenge','collect_rich_food'].includes(D.plan.mode)&&Number.isFinite(D.plan.exit_angle)
      ?assess(goal,wantsBoost?maxSpeed:normalSpeed,true,28):null;
    const collectingOut=!!lootPath&&topology.exit_count>0&&lootPath.clearance>=25&&lootPath.hardCollisionTime>2.3&&field.endpoint(lootPath.x,lootPath.y).followsExit;
    const danger=closingDanger&&!collectingOut;
    D.metrics.escape_required=danger;D.metrics.pursuit_active=danger;
    D.metrics.exit_count=topology.exit_count;D.metrics.exit_width=topology.exit_width;
    D.metrics.exit_angle=exit?.angle??chosen.angle;D.metrics.exit_clearance=exit?.hardClearance??chosen.hardClearance;
    D.metrics.closing_margin=exit?.closingMargin??0;
    D.metrics.exterior_connected=field.connected;D.metrics.exterior_status=field.status;
    if(!D.previousExits||now-D.previousExits.t>=500)D.previousExits={t:now,width:topology.exit_width};
    let escapeBoost=false;
    if(danger&&s.sct>6) {
      // Prefer an actual way out. If every full exit is blocked, buy time using
      // the longest collision-free path; never accelerate into an earlier hit.
      const fastChoices=exit?[assess(exit.angle,maxSpeed,false,28,true)]:
        [...topology.routes].sort((a,b)=>b.hardCollisionTime-a.hardCollisionTime||b.hardClearance-a.hardClearance)
          .slice(0,3).map(p=>assess(p.angle,maxSpeed));
      const safe=fastChoices.filter(p=>p.hardClearance>4&&p.hardCollisionTime>1.15||
        p.hardCollisionTime>.65&&p.hardCollisionTime>chosen.hardCollisionTime+.2);
      safe.sort((a,b)=>Math.min(2.38,b.hardCollisionTime)*500+Math.min(200,b.hardClearance)-Math.abs(delta(b.angle,D.escapeAngle))*10-
        (Math.min(2.38,a.hardCollisionTime)*500+Math.min(200,a.hardClearance)-Math.abs(delta(a.angle,D.escapeAngle))*10));
      if(safe.length&&(now>=D.cooldown||regular.hardCollisionTime<1)) {
        const chosenExit=safe[0];
        // Turn normally to enter the gap, then accelerate through it. Boosting
        // during a sharp reversal increases the turn radius and misses the gap.
        const aligned=Math.abs(delta(chosenExit.angle,s.ang))<.65;
        const entry=aligned?chosenExit:assess(chosenExit.angle,normalSpeed);
        if(entry.hardClearance>4||entry.hardCollisionTime>chosen.hardCollisionTime+.2) {
          chosen=entry;boost=aligned;override=true;escapeBoost=boost;
          D.escapeAngle=chosenExit.angle;
          if(exit)D.exitCommit={x:chosenExit.x,y:chosenExit.y,until:now+3500};
          if(boost&&!D.boost) {D.metrics.escape_boosts++;D.metrics.proactive_boosts++;}
        }
      }
    }
    // A head moving offscreen can briefly remove the warning before our tail
    // has left the ring. Finish the assessed exit instead of immediately
    // reversing for routine travel. This hold never causes acceleration.
    if(D.exitCommit&&(now>D.exitCommit.until||Math.hypot(sx-D.exitCommit.x,sy-D.exitCommit.y)<90))D.exitCommit=null;
    D.metrics.exit_commit_active=false;
    if(!danger&&D.exitCommit&&['forage','seek_action','survival_fallback','escape'].includes(D.plan.mode)) {
      const angle=Math.atan2(D.exitCommit.y-sy,D.exitCommit.x-sx);
      if(Math.cos(delta(chosen.angle,angle))<.25) {
        const continuation=assess(angle,normalSpeed,false,28);
        if(continuation.hardClearance>4&&continuation.hardCollisionTime>2.3) {
          chosen=continuation;boost=false;override=true;D.metrics.exit_commit_active=true;
          if(!preview&&D.last?.exitContinuation!==true)D.record('exit_continued',{target:D.exitCommit});
        }
      }
    }
    // No stale escape latch in empty space. Ordinary collection still uses
    // bounded bursts; a real closing gate is re-evaluated every input tick.
    if(!danger)D.escapeUntil=0;
    if(!escapeBoost&&D.boost&&now-D.boostSince>(D.plan.coil?2200:D.plan.mode==='cut_ahead'?1600:700)) boost=false;
    if(preview)return {can_follow:!override&&chosen.clearance>=(D.plan.coil?35:rewardIntent(D.plan)?25:65)&&chosen.collisionTime>=1.25&&(!D.plan.boost||boost),
      clearance:chosen.clearance,collisionTime:chosen.collisionTime,boost,override,
      resolved_target:D.plan.target,attack_stage:D.plan.attack_stage};
    // Compensate for the game's free-camera mouse origin when applicable.
    const ox=!window.follow_view ? (s.xx-window.view_xx)*window.gsc : 0;
    const oy=!window.follow_view ? (s.yy-window.view_yy)*window.gsc : 0;
    const radius=Math.min(innerWidth,innerHeight)*.32;
    const x=innerWidth/2+ox+radius*Math.cos(chosen.angle),y=innerHeight/2+oy+radius*Math.sin(chosen.angle);
    window.dispatchEvent(new MouseEvent('mousemove',{clientX:x,clientY:y,bubbles:true}));
    D.setBoost(boost,x,y);
    if(D.plan.mode==='cut_ahead'&&boost&&!override&&D.last?.boost!==true)
      D.record('attack_boost',{plan_id:D.plan.plan_id,enemy_id:D.plan.enemy_id});
    if(D.plan.catchup&&D.plan.attack_stage==='position'&&boost&&!override&&D.last?.boost!==true)
      D.record('catchup_boost',{plan_id:D.plan.plan_id,enemy_id:D.plan.enemy_id});
    if(D.plan.mode==='cut_ahead'&&D.plan.crossing_axis&&!override) {
      const axis=D.plan.crossing_axis,key=D.plan.plan_id+':'+D.plan.attack_started;
      const side=(sx-axis.x)*(-axis.uy)+(sy-axis.y)*axis.ux;
      const rival=(window.slithers||[]).find(o=>o.id===D.plan.enemy_id&&!o.dead);
      const ahead=rival?(sx-rival.xx)*axis.ux+(sy-rival.yy)*axis.uy:-Infinity;
      if(side*D.plan.crossing_side<=0&&ahead>ownR+14.5*rival?.sc&&D.crossedKey!==key) {
        D.crossedKey=key;D.record('cut_ahead_axis_crossed',{plan_id:D.plan.plan_id,
          enemy_id:D.plan.enemy_id,ahead_distance:ahead,boost});
      }
    }
    if(D.plan.revision&&D.firstInputRevision!==D.plan.revision) {
      D.firstInputRevision=D.plan.revision;
      D.record('input_issued',{plan_id:D.plan.plan_id,revision:D.plan.revision,requested_mode:D.plan.mode,
        effective_mode:override?'survival_escape':D.plan.mode,angle:chosen.angle,boost,override,
        attack_stage:D.plan.attack_stage,coil_stage:D.plan.coil?.stage,death_event_id:D.plan.death_event_id});
    }
    if(!override&&D.plan.mode!=='survival_fallback')D.followSeconds+=dt;
    const status=override?'interrupted':'following';
    const statusKey=JSON.stringify([D.plan.plan_id,D.plan.revision,status]);
    if(statusKey!==D.statusKey) {
      D.statusKey=statusKey;D.record(status,{plan_id:D.plan.plan_id,revision:D.plan.revision,
        requested_mode:D.plan.mode,effective_mode:override?'survival_escape':D.plan.mode});
    }
    D.last={plan_id:D.plan.plan_id,revision:D.plan.revision,requested_mode:D.plan.mode,effective_mode:override?'survival_escape':D.plan.mode,override,clearance:chosen.clearance,collisionTime:chosen.collisionTime,boost,escapeBoost,racingThreat,surrounded,earlyWrap,hardClearance:chosen.hardClearance,angle:chosen.angle,exitContinuation:D.metrics.exit_commit_active};
    D.metrics.last_tick_ms=performance.now()-now;
    D.metrics.max_tick_ms=Math.max(D.metrics.max_tick_ms||0,D.metrics.last_tick_ms);
  }
  C.preview=plans=>{
    let topology=C.topology,escapeField=C.escapeField;
    return plans.map(plan=>{
      const scratch={...C,topology,escapeField,metrics:{...C.metrics},events:[],plan,
        updated:performance.now(),arrived:JSON.stringify(plan.target)===JSON.stringify(C.plan?.target)?C.arrived:false,
        escapeUntil:plan.coil||plan.attack_intent||plan.mode==='cut_ahead'?0:C.escapeUntil};
      const result=tick(scratch,true);topology=scratch.topology;escapeField=scratch.escapeField;return result;
    });
  };
  C.commit=plan=>{
    if(!window.playing||!window.slither||window.slither.dead||plan.life_id!==window.slither.id)
      return {accepted:false,reason:'different_life'};
    const check=C.preview([plan])[0];
    if(!check.can_follow){C.record('rejected',{plan_id:plan.plan_id,check});return {accepted:false,reason:'execution_check',check};}
    return C.setPlan(plan);
  };
  C.timer=setInterval(tick,50);
  window.__jevReflex=C;
  return true;
})()
