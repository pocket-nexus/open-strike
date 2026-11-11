import {cameraMatrix} from './math.js';
const $=id=>document.getElementById(id);
const canvas=$('canvas'),keys=new Set();
let running=true,dirty=true,current=0,drag=null,position=[0,64,0],yaw=0,pitch=0;
let scene,config,gl;
function fail(error) {
  running=false;$('loading').hidden=true;$('error').hidden=false;
  $('error-message').textContent=error.message || 'Please reload and try again.';
  console.error(error);
}
$('retry').onclick=()=>location.reload();
$('help-toggle').onclick=()=>{const show=$('help').hidden;$('help').hidden=!show;$('help-toggle').setAttribute('aria-expanded',String(show));};
canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();fail(new Error('Graphics paused. Reload to return to the scene.'));});
async function fetchFile(path,json=false){const response=await fetch(path);if(!response.ok)throw new Error('A scene file could not be loaded. Please try again.');return json?response.json():response.arrayBuffer();}
function program(vertex,fragment){
  const compile=(type,source)=>{const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(shader));return shader;};
  const result=gl.createProgram(),vs=compile(gl.VERTEX_SHADER,vertex),fs=compile(gl.FRAGMENT_SHADER,fragment);
  gl.attachShader(result,vs);gl.attachShader(result,fs);gl.linkProgram(result);gl.deleteShader(vs);gl.deleteShader(fs);
  if(!gl.getProgramParameter(result,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(result));return result;
}
function choose(index,focus=false){
  current=Math.max(0,Math.min(config.views.length-1,index));const view=config.views[current];
  position=[...view.position];yaw=view.yaw??0;pitch=view.pitch??0;keys.clear();dirty=true;
  $('view-name').textContent=view.label;
  [...$('views').children].forEach((button,i)=>button.setAttribute('aria-pressed',String(i===current)));
  history.replaceState(null,'',`#view=${current+1}`);
  if(focus)canvas.focus({preventScroll:true});
}
function move(dt){
  const x=Number(keys.has('d'))-Number(keys.has('a')),z=Number(keys.has('w'))-Number(keys.has('s')),y=Number(keys.has('e'))-Number(keys.has('q'));
  const length=Math.hypot(x,y,z);if(!length)return;
  const speed=(keys.has('shift')?480:180)*dt/length,sy=Math.sin(yaw),cy=Math.cos(yaw);
  position[0]+=(cy*x-sy*z)*speed;position[1]+=y*speed;position[2]+=(-sy*x-cy*z)*speed;
  for(let i=0;i<3;i++)position[i]=Math.max(scene.bounds[0][i]-128,Math.min(scene.bounds[1][i]+128,position[i]));
  dirty=true;
}
canvas.addEventListener('pointerdown',e=>{if(e.button!==0)return;canvas.focus({preventScroll:true});canvas.setPointerCapture(e.pointerId);drag={id:e.pointerId,x:e.clientX,y:e.clientY};canvas.classList.add('dragging');});
canvas.addEventListener('pointermove',e=>{if(!drag||drag.id!==e.pointerId)return;yaw-=(e.clientX-drag.x)*.004;pitch=Math.max(-1.45,Math.min(1.45,pitch-(e.clientY-drag.y)*.004));drag.x=e.clientX;drag.y=e.clientY;dirty=true;});
const release=()=>{drag=null;canvas.classList.remove('dragging');};
canvas.addEventListener('pointerup',release);canvas.addEventListener('pointercancel',release);canvas.addEventListener('lostpointercapture',release);
canvas.addEventListener('keydown',e=>{const key=e.key.toLowerCase();if(['w','a','s','d','q','e','shift'].includes(key)){keys.add(key);e.preventDefault();}if(key==='escape'){keys.clear();canvas.blur();$('help').hidden=true;$('help-toggle').setAttribute('aria-expanded','false');}});
window.addEventListener('keyup',e=>keys.delete(e.key.toLowerCase()));
window.addEventListener('blur',()=>{keys.clear();release();});canvas.addEventListener('blur',()=>keys.clear());
document.addEventListener('visibilitychange',()=>keys.clear());
for(const button of document.querySelectorAll('[data-move]')){
  button.addEventListener('pointerdown',e=>{e.preventDefault();button.setPointerCapture(e.pointerId);keys.add(button.dataset.move);});
  for(const type of ['pointerup','pointercancel','lostpointercapture'])button.addEventListener(type,()=>keys.delete(button.dataset.move));
}
async function main(){
  [config,scene]=await Promise.all([fetchFile('map.json',true),fetchFile('assets/scene.json',true)]);
  if(scene.version!==1||scene.vertexStride!==20||!config.views?.length)throw new Error('This scene needs a newer viewer.');
  document.title=`${config.title} · OpenStrike`;
  $('location').textContent=config.location;
  $('title').replaceChildren(...(config.heading??[config.title]).map(line=>{const span=document.createElement('span');span.textContent=line;return span;}));
  $('description').textContent=config.description;
  if(config.reference){$('reference').href=config.reference;}else{$('reference').hidden=true;$('story-text').textContent=config.description;document.querySelector('.story .muted').hidden=true;}
  $('view-count').textContent=`${config.views.length} viewpoints`;
  config.views.forEach((view,index)=>{
    const button=document.createElement('button'),number=document.createElement('span');number.textContent=String(index+1).padStart(2,'0');
    button.append(number,document.createTextNode(view.label));button.setAttribute('aria-pressed','false');button.onclick=()=>choose(index,true);$('views').append(button);
  });
  gl=canvas.getContext('webgl2',{alpha:false,antialias:true,powerPreference:'low-power'});
  if(!gl)throw new Error('This browser needs WebGL 2 to open the 3D scene.');
  const geometry=await fetchFile('assets/geometry.bin');
  if(geometry.byteLength!==scene.geometryBytes||scene.indexOffset+scene.indexCount*2!==geometry.byteLength)throw new Error('The scene download is incomplete.');
  const world=program(`#version 300 es
  layout(location=0) in vec3 position;layout(location=1) in vec2 uv;layout(location=2) in vec4 light;
  uniform mat4 mvp;out vec2 vUv;out vec4 vLight;void main(){vUv=uv;vLight=light;gl_Position=mvp*vec4(position,1.0);}`,
  `#version 300 es
  precision mediump float;in vec2 vUv;in vec4 vLight;uniform sampler2D image;uniform bool masked;out vec4 color;
  void main(){vec4 tex=texture(image,vUv)*vLight;if(masked && tex.a<=0.25)discard;color=vec4(tex.rgb,1.0);}`);
  const sky=program(`#version 300 es
  out float vertical;void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);vertical=p.y;gl_Position=vec4(p*2.0-1.0,0.0,1.0);}`,
  `#version 300 es
  precision mediump float;in float vertical;uniform vec3 zenith;uniform vec3 horizon;uniform float pitch;out vec4 color;
  void main(){float t=pow(max(sin(pitch+(vertical-0.5)*1.29154),0.0),0.65);color=vec4(mix(horizon,zenith,t),1.0);}`);
  const uniform={mvp:gl.getUniformLocation(world,'mvp'),masked:gl.getUniformLocation(world,'masked'),pitch:gl.getUniformLocation(sky,'pitch')};
  gl.useProgram(sky);gl.uniform3fv(gl.getUniformLocation(sky,'zenith'),scene.sky.zenith);gl.uniform3fv(gl.getUniformLocation(sky,'horizon'),scene.sky.horizon);
  const vao=gl.createVertexArray(),buffer=gl.createBuffer();gl.bindVertexArray(vao);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,geometry,gl.STATIC_DRAW);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,buffer);
  [0,1,2].forEach(i=>gl.enableVertexAttribArray(i));
  const textures=await Promise.all(scene.textures.map(async metadata=>{
    const pixels=await fetchFile(`assets/${metadata.file}`);if(pixels.byteLength!==metadata.width*metadata.height*4)throw new Error('A texture download is incomplete.');
    const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,metadata.width,metadata.height,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(pixels));
    gl.generateMipmap(gl.TEXTURE_2D);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.REPEAT);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.REPEAT);return texture;
  }));
  const draw=()=>{
    const scale=Math.min(devicePixelRatio||1,2),width=Math.round(canvas.clientWidth*scale),height=Math.round(canvas.clientHeight*scale);
    if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
    gl.viewport(0,0,width,height);gl.clearDepth(1);gl.clear(gl.DEPTH_BUFFER_BIT);gl.disable(gl.DEPTH_TEST);gl.disable(gl.BLEND);gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(null);gl.useProgram(sky);gl.uniform1f(uniform.pitch,pitch);gl.drawArrays(gl.TRIANGLES,0,3);
    gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.useProgram(world);gl.uniformMatrix4fv(uniform.mvp,false,cameraMatrix(position,yaw,pitch,width/height));
    gl.bindVertexArray(vao);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
    for(const batch of scene.batches){
      const base=batch.vertexBase*20;
      gl.vertexAttribPointer(0,3,gl.SHORT,false,20,base+12);gl.vertexAttribPointer(1,2,gl.FLOAT,false,20,base);gl.vertexAttribPointer(2,4,gl.UNSIGNED_BYTE,true,20,base+8);
      gl.bindTexture(gl.TEXTURE_2D,textures[batch.texture]);gl.uniform1i(uniform.masked,batch.alphaTest?1:0);
      gl.drawElements(gl.TRIANGLES,batch.indexCount,gl.UNSIGNED_SHORT,scene.indexOffset+batch.indexBase*2);
    }
    dirty=false;
  };
  new ResizeObserver(()=>{dirty=true;}).observe(canvas);
  $('reset').onclick=()=>choose(current,true);
  const initial=Number(new URLSearchParams(location.hash.slice(1)).get('view')??1)-1;choose(Number.isFinite(initial)?initial:0);
  draw();if(gl.getError()!==gl.NO_ERROR)throw new Error('The scene could not be drawn. Please reload.');
  $('loading').hidden=true;canvas.dataset.ready='true';
  let last=performance.now();function frame(now){if(!running)return;const dt=Math.min(.05,(now-last)/1000);last=now;move(dt);if(dirty)draw();requestAnimationFrame(frame);}requestAnimationFrame(frame);
}
main().catch(fail);
