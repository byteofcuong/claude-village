// Time of day: one light, one sky and one fog driven by a small table of moods.
import * as THREE from 'three';

interface Mood {
  hour: number;
  zenith: string; mid: string; horizon: string; below: string;
  sun: string; sunPower: number;
  hemiSky: string; hemiGround: string; hemi: number;
  fog: string;
  cloudLit: string; cloudShade: string;
  night: number;
}

const MOODS: Mood[] = [
  { hour: 0, zenith: '#050a24', mid: '#0f1a45', horizon: '#26305e', below: '#141c44', sun: '#aebfff', sunPower: 1.0, hemiSky: '#7384cc', hemiGround: '#2a3360', hemi: 0.95, fog: '#1a2450', cloudLit: '#56649c', cloudShade: '#1e2650', night: 1 },
  { hour: 4.6, zenith: '#0a1236', mid: '#1c2758', horizon: '#3f3f73', below: '#1f2752', sun: '#aebfff', sunPower: 0.95, hemiSky: '#7384cc', hemiGround: '#2c3460', hemi: 0.95, fog: '#242c5a', cloudLit: '#6a6fa8', cloudShade: '#262c58', night: 1 },
  { hour: 6, zenith: '#4c6fb4', mid: '#c49ac0', horizon: '#ffc79a', below: '#e4a9b4', sun: '#ffb27a', sunPower: 1.9, hemiSky: '#ffd9cf', hemiGround: '#8d7fa8', hemi: 1.05, fog: '#efc3bb', cloudLit: '#fff0e0', cloudShade: '#c99ab8', night: 0.2 },
  { hour: 8.5, zenith: '#3f86d8', mid: '#7fc1ee', horizon: '#fbe8cf', below: '#a9d8f0', sun: '#ffe6bd', sunPower: 2.8, hemiSky: '#fff5e4', hemiGround: '#a2a982', hemi: 1.4, fog: '#cfe7ee', cloudLit: '#ffffff', cloudShade: '#bcd2ea', night: 0 },
  { hour: 12.5, zenith: '#2a6fd0', mid: '#5aa8ec', horizon: '#c8e6f4', below: '#7dbdec', sun: '#fff4dc', sunPower: 3.2, hemiSky: '#fdfbff', hemiGround: '#a3ad8c', hemi: 1.55, fog: '#b9dcf1', cloudLit: '#ffffff', cloudShade: '#b6d0ee', night: 0 },
  { hour: 16.5, zenith: '#3a78cb', mid: '#8ab5e0', horizon: '#ffe0b0', below: '#a9c8e6', sun: '#ffd79a', sunPower: 3.0, hemiSky: '#ffeed4', hemiGround: '#a69a78', hemi: 1.4, fog: '#e6dcc4', cloudLit: '#fff4dd', cloudShade: '#c4bedc', night: 0 },
  { hour: 18.2, zenith: '#46508f', mid: '#c9739a', horizon: '#ff9d5c', below: '#d97f85', sun: '#ff8f52', sunPower: 2.4, hemiSky: '#ffb9a0', hemiGround: '#6d5a8a', hemi: 1.0, fog: '#e8a08c', cloudLit: '#ffd0a8', cloudShade: '#94608f', night: 0.3 },
  { hour: 19.6, zenith: '#141c52', mid: '#3c3a7a', horizon: '#a0577f', below: '#34306a', sun: '#b5a9ee', sunPower: 1.1, hemiSky: '#8a84cc', hemiGround: '#343160', hemi: 1.0, fog: '#3e3a72', cloudLit: '#a184b4', cloudShade: '#2e2c60', night: 0.85 },
  { hour: 24, zenith: '#050a24', mid: '#0f1a45', horizon: '#26305e', below: '#141c44', sun: '#aebfff', sunPower: 1.0, hemiSky: '#7384cc', hemiGround: '#2a3360', hemi: 0.95, fog: '#1a2450', cloudLit: '#56649c', cloudShade: '#1e2650', night: 1 },
];
const parsed = MOODS.map((m) => ({
  ...m,
  c: { zenith: new THREE.Color(m.zenith), mid: new THREE.Color(m.mid), horizon: new THREE.Color(m.horizon), below: new THREE.Color(m.below), sun: new THREE.Color(m.sun), hemiSky: new THREE.Color(m.hemiSky), hemiGround: new THREE.Color(m.hemiGround), fog: new THREE.Color(m.fog), cloudLit: new THREE.Color(m.cloudLit), cloudShade: new THREE.Color(m.cloudShade) },
}));
type ColorKey = keyof (typeof parsed)[number]['c'];

const skyVertex = 'varying vec3 d; void main(){ d = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }';
const skyFragment = `varying vec3 d; uniform vec3 zenith, midc, horizon, below, sunDir, moonDir, sunColor; uniform float night;
  float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
  float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
  float f(vec2 p){return .5*n(p)+.25*n(p*2.03)+.125*n(p*4.1)+.0625*n(p*8.3);}
  void main(){ vec3 v=normalize(d); float y=v.y;
    vec3 c=y>0.?mix(horizon,mix(midc,zenith,smoothstep(.1,.62,y)),smoothstep(0.,.16,y)):mix(horizon,below,smoothstep(0.,-.14,y));
    float s=max(dot(v,sunDir),0.); c+=sunColor*(pow(s,7.)*.2+pow(s,70.)*.35)*(1.-night*.9)+vec3(1.,.97,.88)*pow(s,700.)*2.*(1.-night);
    float m=max(dot(v,moonDir),0.); c+=vec3(.75,.82,1.)*(pow(m,900.)*2.4+pow(m,40.)*.1)*night;
    if(y>.04&&y<.9){ vec2 st=vec2(v.x,v.z)/(abs(y)+.25)*vec2(1.2,3.5); float w=smoothstep(.48,.72,f(st+3.))*smoothstep(.04,.22,y)*(1.-smoothstep(.5,.9,y));
      c=mix(c,mix(vec3(1.),horizon,.45),w*.6*(1.-night*.7)); }
    if(night>.02&&y>-.02){ vec2 g=v.xz/(abs(y)+.45)*190.; vec2 id=floor(g); float r=h(id); float star=step(.988,r)*smoothstep(.45,.0,length(fract(g)-.5)); c+=vec3(.9,.94,1.)*star*night*(.45+.55*h(id+3.)); }
    gl_FragColor=vec4(c,1.);
    #include <colorspace_fragment>
  }`;

export class DayNight {
  readonly sun = new THREE.DirectionalLight();
  readonly hemi = new THREE.HemisphereLight();
  readonly fog = new THREE.FogExp2(0xb5daf0, 0.0052);
  readonly night = { value: 0 };
  readonly cloudLit = { value: new THREE.Color() };
  readonly cloudShade = { value: new THREE.Color() };
  private readonly uniforms = {
    zenith: { value: new THREE.Color() }, midc: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, below: { value: new THREE.Color() },
    sunDir: { value: new THREE.Vector3() }, moonDir: { value: new THREE.Vector3() }, sunColor: { value: new THREE.Color() }, night: this.night,
  };

  constructor(scene: THREE.Scene, span: number) {
    scene.fog = this.fog;
    const sky = new THREE.Mesh(new THREE.SphereGeometry(300, 32, 20), new THREE.ShaderMaterial({ side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false, uniforms: this.uniforms, vertexShader: skyVertex, fragmentShader: skyFragment }));
    // Drawn after everything solid, so the costly shader only runs on pixels that really show sky.
    sky.renderOrder = 10;
    scene.add(sky, this.hemi, this.sun);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 1, far: 170 });
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.05;
    this.sun.shadow.radius = 4;
  }

  update(hour: number): void {
    const h = ((hour % 24) + 24) % 24;
    let i = 0;
    while (i < parsed.length - 2 && parsed[i + 1]!.hour <= h) i++;
    const a = parsed[i]!, b = parsed[i + 1]!;
    const t = (h - a.hour) / (b.hour - a.hour);
    const c = (k: ColorKey, into: THREE.Color) => into.copy(a.c[k]).lerp(b.c[k], t);
    const u = this.uniforms;
    c('zenith', u.zenith.value); c('mid', u.midc.value); c('horizon', u.horizon.value); c('below', u.below.value); c('sun', u.sunColor.value);
    c('sun', this.sun.color);
    c('hemiSky', this.hemi.color); c('hemiGround', this.hemi.groundColor);
    c('fog', this.fog.color);
    c('cloudLit', this.cloudLit.value); c('cloudShade', this.cloudShade.value);
    this.sun.intensity = a.sunPower + (b.sunPower - a.sunPower) * t;
    this.hemi.intensity = a.hemi + (b.hemi - a.hemi) * t;
    this.night.value = a.night + (b.night - a.night) * t;
    // The sun crosses from east at 6:00 to west at 18:00; the moon takes over the same light at night.
    const angle = ((h - 6) / 12) * Math.PI;
    const sunVec = new THREE.Vector3(Math.cos(angle) * 0.82, Math.sin(angle) * 0.82, 0.42).normalize();
    const moonVec = new THREE.Vector3(-Math.cos(angle) * 0.7, -Math.sin(angle) * 0.7 + 0.2, 0.5).normalize();
    u.sunDir.value.copy(sunVec);
    u.moonDir.value.copy(moonVec);
    const lightDir = sunVec.y > 0.06 ? sunVec.clone() : moonVec.clone();
    lightDir.y = Math.max(lightDir.y, 0.28);
    this.sun.position.copy(lightDir.normalize()).multiplyScalar(70);
  }
}
