"""TypeSafe Jev chooses tactical routes; a fast input-only loop handles safety.

Run from the task directory with work/.venv/bin/python outputs/play-slither-jev.py.
API key stays in Python. No Jev Ultrafast imports or code are used.
"""
import argparse
import base64
import json
import math
import os
from pathlib import Path
import shlex
import shutil
import signal
import statistics
import subprocess
import threading
import time

import httpx

os.environ.setdefault('BU_NAME', 'slither-jev')
from browser_harness.admin import ensure_daemon
from browser_harness.helpers import cdp, drain_events

ROOT = Path(__file__).resolve().parent.parent
OBSERVER = Path(__file__).with_name('observe-slither.js').read_text()
REFLEX = Path(__file__).with_name('slither-reflex.js').read_text()
API = 'https://ai-gateway.vercel.sh/typesafe/v1/systemone'
MODEL = 'typesafe-ai/jev'
MIN_REQUEST_INTERVAL = 2.3  # Gateway response advertises 30 requests/minute.
PLAYER_NAME = 'jev.bot'
REWARD_CLEARANCE = 25.  # User opted into closer profitable attacks and collection.
REWARD_CLOSING_MARGIN = .25


def reward_intent(route):
    return bool(route.get('attack_intent') or route.get('mode') in
                ('scavenge','collect_rich_food','cut_ahead'))


def key_from_env():
    values = {}
    names = ('AI_GATEWAY_API_KEY', 'VERCEL_API_KEY')
    for source in (Path.home() / '.codex/.env', ROOT / '.env'):
        if not source.exists():
            continue
        for line in source.read_text().splitlines():
            name, sep, value = line.strip().removeprefix('export ').partition('=')
            if sep and name.strip() in names:
                values[name.strip()] = ' '.join(shlex.split(value, comments=True))
    values.update({k: os.environ[k] for k in names if os.environ.get(k)})
    key = values.get('AI_GATEWAY_API_KEY') or values.get('VERCEL_API_KEY')
    if not key:
        raise RuntimeError('Vercel AI Gateway key is not configured')
    return key


def angle_delta(a, b):
    return (a - b + math.pi) % (2 * math.pi) - math.pi


def segment_distance(x, y, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    denom = dx*dx + dy*dy
    t = max(0, min(1, ((x-a[0])*dx+(y-a[1])*dy)/denom)) if denom else 0
    return math.hypot(x-a[0]-t*dx, y-a[1]-t*dy)


def food_patch_values(foods):
    """Local pellet-value proxy; a rich patch is not proof of a specific kill."""
    cells={}
    for f in foods:
        cells.setdefault((int(f['x']//80),int(f['y']//80)),[]).append(f)
    values={}
    for f in foods:
        cx,cy=int(f['x']//80),int(f['y']//80)
        nearby=(g for dx in (-1,0,1) for dy in (-1,0,1) for g in cells.get((cx+dx,cy+dy),[]))
        values[(f['x'],f['y'])]=sum(max(1,g['size']) for g in nearby
            if math.hypot(g['x']-f['x'],g['y']-f['y'])<80)
    return values


def loot_context(state,target,velocity):
    me=state['self'];own_eta=math.hypot(target['x']-me['x'],target['y']-me['y'])/max(1,velocity)
    own_eta+=abs(angle_delta(math.atan2(target['y']-me['y'],target['x']-me['x']),me['angle']))*me.get('turn_radius',55)/max(1,me['speed'])
    competitors=0;head_on=False;closest=10000
    for enemy in state['enemies']:
        dx,dy=target['x']-enemy['head']['x'],target['y']-enemy['head']['y']
        distance=math.hypot(dx,dy);closest=min(closest,distance)
        aiming=dx*math.cos(enemy['angle'])+dy*math.sin(enemy['angle'])>distance*.5
        if distance<350 and aiming:
            competitors+=1
            # A rival near the far end does not own an entire food trail. Reject
            # this entry only when its swept path reaches the same portion.
            hx=enemy['head']['x']+math.cos(enemy['angle'])*enemy['speed']*(own_eta+.35)
            hy=enemy['head']['y']+math.sin(enemy['angle'])*enemy['speed']*(own_eta+.35)
            if segment_distance(target['x'],target['y'],[enemy['head']['x'],enemy['head']['y']],[hx,hy])<me['radius']+enemy['radius']+55:
                head_on=True
    return {'contesting_heads':competitors,'loot_conflict':head_on,'nearest_head_to_food':round(closest)}


class LootTracker:
    """Retain visible death trails and server-observed consumption, without
    equating a disappearing rival with a kill by this player."""
    def __init__(self):
        self.life=None;self.trails={};self.seen=set();self.eaten=set()
        self.eaten_count=0;self.death_food_count=0

    def update(self,state):
        if not state.get('live'):return state
        life=state['self']['id'];now=state['timestamp']
        if life!=self.life:
            self.__init__();self.life=life
        for enemy in state.get('dead_enemies',[]):
            death_identity=enemy.get('death_token',enemy['id'])
            if death_identity not in self.seen:
                self.seen.add(death_identity)
                points=enemy.get('points',[])+[[enemy['head']['x'],enemy['head']['y']]]
                self.trails[death_identity]={'t':now,'points':points}
        self.trails={k:v for k,v in self.trails.items() if now-v['t']<12000}
        # Spatial cells bound the cost even when several long snakes die nearby.
        cells={}
        for identity,trail in self.trails.items():
            for x,y in trail['points']:
                cells.setdefault((int(x//80),int(y//80)),[]).append((x,y,identity))
        def tag(food):
            x,y=food['x'],food['y'];cx,cy=int(x//80),int(y//80)
            near=(p for dx in (-1,0,1) for dy in (-1,0,1) for p in cells.get((cx+dx,cy+dy),[]))
            closest=min(near,key=lambda p:math.hypot(p[0]-x,p[1]-y),default=None)
            if closest and math.hypot(closest[0]-x,closest[1]-y)<65:
                food['death_event_id']=closest[2]
                food['death_age_ms']=now-self.trails[closest[2]]['t']
        for food in state.get('food',[]):tag(food)
        for food in state.get('eaten_food',[]):
            identity=(food.get('id'),food['x'],food['y'])
            if identity in self.eaten:continue
            self.eaten.add(identity);self.eaten_count+=1;tag(food)
            if 'death_event_id' in food:self.death_food_count+=1
        state['tactical_observations']={'visible_deaths':len(self.seen),'eaten_pellets':self.eaten_count,
            'eaten_near_observed_death_trails':self.death_food_count,'active_death_trails':len(self.trails)}
        return state


def body_segments(enemy):
    if 'segments' in enemy:
        return enemy['segments']+[(p,p) for p in enemy['points']]+[([enemy['head']['x'],enemy['head']['y']],[enemy['head']['x'],enemy['head']['y']])]
    points = enemy['points'] + [[enemy['head']['x'], enemy['head']['y']]]
    return [(a if math.dist(a, b) <= 100 else b, b)
            for a, b in zip(points, points[1:])] + [(p, p) for p in points]


def reachable_exits(state, x, y, heading, *, start_time=0., preferred_angle=None,
                    clearance=65., distance=None, min_margin=.35):
    """Forecast turn-limited exits, including the trail laid before our arrival.

    Angles are world radians, widths are radians and closing margins are seconds.
    An occupied bearing alone is not a closure: the complete reachable curve must
    be checked. These are trajectory forecasts, not proof of an enemy's intent.
    """
    me=state['self'];speed=max(1,me.get('normal_speed',me['speed']))
    rate=max(.1,me['speed']/max(20,me.get('turn_radius',55)))
    distance=distance or max(300,speed*2.38)
    steps=max(16,math.ceil(distance/15));step=distance/steps
    arena=state['arena'];count=16;sector=2*math.pi/count
    segments=[(a,b,me['radius']+e['radius']+18)
              for e in state['enemies'] for a,b in body_segments(e)
              if segment_distance(x,y,a,b)<distance+me['radius']+e['radius']+100]
    forecasts=[]
    for enemy in state['enemies']:
        # Sample bounded turns toward the currently observed target heading.
        ex,ey=enemy['head']['x'],enemy['head']['y'];ea=enemy['angle']
        ev=enemy['speed'];er=max(.1,enemy.get('turn_rate',2.5))
        path=[(0.,ex,ey)];horizon=start_time+distance/speed+2
        for j in range(1,math.ceil(horizon/.1)+1):
            ea+=max(-er*.1,min(er*.1,angle_delta(enemy.get('target_angle',ea),ea)))
            ex+=math.cos(ea)*ev*.1;ey+=math.sin(ea)*ev*.1
            path.append((j*.1,ex,ey))
        forecasts.append((path,me['radius']+enemy['radius']+20))
    routes=[]
    for i in range(count):
        angle=heading+(i-count//2)*sector;px,py,a=x,y,heading
        gap=800.;margin=math.inf
        for j in range(1,steps+1):
            a+=max(-rate*step/speed,min(rate*step/speed,angle_delta(angle,a)))
            px+=math.cos(a)*step;py+=math.sin(a)*step
            arrival=start_time+j*step/speed
            gap=min(gap,arena['radius']-math.hypot(px-arena['cx'],py-arena['cy'])-me['radius'])
            for p,q,r in segments:gap=min(gap,segment_distance(px,py,p,q)-r)
            for path,radius in forecasts:
                for (t0,ax,ay),(t1,bx,by) in zip(path,path[1:]):
                    d=segment_distance(px,py,[ax,ay],[bx,by])
                    if t0<=arrival:
                        gap=min(gap,d-radius-min(55,arrival*20))
                    if d<radius+clearance:
                        # Time until this usable corridor is cut by that head.
                        margin=min(margin,t0-arrival)
            if gap<clearance:break
        routes.append({'angle':angle,'clearance':gap,'closing_margin':margin,
                       'reachable':gap>=clearance and margin>min_margin})
    available=[r for r in routes if r['reachable']]
    longest=current=0
    for r in routes*2:
        current=min(count,current+1) if r['reachable'] else 0
        longest=max(longest,current)
    preferred_angle=heading if preferred_angle is None else preferred_angle
    best=max(available,key=lambda r:min(180,r['clearance'])
             +min(3,r['closing_margin'])*30-abs(angle_delta(r['angle'],preferred_angle))*40,default=None)
    return {'exit_count':len(available),'exit_width':round(longest*sector,4),
            'exit_angle':best['angle'] if best else None,
            'exit_clearance':round(best['clearance'],2) if best else None,
            'closing_margin':round(best['closing_margin'],3) if best and math.isfinite(best['closing_margin']) else None}


def food_exit_plan(state,target,boost=False,decision_delay=0.):
    """Reach the food with the actual turn limit, then assess a normal-speed exit."""
    me=state['self'];x,y,a=me['x'],me['y'],me['angle']
    normal=max(1,me.get('normal_speed',me['speed']))
    velocity=me.get('boost_speed',350) if boost else normal
    rate=max(.1,me['speed']/max(20,me.get('turn_radius',55)))
    arrival=0.;threshold=max(22,me['radius']+8)
    for _ in range(240):
        if math.hypot(target['x']-x,target['y']-y)<threshold:
            exits=reachable_exits(state,x,y,a,start_time=arrival,preferred_angle=a,
                                  clearance=REWARD_CLEARANCE,min_margin=REWARD_CLOSING_MARGIN)
            return {**exits,'exit_origin':{'x':x,'y':y},'food_arrival_seconds':round(arrival,3)}
        desired=me.get('target_angle',a) if arrival<decision_delay else math.atan2(target['y']-y,target['x']-x)
        a+=max(-rate*.05,min(rate*.05,angle_delta(desired,a)))
        x+=math.cos(a)*velocity*.05;y+=math.sin(a)*velocity*.05;arrival+=.05
    return {'exit_count':0,'exit_width':0.,'exit_angle':None,'exit_clearance':None,'closing_margin':None}


def enclosure_context(state):
    """Current closure risk; remembered pursuit and angular coverage are evidence only."""
    me = state['self']; largest = 0; threat = None; early = False
    for enemy in state['enemies']:
        if enemy.get('body_complete') and enemy.get('body_length',math.inf)<2*math.pi*max(me['radius']*3,me.get('turn_radius',55)*1.3):
            continue
        sectors = set()
        for a, b in body_segments(enemy):
            steps = max(1, math.ceil(math.dist(a, b)/20))
            for i in range(steps+1):
                x = a[0]+(b[0]-a[0])*i/steps-me['x']
                y = a[1]+(b[1]-a[1])*i/steps-me['y']
                if 40 < math.hypot(x, y) < 700:
                    sectors.add(int((math.atan2(y, x)+math.pi)*24/(2*math.pi)) % 24)
        hx,hy=enemy['head']['x']-me['x'],enemy['head']['y']-me['y']
        distance=math.hypot(hx,hy)
        radial=(hx*math.cos(enemy['angle'])+hy*math.sin(enemy['angle']))/max(1,distance)
        # A near-tangential head is laying an arc around us. Warn at about 75
        # degrees of body coverage, before a semicircle has already formed.
        wrapping=len(sectors)>=5 and 100<distance<650 and abs(radial)<.8
        early=early or wrapping
        if len(sectors) > largest:
            largest, threat = len(sectors), enemy.get('id')
    reflex=state.get('reflex') or {}
    held=bool(reflex.get('pursuit_remembered',reflex.get('pursuit_active')))
    if isinstance(reflex.get('escape_required'),bool):
        exits={k:reflex.get(k) for k in ('exit_count','exit_width','closing_margin','exit_angle','exit_clearance')}
        current=reflex['escape_required']
    else:
        # Escape viability uses physical room plus a small reaction margin.
        # Applying the elective 65-unit approach buffer here falsely declares
        # a trap whenever a harmless compact prey is already beside our body.
        # A wide visible arc may still be outside the short reaction horizon.
        # Reach beyond that near-body envelope; merely moving inside its hollow
        # center is not an exit through the surrounding body.
        exits=reachable_exits(state,me['x'],me['y'],me['angle'],clearance=15.,
                              distance=750 if largest>=5 else None)
        margin=exits['closing_margin']
        current=(exits['exit_count']==0
                 or (largest>=5 and exits['exit_width']<math.pi/3)
                 or (exits['exit_width']<math.pi/2 and margin is not None and margin<1.))
    return {'threat':current, 'early_wrap':early, 'memory_hold':held,
            'occupied_sectors':largest,'enemy_id':threat or reflex.get('pursuer_id'),**exits}


def coil_candidates(state, previous_route, enclosure):
    """Conservative opportunistic orbit: compact visible prey already beside us.

    This does not chase distant prey or assume that one revolution traps it.
    Observed own-body closure is required before gradual tightening.
    """
    me = state['self']; now = state.get('timestamp', 0)
    old = (previous_route or {}).get('coil')
    if enclosure['threat'] or not me.get('body_complete'):
        return []
    own_length = me.get('body_length', 0)
    candidates = []
    for enemy in state['enemies']:
        if old and enemy.get('id') != old['enemy_id']:
            continue
        if not enemy.get('body_complete') or enemy.get('body_length', own_length) > own_length*.4:
            continue
        points = enemy['points'] + [[enemy['head']['x'], enemy['head']['y']]]
        cx = (min(p[0] for p in points)+max(p[0] for p in points))/2
        cy = (min(p[1] for p in points)+max(p[1] for p in points))/2
        approaching=bool(old and old.get('stage')=='approach')
        if old:
            # Freeze the ring from commitment. Following a moving prey center
            # creates an endless approach rather than laying a closing body arc.
            cx,cy=old['cx'],old['cy']
            orbit_budget=max(20000,2*math.pi*old['radius']/max(1,me.get('normal_speed',me['speed']))*1800)
            if now-old.get('phase_started',old['started']) > (8000 if approaching else orbit_budget):
                continue
        spread = max(math.hypot(x-cx, y-cy) for x, y in points)
        minimum = max(me.get('turn_radius', 55)*1.4,
                      spread+me['radius']+enemy['radius']+18+(35 if old else 65))
        radius = old['radius'] if old else minimum+20
        # Do not enlarge the circle to pursue prey escaping our intended boundary.
        head_radius=math.hypot(enemy['head']['x']-cx,enemy['head']['y']-cy)
        # Reaching the inner rim is the intended trap, not evidence of escape.
        # Fresh trajectory collision checks still protect our own head.
        escaped=head_radius>radius+me['radius']+enemy['radius'] if old else minimum>radius
        if escaped or own_length < 2*math.pi*radius*1.25:
            continue
        radial = math.hypot(me['x']-cx, me['y']-cy)
        if radial < radius-60 or radial > radius+250:
            continue
        # Closure evidence: a continuous own-body path winding around the center,
        # whose distant part approaches the head. Never infer this from time alone.
        own = me.get('points', []) + [[me['x'], me['y']]]
        closed = False
        for i, point in enumerate(own[:-3]):
            path = own[i:]
            if math.dist(point, own[-1]) > me['radius']*1.5:
                continue
            if any(math.dist(a, b)>100 for a, b in zip(path, path[1:])):
                continue
            if any(math.hypot(x-cx,y-cy)<spread+enemy['radius'] for x,y in path):
                continue
            angles = [math.atan2(y-cy,x-cx) for x,y in path]
            winding = sum(angle_delta(b,a) for a,b in zip(angles,angles[1:]))
            if abs(winding) > 5.8:
                closed = True; break
        followed=(state.get('reflex') or {}).get('follow_seconds',0)
        prior_follow=old.get('follow_seconds',followed) if old else followed
        if old and closed and old.get('stage')=='tighten':
            radius=min(radius,max(minimum,radius-6*max(0,followed-prior_follow)))
        # Reject actual perimeter obstruction and approaching heads, instead of
        # any distant body point in a large disk around the prey.
        blocked = False
        for other in state['enemies']:
            if other.get('id') == enemy.get('id'):
                continue
            margin=other['radius']+me['radius']+70
            head=other['head'];future=[head['x']+math.cos(other['angle'])*other['speed'],head['y']+math.sin(other['angle'])*other['speed']]
            if (any(abs(math.hypot(x-cx,y-cy)-radius)<margin for x,y in other['points']) or
                segment_distance(cx,cy,[head['x'],head['y']],future)<radius+margin):
                blocked = True; break
        arena = state['arena']
        if blocked or math.hypot(cx-arena['cx'],cy-arena['cy'])+radius+me['radius']+100 > arena['radius']:
            continue
        bearing = math.atan2(me['y']-cy,me['x']-cx)
        directions = [old['direction']] if old else [-1,1]
        for direction in directions:
            tangent = bearing+direction*math.pi/2
            if not old and abs(angle_delta(orbit_heading(me['x'],me['y'],dict(cx=cx,cy=cy,radius=radius,direction=direction)),me['angle'])) > 1.2:
                continue
            stage='tighten' if closed else (old['stage'] if old and old['stage'] in ('close','tighten') else ('approach' if radial>radius+50 else 'close'))
            coil = dict(enemy_id=enemy['id'],cx=cx,cy=cy,radius=radius,direction=direction,
                        started=old['started'] if old else now,
                        stage=stage,phase_started=old.get('phase_started',old['started']) if old and old['stage']==stage else now,
                        follow_seconds=followed,closure_observed=closed)
            heading=orbit_heading(me['x'],me['y'],coil)
            candidates.append(dict(angle=heading,target=None,food_distance=None,mode='encircle',boost=False,coil=coil,coil_continuation=bool(old)))
            # Offer a burst only where boosted turning can still hold the ring.
            boosted_radius=me.get('turn_radius',55)*me.get('boost_speed',350)/max(1,me['speed'])
            escaping=(enemy['head']['x']-cx)*math.cos(enemy['angle'])+(enemy['head']['y']-cy)*math.sin(enemy['angle'])>0
            if stage in ('approach','close') and (escaping or stage=='approach') and radius>boosted_radius*1.3 and abs(angle_delta(heading,me['angle']))<.45:
                candidates.append(dict(angle=heading,target=None,food_distance=None,mode='encircle',boost=True,coil=coil,coil_continuation=bool(old)))
    return candidates


def orbit_heading(x, y, coil):
    bearing = math.atan2(y-coil['cy'], x-coil['cx'])
    distance = math.hypot(x-coil['cx'], y-coil['cy'])
    # Tangential field with radial correction; continuous, no waypoint orbit trap.
    correction = max(-1.1,min(1.1,math.atan2(2*(distance-coil['radius']),coil['radius'])))
    return bearing+coil['direction']*(math.pi/2+correction)


def crossing_evidence(me,enemy,target,delay):
    """Find where the turn-limited head actually crosses the enemy's axis.
    Adding an exit point changes the crossing; a straight-line ETA to the
    original aim point is not evidence that we get across first."""
    ex,ey=enemy['head']['x'],enemy['head']['y'];ux,uy=math.cos(enemy['angle']),math.sin(enemy['angle'])
    x,y,a=me['x'],me['y'],me['angle'];side=(x-ex)*(-uy)+(y-ey)*ux
    initial_side=side;rate=me['speed']/max(20,me.get('turn_radius',55));t=delay
    for _ in range(75):
        desired=math.atan2(target['y']-y,target['x']-x)
        velocity=me.get('boost_speed',350) if abs(angle_delta(desired,a))<.45 else me.get('normal_speed',me['speed'])
        a+=max(-rate*.04,min(rate*.04,angle_delta(desired,a)))
        x+=math.cos(a)*velocity*.04;y+=math.sin(a)*velocity*.04;t+=.04
        side=(x-ex)*(-uy)+(y-ey)*ux
        if side*initial_side<=0:
            along=(x-ex)*ux+(y-ey)*uy
            if along<=0:return None
            advantage=along/max(1,enemy['speed'])-t
            return {'arrival_advantage':round(advantage,3),'crossing_eta':round(t,3),
                    'crossing_point':{'x':x,'y':y},'crossing_side':1 if initial_side>0 else -1,
                    'crossing_axis':{'x':ex,'y':ey,'ux':ux,'uy':uy}}
    return None


def make_options(state, previous_route=None, decision_delay=.3):
    """Deterministic geometry supplies evidence, not the chosen action."""
    me = state['self']
    turn_radius = max(20, me.get('turn_radius',55))
    foods = sorted(state['food'], key=lambda f: math.hypot(f['x']-me['x'], f['y']-me['y']))
    enclosure = enclosure_context(state)
    candidates = []
    # Consider both close food and rich patches, so a nearby tiny pellet does
    # not hide a valuable trail elsewhere on screen.
    # Finish a committed crossing before choosing a new victim or an ordinary
    # pellet. Its current path is still rechecked by both collision gates.
    if previous_route and previous_route.get('mode')=='cut_ahead' and (previous_route.get('boost') or previous_route.get('boost_when_aligned')) and previous_route.get('target') and not enclosure['threat']:
        target=previous_route['target']
        remaining=math.hypot(target['x']-me['x'],target['y']-me['y'])
        age=state.get('timestamp',0)-previous_route.get('attack_started',-10000)
        if 0<=age<1600 and remaining>me['radius']+25 and any(e.get('id')==previous_route.get('enemy_id') for e in state['enemies']):
            candidates.append({**previous_route,'angle':math.atan2(target['y']-me['y'],target['x']-me['x']),
                               'attack_continuation':True,'food_distance':None})
    patch_values=food_patch_values(foods)
    enriched=[]
    for f in foods:
        value=patch_values[(f['x'],f['y'])]
        competition=loot_context(state,f,me['speed'])
        distance=math.hypot(f['x']-me['x'],f['y']-me['y'])
        merit=value/(80+distance)**1.35
        if 'death_event_id' in f:merit*=3
        merit/=1+.35*competition['contesting_heads']+5*competition['loot_conflict']
        enriched.append((merit,f))
    rich = [f for _,f in sorted(enriched,key=lambda item:item[0],reverse=True)]
    preferred = []
    if previous_route and previous_route.get('target'):
        target = previous_route['target']
        preferred = [f for f in foods if math.hypot(f['x']-target['x'],f['y']-target['y']) < 5][:1]
    death_edges=sorted((f for f in foods if 'death_event_id' in f),key=lambda f:math.hypot(f['x']-me['x'],f['y']-me['y']))
    ordered = death_edges[:2]+preferred+rich[:2]+[f for pair in zip(foods,rich) for f in pair]
    for f in ordered:
        dist = math.hypot(f['x']-me['x'], f['y']-me['y'])
        if dist < 14:
            continue
        a = math.atan2(f['y']-me['y'], f['x']-me['x'])
        patch_value=patch_values[(f['x'],f['y'])]
        is_rich=patch_value>=95 or ('death_event_id' in f and patch_value>=40)
        if abs(angle_delta(a, me['angle'])) > math.radians(180 if is_rich else 105):
            continue
        # Food inside the minimum turning circle causes endless orbiting.
        bearing = abs(angle_delta(a, me['angle']))
        if dist < 2*turn_radius*math.sin(min(bearing,math.pi/2))+18:
            continue
        if any(abs(angle_delta(a, c['angle'])) < (.07 if is_rich else .23) for c in candidates):
            continue
        candidates.append({'angle':a, 'target':dict(x=f['x'], y=f['y']), 'food_distance':round(dist),
                           'mode':'scavenge' if is_rich else 'forage','boost':False,'patch_value':round(patch_value),
                           'death_event_id':f.get('death_event_id'),'death_age_ms':f.get('death_age_ms')})
        if len(candidates) >= 16:
            break
    for deg in (0, -30, 30, -60, 60, -90, 90, -135, 135, 180):
        a = me['angle'] + math.radians(deg)
        candidates.append({'angle':a, 'target':None, 'food_distance':None,'mode':'escape','boost':False})

    if state.get('client_length',0) >= 100:
        for enemy in sorted(state['enemies'],key=lambda e:math.hypot(e['head']['x']-me['x'],e['head']['y']-me['y']))[:6]:
            ex,ey=enemy['head']['x'],enemy['head']['y']
            if math.hypot(ex-me['x'],ey-me['y']) > 550:
                continue
            ux,uy=math.cos(enemy['angle']),math.sin(enemy['angle'])
            side=1 if (me['x']-ex)*(-uy)+(me['y']-ey)*ux > 0 else -1
            # More crossing times cover parallel overtakes as well as diagonals.
            # Turning time is charged before considering an arrival advantage.
            if abs(angle_delta(enemy.get('target_angle',enemy['angle']),enemy['angle']))>.45:
                continue
            offered=0
            for lead in (1.5,1.8,2.,1.25,2.3,1.,.8):
                crossx,crossy=ex+ux*enemy['speed']*lead,ey+uy*enemy['speed']*lead
                distance=math.hypot(crossx-me['x'],crossy-me['y'])
                cross_angle=math.atan2(crossy-me['y'],crossx-me['x'])
                turn_time=abs(angle_delta(cross_angle,me['angle']))*turn_radius/max(1,me['speed'])
                arrival=distance/me.get('boost_speed',350)+.2+turn_time
                # Continue through the crossing, leaving our body across their path.
                target={'x':crossx+side*uy*100,'y':crossy-side*ux*100}
                a=math.atan2(target['y']-me['y'],target['x']-me['x'])
                if abs(angle_delta(a,me['angle'])) > 1.05:
                    continue
                crossing=crossing_evidence(me,enemy,target,decision_delay+.12)
                if not crossing or not REWARD_CLOSING_MARGIN<crossing['arrival_advantage']<1.5:continue
                boost=abs(angle_delta(a,me['angle']))<.45
                candidates.append({'angle':a,'target':target,'food_distance':None,
                    'mode':'cut_ahead','attack_intent':True,'boost':boost,'boost_when_aligned':not boost,**crossing,'attack_stage':'cross' if boost else 'align',
                    'enemy_id':enemy.get('id'),'attack_started':state.get('timestamp',0)})
                offered+=1
                if offered>=3:break

        for c in candidates[:8].copy():
            if c.get('mode') not in ('forage','scavenge') or not c['target'] or (c.get('food_distance') or 0)<160:
                continue
            target=c['target']
            density=c.get('patch_value',0)
            context=loot_context(state,target,me.get('boost_speed',350))
            if (density>=95 or c.get('death_event_id') is not None) and not context['loot_conflict']:
                candidates.append({**c,'boost':True,'mode':'collect_rich_food'})

    # Move beside a nearby rival to create a later cut-ahead opportunity. Do
    # not aim at its head, and evaluate these routes with the same collision gate.
    if state.get('client_length',0)>=200 and not enclosure['threat']:
        rivals=sorted(state['enemies'],key=lambda e:math.hypot(e['head']['x']-me['x'],e['head']['y']-me['y']))[:3]
        for enemy in rivals:
            ex,ey=enemy['head']['x'],enemy['head']['y']
            distance=math.hypot(ex-me['x'],ey-me['y'])
            if not 150<distance<700:continue
            ux,uy=math.cos(enemy['angle']),math.sin(enemy['angle'])
            margin=max(100,me['radius']+enemy['radius']+85)
            for side in (-1,1):
                target={'x':ex+ux*enemy['speed']*.8-side*uy*margin,
                        'y':ey+uy*enemy['speed']*.8+side*ux*margin}
                angle=math.atan2(target['y']-me['y'],target['x']-me['x'])
                if abs(angle_delta(angle,me['angle']))>1.2:continue
                candidates.append(dict(angle=angle,target=target,food_distance=None,
                    mode='hunt_position',boost=False,enemy_id=enemy.get('id'),
                    attack_intent=True,attack_stage='position',attack_started=state.get('timestamp',0)))
    candidates.extend(coil_candidates(state,previous_route,enclosure))
    # A local pellet follower can wander empty outskirts indefinitely. Move
    # toward the busier center when no heads are nearby, even after growing;
    # the ordinary collision and fresh execution gates remain authoritative.
    arena=state['arena'];distance_to_center=math.hypot(me['x']-arena['cx'],me['y']-arena['cy'])
    nearby_heads=sum(math.hypot(e['head']['x']-me['x'],e['head']['y']-me['y'])<650 for e in state['enemies'])
    if state.get('client_length',0)>=500 and distance_to_center>2000 and nearby_heads==0 and not enclosure['threat']:
        heading=math.atan2(arena['cy']-me['y'],arena['cx']-me['x'])
        candidates.append(dict(angle=heading,target={'x':me['x']+600*math.cos(heading),'y':me['y']+600*math.sin(heading)},
            food_distance=None,mode='seek_action',boost=False))
    if enclosure['threat']:
        candidates += [{**c,'boost':True} for c in candidates if c['mode']=='escape']
    segments = [(p,q,me['radius']+enemy['radius']+18)
                for enemy in state['enemies'] for p,q in body_segments(enemy)]
    arena = state['arena']
    exit_cache={}
    for i, c in enumerate(candidates):
        collecting=c.get('mode') in ('scavenge','collect_rich_food') and c.get('target')
        if collecting:
            key=(c['target']['x'],c['target']['y'],bool(c.get('boost')))
            if key not in exit_cache:
                exit_cache[key]=food_exit_plan(state,c['target'],c.get('boost',False),decision_delay)
            c.update(exit_cache[key])
        x, y, a = me['x'], me['y'], me['angle']
        clearance, danger_at, near_food = 800., None, 0.
        sampled_path = []
        reached = False
        # Releasing boost changes the intended speed. Do not predict an entire
        # normal-speed route at the speed of the previous escape burst.
        velocity = me.get('boost_speed',350) if c.get('boost') else me.get('normal_speed',me['speed'])
        route_turn_radius = turn_radius*velocity/max(me['speed'],1)
        delay_distance = me['speed'] * decision_delay
        horizon = max(300,round((me.get('boost_speed',350) if c.get('boost_when_aligned') else velocity)*1.4),min(750,(c.get('food_distance') or 0)+150))
        if enclosure['threat']: horizon=max(horizon,700)
        path_time=0
        for distance in range(10, horizon+1, 10):
            if distance <= delay_distance:
                desired = me.get('target_angle',me['angle'])
            elif c.get('coil'):
                desired = orbit_heading(x,y,c['coil'])
            elif c['target'] and not reached:
                desired = math.atan2(c['target']['y']-y, c['target']['x']-x)
            else:
                desired = c['exit_angle'] if reached and c.get('exit_angle') is not None else a if reached else c['angle']
            if reached and collecting:
                velocity=me.get('normal_speed',me['speed'])
                route_turn_radius=turn_radius*velocity/max(me['speed'],1)
            elif c.get('boost_when_aligned'):
                velocity=me.get('boost_speed',350) if abs(angle_delta(desired,a))<.45 else me.get('normal_speed',me['speed'])
                route_turn_radius=turn_radius*velocity/max(me['speed'],1)
            turn_limit = 10 / route_turn_radius
            a += max(-turn_limit, min(turn_limit, angle_delta(desired, a)))
            x += 10*math.cos(a)
            y += 10*math.sin(a)
            sampled_path.append((x,y))
            path_time+=10/max(velocity,1)
            clear = arena['radius']-math.hypot(x-arena['cx'],y-arena['cy'])-me['radius']
            for p,q,r in segments:
                clear = min(clear, segment_distance(x,y,p,q)-r)
            for enemy in state['enemies']:
                t = path_time
                hx = enemy['head']['x'] + math.cos(enemy['angle'])*enemy['speed']*t
                hy = enemy['head']['y'] + math.sin(enemy['angle'])*enemy['speed']*t
                # A moving head leaves a solid body behind. Checking only the
                # future head position misses collisions with that new trail.
                swept = segment_distance(x,y,[enemy['head']['x'],enemy['head']['y']],[hx,hy])
                uncertainty = min(55,enemy['speed']*t*.16)
                clear = min(clear, swept-me['radius']-enemy['radius']-20-uncertainty)
            clearance = min(clearance, clear)
            if clear < 0 and danger_at is None:
                danger_at = distance
            if c['target'] and math.hypot(x-c['target']['x'], y-c['target']['y']) < (max(22,me['radius']+8) if collecting else 15):
                # Rich food has a verified turn-limited exit. Ordinary pellets
                # retain the straight-ahead check and cannot mask a dead end.
                reached = True
        for f in foods:
            d = min(math.hypot(f['x']-px,f['y']-py) for px,py in sampled_path)
            if d < 25:
                near_food += max(1,f['size'])
        turn = round(math.degrees(angle_delta(c['angle'],me['angle'])))
        continuation = bool(previous_route and abs(angle_delta(c['angle'],previous_route['angle'])) < .35)
        c.update(id=f'route_{i}', turn_degrees=turn, clearance=round(clearance),
                 danger_distance=danger_at, food_value=round(near_food,1),continuation=continuation)
        c['required_clearance']=REWARD_CLEARANCE if reward_intent(c) else 35 if c.get('coil') else 65
        c['risk'] = 'collision predicted' if danger_at else 'close to danger' if clearance < c['required_clearance'] else 'clear'
        c['enclosure']=enclosure
        c['horizontal_visibility']=round(abs(math.cos(c['angle'])),2)
        if collecting:
            c.update(loot_context(state,c['target'],velocity))
            c['open_exit_sectors']=c['exit_count']
            c['loot_conflict']=c['loot_conflict'] or c['exit_count']==0

    return candidates


def admissible_options(options):
    """Known collision rules constrain the set before Jev makes its choice."""
    escaping=any(c.get('enclosure',{}).get('threat') for c in options)
    if escaping:
        exits=[c for c in options if c.get('mode')=='escape']
        # A general enclosure warning does not own every reachable food edge.
        # Let Jev choose a profitable exit-bearing detour alongside direct exits;
        # never turn this into a mandate to collect food inside a closing pocket.
        reward_exits=[c for c in options if c.get('mode') in ('scavenge','collect_rich_food')
                      and c.get('risk')=='clear' and c.get('exit_count',0)>=1
                      and not c.get('loot_conflict')
                      and (c.get('closing_margin') is None or c['closing_margin']>REWARD_CLOSING_MARGIN)]
        if exits: options=exits+reward_exits
    eligible=[c for c in options if not c.get('loot_conflict')]
    options=eligible or [c for c in options if c.get('target') is None] or options
    safe = [c for c in options if c['risk']=='clear']
    if safe:
        if escaping:return safe
        committed=[c for c in safe if c.get('attack_continuation')]
        if committed:return committed
        coiling=[c for c in safe if c.get('coil_continuation')]
        if coiling:
            closing=[c for c in coiling if c.get('boost') and c.get('coil',{}).get('stage')=='close']
            return closing or coiling
        fresh_loot=[c for c in safe if c.get('death_event_id') is not None]
        if fresh_loot:return fresh_loot
        attacks=[c for c in safe if c.get('mode') in ('encircle','cut_ahead')]
        if attacks:
            boosted_coils={(c['coil']['enemy_id'],c['coil']['direction']) for c in attacks
                           if c.get('boost') and c.get('coil',{}).get('stage')=='close'}
            attacks=[c for c in attacks if c.get('boost') or not c.get('coil') or
                     (c['coil']['enemy_id'],c['coil']['direction']) not in boosted_coils]
            return attacks+[c for c in safe if c.get('mode') in ('scavenge','collect_rich_food')]
        rich=[c for c in safe if c.get('mode') in ('scavenge','collect_rich_food')]
        if rich:return rich
        hunting=[c for c in safe if c.get('mode') in ('hunt_position','seek_action')]
        if hunting:return hunting
        return safe
    noncollision = [c for c in options if c['danger_distance'] is None]
    return noncollision or options


def request_body(state, options):
    descriptions = {}
    for c in options:
        descriptions[c['id']] = (
            f"Turn {c['turn_degrees']} degrees (negative=left, positive=right). "
            f"Path: {c['risk']}; obstacle clearance {c['clearance']} units; "
            f"collision distance {c['danger_distance']}; "
            f"food target distance {c['food_distance']}; food along route {c['food_value']}; "
            f"continues previous direction: {c.get('continuation',False)}; "
            f"tactic {c.get('mode','forage')}; boost {c.get('boost',False)}; "
            f"coil plan {c.get('coil')}; outer enclosure warning {c.get('enclosure')}; "
            f"cut-ahead arrival advantage {c.get('arrival_advantage',0)} seconds; "
            f"nearby food patch value {c.get('patch_value',0)}; contesting heads {c.get('contesting_heads',0)}; "
            f"observed death trail {c.get('death_event_id')}; attack phase {c.get('attack_stage')}; "
            f"reachable exits {c.get('exit_count','not_applicable')}; exit width {c.get('exit_width')} radians; "
            f"forecast closing margin {c.get('closing_margin')} seconds (None means no finite estimate); "
            f"horizontal visibility {c.get('horizontal_visibility',0)}."
        )
    return {'model':MODEL, 'state':{
        'game':'slither.io', 'goal':'Maximize expected score gained per second and rank. Target length 100 by 60 seconds, 1000 by 180 seconds, 5000 by 600 seconds, and 10000 by 900 seconds. Keep growing efficiently after rank 1 and after missed time targets.',
        'length':state.get('client_length',state['stats']['length']), 'speed_units_per_second':round(state['self']['speed']),
            'nearby_enemies':len(state['enemies']),'strategy_version':'attack-control-v20-efficient-pursuit',
        'growth_kpi':state.get('growth_kpi'),
        'rules':'The snake cannot stop. Touching another snake or the arena edge kills it. '
                'Food grows the snake. A rival dies if its head hits our body, releasing rich food. '
                'Boost costs length; use bursts for profitable rich food or a safe cut ahead, not tiny pellets. '
                'Negative turn means left; positive means right. '
                'Routes are computed from current visible objects; moving hazards can change.',
    }, 'questions':{
        'steering':{'type':'choice', 'instructions':
            'The user explicitly chooses aggressive risk-return play. Accept closer margins and a higher chance of death for kills and rich food; do not optimize survival time. '
            'Optimize expected score gained per second: prefer an immediate profitable pickup or decisive kill over fruitless prolonged pursuit. '
            'Growth targets are 100 points within 60 seconds, 1000 within 180, 5000 within 600, and 10000 within 900. These are performance goals, never stopping conditions; keep playing and pursuing reward after a missed target. '
            'Treat fresh rich food as an arrival-time race against rival heads. Use a reachable accelerated approach when it wins valuable food before competitors and the expected gain exceeds the boost cost; never boost through empty space without a payoff. '
            'Predicted physical collisions remain forbidden, but nearby enemies and a narrow usable exit are reasons to act precisely, not to retreat automatically. '
            'A cut_ahead align phase turns at normal speed first; cross phase accelerates through the enemy path. '
            'Fresh death-trail food should be entered from its reachable near edge, then collected along safe portions. '
            'Prefer clear encircle or cut_ahead attacks over routine foraging and empty exploration. '
            'hunt_position commits to one rival: approach beside it, then let the live controller take a safe boosted crossing when a gap opens. '
            'Actively take reachable rich scavenge patches even with nearby rivals; do not keep eating tiny pellets when a profitable patch is offered. '
            'Take an uncontested rich patch instead when its immediate reward is clearly better. '
            'A clear encircle route surrounds a compact smaller rival: prefer it over ordinary pellets, '
            'and continue an existing coil while safe. A rich uncontested food patch may be more profitable. '
            'Abandon prey when an exit is closing before we can reach it; remembered pursuit or a nearby body alone is not a command to flee. '
            'Coiling normally uses controlled turns; a supplied boosted close route has sufficient turning radius and can cut off escaping prey. Never assume closure or a kill from time alone. '
            'Prioritize uncontested rich scavenge patches '
            'with a reachable turn-limited exit over individual pellets or speculative attacks. '
            'Nearby rivals are acceptable when the entry and planned exit remain clear before their projected arrival. '
            'During an enclosure warning, an offered rich food route already has a usable exit; compare its reward against fleeing directly rather than rejecting it because of the warning alone. '
            'Do not race head-on along a dead snake food trail; take a safe portion and leave when contested. '
            'A clear cut_ahead '
            'with more than 0.25 seconds arrival advantage is an attack opportunity; prefer decisive crossings around 0.45 seconds when available. '
            'Use collect_rich_food boost for profitable approaches and contested parts of the trail, returning to normal speed when no rival is racing for that food. '
            'Keep taking clear attacks and profitable food at every score and rank, including after rank 1. '
            'Prefer room for the planned exit and enough time before an opponent cuts that exit. '
            'Among clear forage routes '
            'prefer more food along the route, then reachable close food. '
            'Prefer continuing the previous direction when its food and safety are comparable; '
            'do not alternate left and right without a clear safety or food advantage. '
            'When danger grows, choose a reachable exit with adequate width and closing margin; '
            'a spacious pocket inside a closing ring is not safety. '
            'Among routes that preserve an exit, pursue the best food and attack opportunity. '
            'If no forecast route avoids collision, choose the path that escapes the enclosing bodies earliest, '
            'then the latest collision time. '
            'A route with no food target is for exploration or escape, not a reason to stop.',
            'criteria':descriptions}
    }}


def refresh_coil_route(state,selected,committed):
    """Return the exact refreshed intent, computed once from committed state."""
    matches=[o for o in make_options(state,committed,decision_delay=0)
             if o.get('coil') and o['coil']['enemy_id']==selected['coil']['enemy_id']
             and o['coil']['direction']==selected['coil']['direction'] and o.get('boost')==selected.get('boost') and o['risk']=='clear']
    return {**matches[0],'id':selected['id']} if matches else None


def refresh_attack_route(state,selected,committed):
    """Keep Jev's chosen victim, but refresh interception after API latency."""
    if selected.get('attack_intent'):
        if enclosure_context(state)['threat'] or not any(e.get('id')==selected.get('enemy_id') for e in state['enemies']):
            return None
        # The 20Hz controller will calculate and validate the current crossing
        # during preview, commit, and every input tick. It cannot switch victims.
        return {**selected,'refreshed_in_reflex':True}
    matches=[o for o in make_options(state,committed,decision_delay=0)
             if o.get('mode')=='cut_ahead' and o.get('enemy_id')==selected.get('enemy_id')
             and o['risk']=='clear']
    if not matches:return None
    # Preserve an already committed crossing; otherwise choose the latest safe
    # intercept closest to the direction Jev selected, never a different victim.
    matches.sort(key=lambda o:(not o.get('attack_continuation',False),abs(angle_delta(o['angle'],selected['angle']))))
    return {**matches[0],'id':selected['id']}


def validated_choice(response, options):
    answer = response.get('answers',{}).get('steering',{})
    ids = {c['id'] for c in options}
    choice = answer.get('choice')
    confidence = answer.get('confidence')
    if answer.get('type') != 'choice' or choice not in ids:
        raise ValueError('Jev returned an invalid steering choice')
    if not isinstance(confidence,(int,float)) or not math.isfinite(confidence) or not 0 <= confidence <= 1:
        raise ValueError('Jev returned invalid confidence')
    return next(c for c in options if c['id']==choice), answer


class Game:
    def __init__(self):
        self.loot_tracker=LootTracker()
        ensure_daemon(wait=15)
        targets = [t for t in cdp('Target.getTargets')['targetInfos']
                   if t['type']=='page' and t['url'].startswith('http://slither.com/io')]
        self.target = targets[0]['targetId'] if targets else cdp('Target.createTarget',url='http://slither.com/io')['targetId']
        self.session = cdp('Target.attachToTarget',targetId=self.target,flatten=True)['sessionId']
        self.call('Emulation.setFocusEmulationEnabled',enabled=True)
        cdp('Target.activateTarget',targetId=self.target)

    def call(self,method,**kw):
        return cdp(method,session_id=self.session,**kw)

    def evaluate(self,expression):
        r=self.call('Runtime.evaluate',expression=expression,returnByValue=True)
        if r.get('exceptionDetails'):
            raise RuntimeError('Game observer failed; client version may have changed')
        return r.get('result',{}).get('value')

    def observe(self):
        return self.loot_tracker.update(self.evaluate(OBSERVER))

    def click(self,selector):
        rect=self.evaluate(f"(() => {{const e=document.querySelector({json.dumps(selector)}); if(!e)return null;const r=e.getBoundingClientRect();return {{x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height}}}})()")
        if not rect or rect['w'] <= 0 or rect['h'] <= 0:
            raise RuntimeError('Requested game control is not visible')
        for kind in ('mousePressed','mouseReleased'):
            self.call('Input.dispatchMouseEvent',type=kind,x=rect['x'],y=rect['y'],button='left',clickCount=1)

    def start(self):
        self.click('#nick')
        self.call('Input.dispatchKeyEvent',type='keyDown',key='a',code='KeyA',modifiers=4,commands=['selectAll'])
        self.call('Input.dispatchKeyEvent',type='keyUp',key='a',code='KeyA',modifiers=4)
        self.call('Input.insertText',text=PLAYER_NAME)
        actual = self.evaluate("document.querySelector('#nick').value")
        if actual != PLAYER_NAME:
            raise RuntimeError('Nickname was not set correctly')
        self.click('#playh')
        until=time.monotonic()+20
        while time.monotonic()<until:
            state=self.observe()
            if state['live']:
                return state
            time.sleep(.1)
        raise RuntimeError('Game did not start within 20 seconds')

    def preview(self,options):
        checks=self.evaluate('window.__jevReflex.preview('+json.dumps(options)+')')
        for option,check in zip(options,checks):
            option['execution_check']=check
            if not check.get('can_follow'):
                option['risk']='collision predicted' if check.get('collisionTime',0)<1.25 else 'close to danger'
                option['danger_distance']=option['danger_distance'] or 1
        return options

    def steer(self,route,state):
        plan={k:route.get(k) for k in ('angle','target','boost','boost_when_aligned','mode','coil','enclosure','enemy_id','attack_started','arrival_advantage','attack_stage','attack_intent','crossing_point','crossing_side','crossing_axis','death_event_id','exit_angle','exit_count','exit_width','closing_margin','exit_clearance')}
        identity=route.get('coil',{}).get('enemy_id') if route.get('coil') else route.get('enemy_id')
        if identity is None and route.get('target'):
            identity=[round(route['target']['x']/80),round(route['target']['y']/80)]
        plan.update(life_id=state['self']['id'],plan_id=json.dumps([state['self']['id'],route['mode'],identity]))
        return self.evaluate('window.__jevReflex.commit('+json.dumps(plan)+')')

    def start_reflex(self):
        self.evaluate(REFLEX)

    def end_session(self):
        """Leave a controlled live game normally; this does not pause/save a snake."""
        state=self.observe()
        if state['live']:
            if state['nickname']!=PLAYER_NAME:
                raise RuntimeError('Refusing to leave an unrelated live game')
            self.call('Page.navigate',url='about:blank')
            return 'left_game_page'
        self.stop_reflex()
        return 'already_dead'

    def stop_reflex(self):
        self.evaluate('window.__jevReflex?.stop()')


class Recording:
    def __init__(self,game,folder):
        self.game=game; self.folder=folder; folder.mkdir(parents=True,exist_ok=True)
        self.frames=[]; self.errors=[]; self.stop_event=threading.Event()
        self.start=time.time()
        self.save(game.call('Page.captureScreenshot',format='jpeg',quality=85)['data'],0)
        game.call('Page.startScreencast',format='jpeg',quality=85,maxWidth=1440,maxHeight=1000,everyNthFrame=2)
        self.worker=threading.Thread(target=self.capture,daemon=True); self.worker.start()

    def save(self,data,t):
        path=self.folder/f'{len(self.frames):06d}.jpg'; path.write_bytes(base64.b64decode(data))
        self.frames.append((max(0,t),path))
        with (self.folder/'capture-times.jsonl').open('a') as journal:
            journal.write(json.dumps([max(0,t),path.name])+'\n')

    def capture(self):
        try:
            while not self.stop_event.is_set():
                for e in drain_events():
                    if e['method']=='Page.screencastFrame' and e.get('session_id')==self.game.session:
                        p=e['params']; self.save(p['data'],p['metadata']['timestamp']-self.start)
                        self.game.call('Page.screencastFrameAck',sessionId=p['sessionId'])
                self.stop_event.wait(.015)
        except Exception as e:
            self.errors.append(type(e).__name__)

    def finish(self,output,before_encode):
        try:
            self.stop_event.set(); self.worker.join(5)
            self.game.call('Page.stopScreencast')
            self.save(self.game.call('Page.captureScreenshot',format='jpeg',quality=85)['data'],time.time()-self.start)
        finally:
            # Safety remains active through the last capture. Leave before slow encoding.
            encode=before_encode()
        if encode is False:
            # Delete only this recording's named artifacts, never logs/results or
            # unrelated frame folders. A live handoff never requests this branch.
            if self.folder.is_symlink() or self.folder.name!=output.stem+'-frames':
                raise RuntimeError('Refusing to discard an unexpected recording folder')
            output.unlink(missing_ok=True)
            shutil.rmtree(self.folder)
            return 'discarded_below_threshold'
        lines=[]
        frames=sorted(self.frames,key=lambda x:x[0])
        for i,(t,p) in enumerate(frames):
            duration=max(.001,frames[i+1][0]-t) if i+1<len(frames) else .5
            lines += [f"file '{p}'",f'duration {duration:.6f}']
        lines += [f"file '{frames[-1][1]}'"]
        listing=self.folder/'frames.txt'; listing.write_text('\n'.join(lines))
        (self.folder/'timestamps.json').write_text(json.dumps([(t,p.name) for t,p in frames]))
        subprocess.run(['ffmpeg','-y','-loglevel','error','-f','concat','-safe','0','-i',str(listing),
                        '-vf','fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2','-c:v','libx264','-preset','fast','-crf','21',
                        '-pix_fmt','yuv420p','-movflags','+faststart',str(output)],check=True)
        return 'complete'


def media_retention(result,recording_errors=()):
    """Discard only classified, naturally completed runs below both user thresholds."""
    episodes=result.get('episodes') or []
    lengths=[e['max_length'] for e in episodes if type(e.get('max_length')) in (int,float)
             and math.isfinite(e['max_length']) and e['max_length']>=0]
    ranks=[e['best_rank'] for e in episodes if type(e.get('best_rank')) in (int,float)
           and math.isfinite(e['best_rank']) and e['best_rank']>0]
    decision={'keep':True,'rule':'Keep Top 10 OR length >= 10000; discard natural deaths below both thresholds.',
              'max_length':max(lengths,default=None),'best_rank':min(ranks,default=None)}
    if result.get('controlled_handoff') or result.get('alive_at_stop'):
        decision['reason']='live_or_controlled_handoff'
    elif (decision['max_length'] is not None and decision['max_length']>=10000
          or decision['best_rank'] is not None and decision['best_rank']<=10):
        decision['reason']='reached_top10_or_10000'
    elif (result.get('stop_requested') or result.get('errors') or recording_errors
          or not episodes or len(lengths)!=len(episodes) or len(ranks)!=len(episodes)
          or result.get('alive_at_stop') is not False
          or any(e.get('alive_at_end') is not False for e in episodes)):
        decision['reason']='incomplete_or_unclassified_preserved'
    else:
        decision.update(keep=False,reason='natural_death_below_top10_and_10000')
    return decision


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--seconds',type=float,default=600)
    parser.add_argument('--lives',type=int,default=3)
    parser.add_argument('--until-death',action='store_true',help='No time or decision limit; play one life until death or explicit stop')
    parser.add_argument('--name',default='jev-slither')
    parser.add_argument('--stop-top10',action='store_true')
    parser.add_argument('--resume',action='store_true',help='Continue an existing jev.bot life')
    parser.add_argument('--api-wait',type=float,default=0,help='Initial cooldown after a verified Gateway rate limit')
    args=parser.parse_args()
    if not 1<=args.seconds<=1800 or not 1<=args.lives<=5:
        parser.error('Use 1–1800 seconds and 1–5 lives')
    if not args.name.replace('-','').replace('_','').isalnum():
        parser.error('Name must contain letters, numbers, hyphens or underscores')
    api_key=key_from_env()
    # A bad key or incompatible response must fail before a life starts.
    check_body={'model':MODEL,'state':'The green route is clear; red collides.',
        'questions':{'steering':{'type':'choice','instructions':'Choose the safe route.',
            'criteria':{'green':'Clear route','red':'Collision route'}}}}
    preflight={'model':None,'provider_metadata':None,'status':'deferred_during_live_handoff'}
    if not args.resume:
        with httpx.Client(http2=True,timeout=15,headers={'Authorization':'Bearer '+api_key}) as check_client:
            for attempt in range(4):
                check=check_client.post(API,json=check_body)
                if check.status_code!=429:break
                delay=float(check.headers.get('Retry-After','60'))
                print(json.dumps({'preflight_wait_seconds':delay}),flush=True)
                time.sleep(delay)
            check.raise_for_status()
            preflight=check.json();validated_choice(preflight,[{'id':'green'},{'id':'red'}])
    if args.until_death:
        args.lives=1
        args.stop_top10=False
    game=Game(); evidence=[]; episodes=[]; errors=[]; transient_errors=[]; attempts=0; top10=None; best_rank=None
    initial=game.observe()
    if initial['live'] and not (args.resume and initial['nickname']==PLAYER_NAME):
        raise RuntimeError('A game is already running; --resume only allows an existing jev.bot life.')
    output=ROOT/'outputs'/args.name
    decision_path=ROOT/'work'/f'{args.name}-decisions.jsonl'
    decision_log=decision_path.open('w')
    if initial['live']:
        game.start_reflex()
    try:
        recording=Recording(game,ROOT/'work'/f'{args.name}-frames')
        client=httpx.Client(http2=True,timeout=4,headers={'Authorization':'Bearer '+api_key})
    except BaseException:
        game.end_session()
        raise
    began=time.monotonic(); deadline=math.inf if args.until_death else began+args.seconds
    next_request_at=began+max(MIN_REQUEST_INTERVAL,args.api_wait)
    stop_requested=threading.Event()
    handoff_requested=threading.Event()
    prior_interrupt=signal.signal(signal.SIGINT,lambda *_:stop_requested.set())
    def handoff_signal(*_):
        handoff_requested.set();stop_requested.set()
    prior_handoff=signal.signal(signal.SIGUSR1,handoff_signal)
    try:
        for life in range(args.lives):
            if stop_requested.is_set() or time.monotonic()>=deadline or (args.stop_top10 and top10):
                break
            state=game.observe()
            if not state['live']:
                state=game.start()
            game.start_reflex()
            life_start=time.monotonic()
            episode={'snake_id':state['self']['id'],'resumed':bool(args.resume and life==0 and initial['live']),'best_rank':None,'max_server_kill_count':0,'life':life+1,'nickname':state['nickname'],'initial_length':state['client_length'],'max_length':state['client_length']}
            previous_route=None
            while state['live'] and not stop_requested.is_set() and time.monotonic()<deadline and (args.until_death or attempts<7200):
                if time.monotonic()<next_request_at:
                    stop_requested.wait(min(.25,next_request_at-time.monotonic()))
                    state=game.observe()
                    continue
                state=game.observe()
                if not state['live']:
                    break
                # The reflex loop keeps acting during API latency; new plans are
                # interpreted again from the current pose when they arrive.
                delay = .08
                active=(state.get('reflex') or {}).get('active_plan')
                previous_route=active if active and active.get('mode')!='survival_fallback' else None
                life_elapsed=time.monotonic()-life_start
                state['growth_kpi']={'elapsed_seconds':round(life_elapsed,2),
                    'net_score_per_minute':round((state['client_length']-episode['initial_length'])*60/max(1,life_elapsed),2),
                    'targets':[{'score':score,'deadline_seconds':seconds} for score,seconds in
                               [(100,60),(1000,180),(5000,600),(10000,900)]]}
                all_options=game.preview(make_options(state,previous_route,delay))
                options=admissible_options(all_options); body=request_body(state,options)
                requested=time.monotonic(); attempts+=1
                next_request_at=requested+MIN_REQUEST_INTERVAL
                try:
                    response=client.post(API,json=body)
                except httpx.TransportError as error:
                    transient_errors.append({'t':round(time.monotonic()-began,3),'error':type(error).__name__})
                    print(json.dumps({'retrying_typesafe':transient_errors[-1]}),flush=True)
                    time.sleep(.5)
                    continue
                elapsed=time.monotonic()-requested
                if response.status_code in (408,429,500,502,503,504):
                    transient_errors.append({'t':round(time.monotonic()-began,3),'http_status':response.status_code})
                    print(json.dumps({'retrying_typesafe':transient_errors[-1]}),flush=True)
                    retry_after=response.headers.get('Retry-After','1')
                    next_request_at=max(next_request_at,time.monotonic()+(max(1,float(retry_after)) if retry_after.replace('.','',1).isdigit() else 60))
                    continue
                if response.status_code!=200:
                    raise RuntimeError(f'TypeSafe HTTP {response.status_code}; stopping')
                data=response.json(); route,answer=validated_choice(data,options)
                fresh=game.observe()
                same_life=fresh['live'] and fresh['self']['id']==state['self']['id']
                selected_route=route
                acceptance={'accepted':False,'reason':'stale_or_different_life'}
                if same_life and elapsed<1.2:
                    if route.get('coil'):
                        route=refresh_coil_route(fresh,route,previous_route)
                    elif route.get('attack_intent') or route.get('mode')=='cut_ahead':
                        route=refresh_attack_route(fresh,route,previous_route)
                    if route is not None:
                        acceptance=game.steer(route,fresh)
                # Acceptance is not proof that a later timer tick issued the input.
                route=route or selected_route
                executed=False
                evidence.append({'t':round(time.monotonic()-began,3),'life':life+1,
                    'latency_ms':round(elapsed*1000),'model':data.get('model'),
                    'answer':answer,'selected_route':selected_route,'route':route,'acceptance':acceptance,'usage':data.get('usage'),
                    'provider_metadata':data.get('provider_metadata'),
                    'controller_events':game.evaluate('window.__jevReflex.drainEvents()'),
                    'executed':executed,'length':fresh.get('client_length'),'hud_length':fresh['stats']['length'],
                    'options_before_safety_filter':len(all_options),'options_after_safety_filter':len(options),
                    'rank':fresh['stats']['rank'],'reflex':fresh.get('reflex'),
                    'server_kill_count':fresh['self'].get('server_kill_count') if fresh['live'] else None,
                    'head':{k:fresh['self'][k] for k in ('x','y','angle')} if fresh['live'] else None,
                    'tactical_observations':fresh.get('tactical_observations'),
                    'planning_state':state, 'request':body})
                decision_log.write(json.dumps(evidence[-1])+'\n');decision_log.flush()
                state=fresh
                episode['max_length']=max(episode['max_length'],state.get('client_length',0))
                episode['max_server_kill_count']=max(episode['max_server_kill_count'],state.get('self',{}).get('server_kill_count',0) or 0)
                rank=state['stats']['rank']
                if stats_are_fresh(state) and rank and time.monotonic()-life_start>2 and (rank>10 or is_top10(state)):
                    episode['best_rank']=min(episode['best_rank'] or rank,rank)
                if is_top10(state):
                    snapshot={'t':round(time.monotonic()-began,3),'life':life+1,'stats':state['stats'],
                              'nickname':state['nickname'],'leaderboard':state['leaderboard']}
                    if top10 is None:
                        top10=snapshot
                        output.with_name(output.name+'-top10.png').write_bytes(base64.b64decode(
                            game.call('Page.captureScreenshot',format='png')['data']))
                    if best_rank is None or rank<best_rank['stats']['rank']:
                        best_rank=snapshot
                        output.with_name(output.name+'-best-rank.png').write_bytes(base64.b64decode(
                            game.call('Page.captureScreenshot',format='png')['data']))
                        print(json.dumps({'new_best_rank':snapshot}),flush=True)
                    if args.stop_top10:
                        break
                if len(evidence)%10==0:
                    print(json.dumps({'seconds':round(time.monotonic()-began,1),'life':life+1,
                        'length':state['stats']['length'],'rank':state['stats']['rank'],
                        'kills':episode['max_server_kill_count'],'mode':route['mode'],
                        'accepted':acceptance['accepted'],'actual':(state.get('reflex') or {}).get('last'),
                        'decision':route['id'],'latency_ms':round(elapsed*1000)}),flush=True)
                if elapsed<.15:
                    time.sleep(.15-elapsed)
            if not state['live']:
                game.stop_reflex()
            episode.update(seconds=round(time.monotonic()-life_start,2),alive_at_end=state['live'],stats=state['stats'],
                           tactical_observations={'visible_deaths':len(game.loot_tracker.seen),
                               'eaten_pellets':game.loot_tracker.eaten_count,
                               'eaten_near_observed_death_trails':game.loot_tracker.death_food_count},
                           reflex=state.get('reflex'),server_kill_count=state.get('self',{}).get('server_kill_count'))
            if not state['live']:
                # Let the normal death animation reveal the independent final score.
                until=time.monotonic()+5
                while time.monotonic()<until:
                    state=game.observe()
                    if state['stats']['final_length']:
                        episode['stats']=state['stats']
                        episode['max_length']=max(episode['max_length'],state['stats']['final_length'])
                        break
                    time.sleep(.1)
                print(json.dumps({'episode':episode}),flush=True)
                time.sleep(1.5)
            episodes.append(episode)
    except Exception as e:
        errors.append(f'{type(e).__name__}: {e}')
    finally:
        client.close()
        decision_log.close()
        signal.signal(signal.SIGINT,prior_interrupt)
        signal.signal(signal.SIGUSR1,prior_handoff)
        final=game.observe()
        result={'controller':'Official TypeSafe Skill + Vercel AI Gateway + browser-harness CDP',
            'api_endpoint':API,
            'api_preflight':{'model':preflight.get('model'),'provider_metadata':preflight.get('provider_metadata')},
            'ultrafast_used':False,'nickname':PLAYER_NAME,'top10':top10,'best_rank_snapshot':best_rank,'model_alias':MODEL,'model_responses':sorted({e['model'] for e in evidence}),
            'api_attempts':attempts,'valid_decisions':len(evidence),
            'accepted_steering_plans':sum(e['acceptance']['accepted'] for e in evidence),
            'execution_evidence':'Use controller_events input_issued with plan_id/revision; legacy executed is false.',
            'tail_controller_events':game.evaluate('window.__jevReflex.drainEvents()'),
            'median_latency_ms':statistics.median([e['latency_ms'] for e in evidence]) if evidence else None,
            'stop_requested':stop_requested.is_set(),'controlled_handoff':handoff_requested.is_set(),'episodes':episodes,'elapsed_seconds':round(time.monotonic()-began,2),
            'transient_api_errors':transient_errors,
            'final_stats':final['stats'],'alive_at_stop':final['live'],'errors':errors,
            'observation':'Read-only client positions, filtered to visible nearby food and bodies; no screenshots sent to Jev.',
            'actions':'Jev selects forage, boosted collection or cut-ahead plans; a 20Hz input-only safety controller can veto boost and override imminent collisions.',
            'video_timing':'Original screencast timestamps at 1x speed, with 0.5s final hold.'}
        def leave_before_encoding():
            result['session_end']='kept_live_for_handoff' if handoff_requested.is_set() else game.end_session()
            result['media_retention']=media_retention(result,recording.errors)
            result['recording_status']='encoding' if result['media_retention']['keep'] else 'discarding_below_threshold'
            output.with_suffix('.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
            return result['media_retention']['keep']
        finalized_status=None
        try:
            finalized_status=recording.finish(output.with_suffix('.mp4'),leave_before_encoding)
        except Exception as e:
            errors.append(f'Recording finalization: {type(e).__name__}')
        result['recording_status']=finalized_status if not errors and not recording.errors else 'check_errors'
        result['recording_errors']=recording.errors
        result['recording_frames']=len(recording.frames)
        output.with_suffix('.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
        if not handoff_requested.is_set():
            game.call('Emulation.setFocusEmulationEnabled',enabled=False)
        cdp('Target.detachFromTarget',sessionId=game.session)
        print(json.dumps(result,ensure_ascii=False),flush=True)
    return int(bool(errors or recording.errors))


def stats_are_fresh(state):
    native=state.get('client_length')
    hud=state.get('stats',{}).get('length')
    return bool(state.get('live') and native is not None and hud is not None
                and abs(native-hud)<=max(30,native*.2))


def is_top10(state):
    rank=state.get('stats',{}).get('rank')
    names=[n.strip() for n in state.get('leaderboard',{}).get('names',[])]
    return bool(stats_are_fresh(state) and state.get('nickname')==PLAYER_NAME and rank and 1<=rank<=10
                and len(names)>=rank and names[rank-1]==PLAYER_NAME)


if __name__=='__main__':
    raise SystemExit(main())
