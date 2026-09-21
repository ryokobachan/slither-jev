(() => {
  // Read-only adapter for the observed slither.com client game1107249518.js.
  const text = document.body.innerText;
  const s = window.slither;
  // The client rewrites every killed snake's id to -1234. Keep identity in
  // our own WeakMap; never write identifiers or other fields on game objects.
  const tracking=window.__jevObservedIdentities||(window.__jevObservedIdentities={objects:new WeakMap(),next:0});
  for(const o of window.slithers||[]) {
    if(!tracking.objects.has(o))tracking.objects.set(o,{token:++tracking.next,id:o.id});
    if(!o.dead)tracking.objects.get(o).id=o.id;
  }
  const live = !!(window.playing && s && !s.dead);
  const stats = {
    length: Number(text.match(/Your length:\s*([\d,]+)/)?.[1]?.replaceAll(',', '')) || null,
    rank: Number(text.match(/Your rank:\s*(\d+)/)?.[1]) || null,
    players: Number(text.match(/Your rank:\s*\d+\s*of\s*(\d+)/)?.[1]) || null,
    final_length: Number(text.match(/Your final length was\s*([\d,]+)/)?.[1]?.replaceAll(',', '')) || null,
  };
  const result = {live, stats, width:innerWidth, height:innerHeight, timestamp:Date.now(),
    nickname:window.my_nick || document.querySelector('#nick')?.value || '',
    leaderboard:{names:Array.from(window.lbn?.querySelectorAll('span')||[],e=>e.innerText.trim()),
      scores:Array.from(window.lbs?.querySelectorAll('span')||[],e=>e.innerText.trim())},
    reflex:window.__jevReflex ? {...window.__jevReflex.metrics,last:window.__jevReflex.last,active_plan:window.__jevReflex.plan,follow_seconds:window.__jevReflex.followSeconds} : null};
  if (!live) return result;
  // The HUD can briefly show the previous life's length immediately after respawn.
  // Use the game's own scoring formula for per-life growth, keeping HUD stats separate.
  const count = s.sct + s.rsc;
  result.client_length = Math.floor((window.fpsls[count] + s.fam / window.fmlts[count] - 1)*15 - 5);
  const x = s.xx + (s.fx || 0), y = s.yy + (s.fy || 0);
  const visible = (px, py) => Math.abs((px - window.view_xx) * window.gsc) < innerWidth / 2 &&
    Math.abs((py - window.view_yy) * window.gsc) < innerHeight / 2;
  const near = (px, py) => visible(px, py); // Entire visible viewport, not a fixed 800-unit crop.
  const body = (o, own=false) => {
    const raw=(o.pts||[]).map((p,index)=>({index,dying:p.dying,p:[p.xx+(p.fx||0),p.yy+(p.fy||0)]}));
    const points=raw.filter(v=>!v.dying).map(v=>v.p);
    const head=[o.xx+(o.fx||0),o.yy+(o.fy||0)];
    const path=[...raw,{index:raw.length,p:head}],segments=[];
    // Preserve original adjacency; clipping must never connect unrelated runs.
    for(let i=1;i<path.length;i++) {
      const a=path[i-1],b=path[i];
      if(!a.dying&&!b.dying&&Math.hypot(a.p[0]-b.p[0],a.p[1]-b.p[1])<=100)
        segments.push([a.p,b.p]);
    }
    const intersects=([a,b])=>Math.max(a[0],b[0])>=window.view_xx-innerWidth/2/window.gsc&&
      Math.min(a[0],b[0])<=window.view_xx+innerWidth/2/window.gsc&&
      Math.max(a[1],b[1])>=window.view_yy-innerHeight/2/window.gsc&&
      Math.min(a[1],b[1])<=window.view_yy+innerHeight/2/window.gsc;
    return {points:own?points:points.filter(p=>near(...p)),segments:own?segments:segments.filter(intersects),
      body_complete:Number.isFinite(o.sct)&&points.length>=o.sct&&points.length>=4&&
        (own||[...points,head].every(p=>near(...p)))&&segments.length===points.length,
      body_length:segments.reduce((sum,[a,b])=>sum+Math.hypot(a[0]-b[0],a[1]-b[1]),0)};
  };
  result.self = {...body(s,true),id:s.id, x, y, angle:s.ang, radius:14.5*s.sc, speed:s.sp*31.25,
    turn_radius:s.sp/(4*window.mamu*s.scang*s.spang),target_angle:s.eang,
    normal_speed:s.ssp*31.25,boost_speed:s.msp*31.25,boosting:!!s.md,server_kill_count:s.kill_count};
  result.arena = {cx:window.grd, cy:window.grd, radius:window.flux_grd || window.grd*.98};
  result.food = (window.foods || []).filter(f => f && !f.eaten && near(f.xx, f.yy))
    .map(f => ({id:f.id,x:f.xx, y:f.yy, size:f.sz}));
  result.eaten_food = (window.foods || []).filter(f => f && f.eaten && f.eaten_by===s)
    .map(f => ({id:f.id,x:f.xx,y:f.yy,size:f.sz}));
  result.dead_enemies = (window.slithers || []).filter(o => o!==s && o.dead)
    .map(o => ({id:tracking.objects.get(o).id,death_token:tracking.objects.get(o).token,...body(o),head:{x:o.xx+(o.fx||0),y:o.yy+(o.fy||0)}}))
    .filter(o => o.points.length || near(o.head.x,o.head.y));
  result.enemies = (window.slithers || []).filter(o => o !== s && !o.dead).map(o => ({
    ...body(o), id:o.id,
    head:{x:o.xx+(o.fx||0),y:o.yy+(o.fy||0)},
    angle:o.ang, target_angle:o.wang, turn_rate:window.mamu*o.scang*o.spang*125,
    speed:o.sp*31.25, radius:14.5*o.sc
  })).filter(o => o.points.length || o.segments.length || near(o.head.x,o.head.y));
  return result;
})()
