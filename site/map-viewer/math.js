export function multiply(a,b) {
  const out=new Float32Array(16);
  for(let c=0;c<4;c++) for(let r=0;r<4;r++) for(let k=0;k<4;k++) out[c*4+r]+=a[k*4+r]*b[c*4+k];
  return out;
}
export function cameraMatrix(position,yaw,pitch,aspect,fov=74*Math.PI/180) {
  const sy=Math.sin(yaw),cy=Math.cos(yaw),sp=Math.sin(pitch),cp=Math.cos(pitch);
  const right=[cy,0,-sy],up=[sy*sp,cp,cy*sp],forward=[-sy*cp,sp,-cy*cp];
  const dot=a=>a[0]*position[0]+a[1]*position[1]+a[2]*position[2];
  const view=[right[0],up[0],-forward[0],0,right[1],up[1],-forward[1],0,right[2],up[2],-forward[2],0,-dot(right),-dot(up),dot(forward),1];
  const near=4,far=8192,f=1/Math.tan(fov/2),nf=1/(near-far);
  return multiply([f/aspect,0,0,0,0,f,0,0,0,0,(far+near)*nf,-1,0,0,2*far*near*nf,0],view);
}
