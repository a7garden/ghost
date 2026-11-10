/**
 * Motion for the built-in Ghost, written straight to SVG attributes.
 * `talk` is the responding sway and mouth; `life` adds blinks, glances (the face turns and the body leans
 * into it) and a crouch-and-hop when poked; `follow` lets the gaze track a nearby pointer and the body breathe.
 * The body is soft: a loosely damped squash spring wobbles after every landing and turn, and the top
 * lags behind sideways motion. Between idle beats the loop sleeps on a timer, so a resting Ghost costs no frames.
 */
export type GhostParts = { svg: SVGSVGElement; body: SVGGElement; face: SVGGElement; eyes: SVGGElement; mouth: SVGEllipseElement };
export type GhostLifeOptions = { talk: boolean; life: boolean; follow: boolean };

const rhythm = [1, 1.56, 1.13, 1.42, 1.08, 1.70, 1.20, 1.50, 1.04, 1];
function talkMotion(seconds: number) {
  const phase = ((seconds % 5) + 5) % 5 / 5, index = phase * (rhythm.length - 1), left = Math.floor(index);
  const ease = (1 - Math.cos((index - left) * Math.PI)) / 2;
  const open = rhythm[left] + (rhythm[Math.min(left + 1, rhythm.length - 1)] - rhythm[left]) * ease;
  return { x: 4 * Math.sin(2 * Math.PI * phase), y: 1.8 * (1 - Math.cos(2 * Math.PI * phase)), tilt: 2.4 * Math.sin(2 * Math.PI * phase), open };
}

const BLINK_MS = 170, CROUCH_MS = 110, AIR_MS = 400, EYE_Y = 417, FACE = { x: 500, y: 450 }, BASE = { x: 500, y: 790 };
const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const random = (min: number, max: number) => min + Math.random() * (max - min);
const fixed = (value: number) => value.toFixed(2);

/** Lid openness `elapsed` ms into a blink: shuts fast, opens slower. */
function blinkLid(elapsed: number) {
  if (elapsed < 0 || elapsed >= BLINK_MS) return 1;
  const t = elapsed / BLINK_MS;
  return t < .4 ? 1 - .9 * smooth(t / .4) : .1 + .9 * smooth((t - .4) / .6);
}

export function startGhostLife(parts: GhostParts, { talk, life, follow }: GhostLifeOptions) {
  const { svg, body, face, eyes, mouth } = parts;
  const start = performance.now();
  // Gaze is a slightly underdamped spring, so a turn overshoots a hair and settles.
  const gaze = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0 };
  // Squash: positive is wider and shorter, negative taller and thinner, scaled about the body's base.
  const squash = { s: 0, v: 0 };
  let blinks: number[] = [], hopAt = -Infinity, hop: 'crouch' | 'air' | null = null, last = 0, frame = 0, timer = 0;
  let nextBlink = start + random(900, 3200), nextGlance = start + random(1200, 3600);
  let pointer: { x: number; y: number; at: number } | null = null;

  const blink = (at: number, double: boolean) => { blinks.push(at); if (double) blinks.push(at + 240); };
  const glance = (now: number) => {
    const away = Math.abs(gaze.tx) > .2 || Math.abs(gaze.ty) > .3;
    if (away && Math.random() < .55) {
      gaze.tx = 0; gaze.ty = random(-.05, .15);
      nextGlance = now + random(1800, 5200);
    } else {
      gaze.tx = (Math.random() < .5 ? -1 : 1) * random(.4, 1); gaze.ty = random(-.5, .6);
      nextGlance = now + random(900, 2600);
    }
    if (Math.random() < .45 && !blinks.some(at => Math.abs(now - at) < 700)) blink(now + 40, false);
    squash.v += random(.4, .7);
  };
  const track = (now: number) => {
    if (!pointer || now - pointer.at > 2500) return false;
    const box = svg.getBoundingClientRect();
    const dx = pointer.x - (box.left + box.width / 2), dy = pointer.y - (box.top + box.height / 2);
    if (!box.width || Math.hypot(dx, dy) > box.width * 4) return false;
    gaze.tx = clamp(dx / (box.width * 1.6), -1, 1); gaze.ty = clamp(dy / (box.width * 1.6), -.7, .8);
    return true;
  };

  const render = (now: number) => {
    const m = talk ? talkMotion((now - start) / 1000) : { x: 0, y: 0, tilt: 0, open: 1 };
    const air = hop === 'air' ? -38 * Math.sin(Math.PI * clamp((now - hopAt - CROUCH_MS) / AIR_MS, 0, 1)) : 0;
    const lid = blinks.reduce((low, at) => Math.min(low, blinkLid(now - at)), 1);
    const tilt = m.tilt + gaze.x * 4;
    const breath = follow ? .014 * Math.sin(2 * Math.PI * (now - start) / 3800) : 0;
    const s = clamp(squash.s + breath - (m.open - 1) * .04, -.25, .25);
    // Positive skew pushes the top left: it trails a rightward turn and swings past as the turn settles.
    const skew = clamp(gaze.vx * 1.4, -6, 6);
    body.setAttribute('transform', `translate(${fixed(m.x + gaze.x * 6)} ${fixed(m.y + air)}) rotate(${fixed(tilt)} 500 650) `
      + `translate(${BASE.x} ${BASE.y}) skewX(${fixed(skew)}) scale(${fixed(1 + s * .9)} ${fixed(1 - s)}) translate(${-BASE.x} ${-BASE.y})`);
    face.setAttribute('transform', `translate(${fixed(FACE.x + gaze.x * 30)} ${fixed(FACE.y + gaze.y * 18)}) scale(${fixed(1 - Math.abs(gaze.x) * .07)} 1) translate(${-FACE.x} ${-FACE.y})`);
    eyes.setAttribute('transform', `translate(0 ${EYE_Y}) scale(1 ${fixed(lid)}) translate(0 ${-EYE_Y})`);
    mouth.setAttribute('ry', fixed(15 * m.open));
    mouth.setAttribute('rx', fixed(15 * (1 + .12 * (m.open - 1))));
  };

  const step = (now: number) => {
    frame = 0;
    const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 0;
    last = now;
    if (life) {
      if (follow && track(now)) nextGlance = Math.max(nextGlance, now + 1200);
      else if (now >= nextGlance) glance(now);
      if (now >= nextBlink) { blink(now, Math.random() < .2); nextBlink = now + random(2400, 6200); }
    }
    const k = 140, c = 2 * .72 * Math.sqrt(k);
    gaze.vx += (-k * (gaze.x - gaze.tx) - c * gaze.vx) * dt; gaze.x += gaze.vx * dt;
    gaze.vy += (-k * (gaze.y - gaze.ty) - c * gaze.vy) * dt; gaze.y += gaze.vy * dt;
    // The hop crouches into a squash, leaves stretched, and lands with a squash that wobbles out.
    const hopped = now - hopAt;
    if (hop === 'crouch' && hopped < CROUCH_MS) { squash.s = .16 * smooth(hopped / CROUCH_MS); squash.v = 0; }
    else if (hop === 'crouch') { hop = 'air'; squash.s = -.12; squash.v = 0; }
    else if (hop === 'air' && hopped >= CROUCH_MS + AIR_MS) { hop = null; squash.v += 2.6; }
    if (hop !== 'crouch') {
      // Loosely damped, so the body jiggles a few times before it rests.
      const sk = 300, sc = 2 * .2 * Math.sqrt(sk);
      squash.v += (-sk * squash.s - sc * squash.v) * dt; squash.s += squash.v * dt;
    }
    blinks = blinks.filter(at => now - at < BLINK_MS);
    render(now);
    const moving = Math.abs(gaze.x - gaze.tx) > .003 || Math.abs(gaze.y - gaze.ty) > .003 || Math.abs(gaze.vx) + Math.abs(gaze.vy) > .02
      || Math.abs(squash.s) > .002 || Math.abs(squash.v) > .02;
    if (talk || follow || moving || blinks.length || hop) frame = requestAnimationFrame(step);
    else if (life) { last = 0; timer = window.setTimeout(wake, Math.max(0, Math.min(nextBlink, nextGlance) - now)); }
  };
  const wake = () => { clearTimeout(timer); if (!frame) frame = requestAnimationFrame(step); };
  const move = (event: PointerEvent) => { pointer = { x: event.clientX, y: event.clientY, at: performance.now() }; wake(); };
  const poke = () => { const now = performance.now(); hopAt = now; hop = 'crouch'; blink(now + CROUCH_MS, true); wake(); };

  render(start);
  if (talk || life) frame = requestAnimationFrame(step);
  if (follow) window.addEventListener('pointermove', move, { passive: true });
  if (life) svg.addEventListener('pointerdown', poke);
  return () => {
    cancelAnimationFrame(frame); clearTimeout(timer);
    window.removeEventListener('pointermove', move);
    svg.removeEventListener('pointerdown', poke);
  };
}
