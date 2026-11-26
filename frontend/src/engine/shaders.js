// GLSL lifted unchanged from the approved mockup.
const LATLON = `
  vec3 P(vec2 t, float h, float disp){ float lon=t.x*6.2831853-3.1415926; float lat=(t.y-0.5)*3.1415926;
    return vec3(cos(lat)*cos(lon), sin(lat), -cos(lat)*sin(lon))*(1.0+h*disp); }`;

export const GLOBE_VS = `uniform sampler2D elevTex; uniform float disp; varying vec2 vUv; varying vec3 vN; varying vec3 vS;` + LATLON + `
  void main(){ vUv=uv; float du=1.0/4096.0, dv=1.0/2048.0;
    float h=texture2D(elevTex,uv).r, hu=texture2D(elevTex,uv+vec2(du,0.0)).r, hv=texture2D(elevTex,uv+vec2(0.0,dv)).r;
    vec3 p0=P(uv,h,disp), pu=P(uv+vec2(du,0.0),hu,disp), pv=P(uv+vec2(0.0,dv),hv,disp);
    vec3 n=normalize(cross(pu-p0,pv-p0)); if(dot(n,p0)<0.0) n=-n; if(abs(uv.y-0.5)>0.49) n=normalize(p0);
    vN=normalize(mat3(modelMatrix)*n); vS=normalize(mat3(modelMatrix)*normalize(p0));
    gl_Position=projectionMatrix*modelViewMatrix*vec4(p0,1.0); }`;

export const GLOBE_FS = `uniform sampler2D dayTex, lightsTex, borderTex, coastTex; uniform vec3 sunDir; uniform float lightsOn, bordersOn; varying vec2 vUv; varying vec3 vN; varying vec3 vS;
  void main(){
    vec3 day=texture2D(dayTex,vUv).rgb;
    float lam=max(dot(vN,sunDir),0.0), dayAmt=smoothstep(-0.10,0.22,dot(vS,sunDir));
    vec3 lit=day*(0.08+1.15*lam);
    float moonL=max(dot(vN,normalize(vec3(-0.45,0.65,0.6))),0.0);
    vec3 moon=day*vec3(0.20,0.25,0.30)*(0.35+0.9*moonL);
    vec3 col=mix(moon,lit,dayAmt);
    vec2 px=vec2(1.0/4096.0,1.0/2048.0);
    float L=texture2D(lightsTex,vUv).r;
    float halo=(texture2D(lightsTex,vUv+px*vec2(2.5,0.0)).r+texture2D(lightsTex,vUv-px*vec2(2.5,0.0)).r+texture2D(lightsTex,vUv+px*vec2(0.0,2.5)).r+texture2D(lightsTex,vUv-px*vec2(0.0,2.5)).r)*0.25;
    col+=(vec3(1.0,0.72,0.34)*pow(L,1.0)*mix(1.9,2.6,dayAmt)+vec3(1.0,0.55,0.2)*halo*mix(0.55,0.9,dayAmt))*mix(1.0,0.85,dayAmt)*lightsOn;
    float b=texture2D(borderTex,vUv).a*bordersOn;
    col=mix(col,vec3(0.90,0.99,0.95),b*mix(0.45,0.85,max(dayAmt,0.4)));
    float cst=texture2D(coastTex,vUv).r*bordersOn;
    col=mix(col,vec3(0.92,1.0,0.97),cst*0.9);
    gl_FragColor=vec4(col,1.0); }`;

export const SHELL_VS = `uniform sampler2D domElev; uniform float disp; uniform float lift; varying vec2 vUv; varying vec3 vS;
  void main(){ vUv=uv; float h=texture2D(domElev,uv).r; vec3 p=normalize(position)*(1.0+h*disp+lift);
    vS=normalize(mat3(modelMatrix)*normalize(position)); gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0); }`;

export const WX_FS = `uniform sampler2D wxTex; varying vec2 vUv; void main(){ vec4 c=texture2D(wxTex,vUv); gl_FragColor=c; }`;

export const LIFT_FS = `uniform sampler2D maskTex; uniform float fade; varying vec2 vUv; varying vec3 vS;
  void main(){ vec4 m=texture2D(maskTex,vUv); if(m.a<0.005) discard; gl_FragColor=vec4(m.rgb*m.a*fade, 1.0); }`;

export const SUN_VS = `varying vec2 vUv; varying vec3 vN; varying vec3 vP; void main(){ vUv=uv; vN=normalize(normalMatrix*normal); vec4 mv=modelViewMatrix*vec4(position,1.0); vP=mv.xyz; gl_Position=projectionMatrix*mv; }`;

export const SUN_FS = `uniform sampler2D sunTex; uniform float time; varying vec2 vUv; varying vec3 vN; varying vec3 vP;
  void main(){ float mu=max(dot(normalize(vN),normalize(-vP)),0.0);
    vec3 t=texture2D(sunTex,vUv+vec2(time*0.0015,0.0)).rgb, t2=texture2D(sunTex,vUv*1.7-vec2(time*0.001,time*0.0007)).rgb;
    vec3 base=mix(t,t2,0.35); float gran=0.92+0.08*sin(vUv.x*900.0+time*1.3)*sin(vUv.y*700.0-time*0.9);
    vec3 col=base*gran*vec3(1.75,1.32,0.82)*(0.35+0.85*pow(mu,0.5)) + vec3(1.0,0.45,0.12)*pow(1.0-mu,3.0)*0.6;
    gl_FragColor=vec4(col,1.0); }`;

export const ATM_VS = `varying vec3 vN; varying vec3 vP; void main(){ vN=normalize(normalMatrix*normal); vec4 mv=modelViewMatrix*vec4(position,1.0); vP=mv.xyz; gl_Position=projectionMatrix*mv; }`;

export const AIRGLOW_FS = `varying vec3 vN; varying vec3 vP; void main(){ float r=1.0-abs(dot(normalize(vN),normalize(-vP))); float f=smoothstep(0.90,0.985,r)*(1.0-smoothstep(0.985,1.0,r)); gl_FragColor=vec4(vec3(0.42,1.0,0.55)*f*0.35,f*0.3); }`;

// Cloud proxy shell: cTex (36x32, south row first) R = cloud cover 0..1, G = heavy-rain factor 0..1, B/A = u10/v10
// encoded as 0.5 + wind/30. Procedural fbm clouds are advected along the wind with a two-phase flow map.
export const CLOUD_FS = `uniform sampler2D cTex, maskTex; uniform vec3 sunDir; uniform float time, fade; varying vec2 vUv; varying vec3 vS;
  float h(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
  float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
    return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
  float fbm(vec2 p){ float a=0.5, s=0.0; for(int k=0;k<5;k++){ s+=a*vn(p); p=p*2.03+vec2(17.1,9.3); a*=0.5; } return s; }
  void main(){
    vec4 c=texture2D(cTex,vUv); float cover=c.r, rain=c.g; vec2 w=(c.ba-0.5)*30.0;
    vec2 flow=vec2(w.x, w.y)*vec2(1.0/36.0, 1.0/32.0)*0.6;
    float t=time*0.08, p0=fract(t), p1=fract(t+0.5), wt=abs(1.0-2.0*p0);
    vec2 q=vUv*vec2(36.0,32.0)*0.55;
    float n=mix(fbm(q-flow*p0*36.0+vec2(3.1,1.7)), fbm(q-flow*p1*36.0+vec2(11.3,7.9)), 1.0-wt);
    float dens=smoothstep(1.0-cover, 1.0-cover+0.28, n)*(0.55+0.45*cover);
    float edge=smoothstep(0.0,0.03,vUv.x)*smoothstep(0.0,0.03,1.0-vUv.x)*smoothstep(0.0,0.035,vUv.y)*smoothstep(0.0,0.035,1.0-vUv.y);
    float m=texture2D(maskTex,vec2(vUv.x,vUv.y)).a;
    float a=dens*(0.62+0.3*rain)*edge*m*fade; if(a<0.004) discard;
    float day=0.22+0.9*smoothstep(-0.12,0.3,dot(vS,sunDir));
    vec3 col=mix(vec3(0.93,0.95,0.97), vec3(1.0), rain)*(0.8+0.35*rain)*day;
    gl_FragColor=vec4(col,a); }`;

// Impact highlight: hiTex alpha marks the affected cells; a slow pulse.
export const HI_FS = `uniform sampler2D hiTex; uniform float time, fade; varying vec2 vUv;
  void main(){ vec4 m=texture2D(hiTex,vUv); if(m.a<0.01) discard; float p=0.65+0.35*sin(time*3.0);
    gl_FragColor=vec4(m.rgb, m.a*p*fade); }`;
