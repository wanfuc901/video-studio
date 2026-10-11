export const EXPORT_PRESETS = Object.freeze({
  '1080': Object.freeze({width:1920,height:1080,fps:30,bitrate:12000000,label:'1080p Full HD'}),
  '720': Object.freeze({width:1280,height:720,fps:30,bitrate:6000000,label:'720p HD'})
});
export const WHEEL_PRESETS = Object.freeze({
  precise:{pan:.12,seek:.001,smallStep:1,largeStep:1},
  slow:{pan:.35,seek:.01,smallStep:10,largeStep:1},
  normal:{pan:1,seek:.05,smallStep:50,largeStep:2},
  fast:{pan:2.5,seek:.1,smallStep:100,largeStep:5}
});
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
export const exportPreset=value=>EXPORT_PRESETS[value]||EXPORT_PRESETS['1080'];
export function wheelPixels(event,pageSize=600) {
  const unit=event.deltaMode===1?16:event.deltaMode===2?pageSize:1;
  return {x:event.deltaX*unit,y:event.deltaY*unit};
}
export function wheelZoom({zoom,scrollLeft,pointerX,delta,sensitivity='slow',labelWidth=146}) {
  const factor=WHEEL_PRESETS[sensitivity]||WHEEL_PRESETS.slow;
  const next=clamp(zoom*Math.exp(-clamp(delta,-300,300)*.002*factor.pan),24,600);
  const offset=Math.max(labelWidth,pointerX);
  const time=(scrollLeft+offset-labelWidth)/zoom;
  return {zoom:next,left:Math.max(0,time*next-offset+labelWidth)};
}
export function wheelNumberValue({value,step=1,min=-Infinity,max=Infinity,sensitivity='slow',direction}) {
  if(!Number.isFinite(value)||!(step>0)||!Number.isFinite(step))return value;
  const preset=WHEEL_PRESETS[sensitivity]||WHEEL_PRESETS.slow;
  const multiplier=step<.1?preset.smallStep:preset.largeStep;
  const base=Number.isFinite(min)?min:0;
  const next=base+Math.round((value+direction*step*multiplier-base)/step)*step;
  return Math.round(clamp(next,min,max)*1e6)/1e6;
}
// Accumulate touchpad deltas, but treat a normal mouse notch as one small edit.
export class WheelSteps {
  constructor(){this.value=0;this.key=null;this.at=0;}
  take(delta,key,now=Date.now()) {
    if(key!==this.key||now-this.at>300||Math.sign(delta)!==Math.sign(this.value))this.value=0;
    this.key=key;this.at=now;this.value+=clamp(delta,-100,100);
    const steps=Math.trunc(this.value/40);this.value-=steps*40;
    return clamp(steps,-1,1);
  }
}
export function setupPrecisionWheel({state,elements,renderTimeline,seekTo,pausePlayback}) {
  const timeline=elements['timeline-scroll'],picker=document.getElementById('wheel-sensitivity');
  const steps=new WheelSteps();
  let sensitivity='slow';
  try{const saved=localStorage.getItem('video-studio-wheel');if(WHEEL_PRESETS[saved])sensitivity=saved;}catch{}
  picker.value=sensitivity;
  picker.onchange=()=>{sensitivity=picker.value;try{localStorage.setItem('video-studio-wheel',sensitivity);}catch{}};
  timeline.addEventListener('wheel',event=>{
    event.preventDefault();if(state.exporting||state.drag)return;
    const delta=wheelPixels(event,timeline.clientWidth),preset=WHEEL_PRESETS[sensitivity];
    if(event.ctrlKey||event.metaKey) {
      const next=wheelZoom({zoom:state.zoom,scrollLeft:timeline.scrollLeft,pointerX:event.clientX-timeline.getBoundingClientRect().left,delta:delta.y||delta.x,sensitivity});
      state.zoom=next.zoom;elements['zoom-slider'].value=String(next.zoom);renderTimeline();timeline.scrollLeft=next.left;return;
    }
    if(event.altKey) {
      const amount=steps.take(delta.y||delta.x,'seek:'+sensitivity);
      if(amount){pausePlayback();seekTo(Math.max(0,Math.round((state.playhead+amount*preset.seek)*1000)/1000));}
      return;
    }
    if(event.shiftKey){timeline.scrollTop+=(delta.y||delta.x)*preset.pan;return;}
    timeline.scrollLeft+=(Math.abs(delta.x)>Math.abs(delta.y)?delta.x:delta.y)*preset.pan;
  },{passive:false});
  const propertyWheel=event=>{
    if(event.ctrlKey||event.metaKey)return;
    const root=event.currentTarget;
    const numeric=event.target.closest('input[type="number"],input[type="range"]');
    if(state.exporting){event.preventDefault();return;}
    const delta=wheelPixels(event,root.clientHeight||600);
    if(event.altKey&&numeric&&!numeric.disabled&&!numeric.readOnly) {
      event.preventDefault();
      if(!numeric.value.trim())return;
      const key=numeric.id||numeric.dataset.wheelKey||numeric.ariaLabel;
      const amount=steps.take(delta.y||delta.x,'number:'+state.selectedId+':'+key+':'+sensitivity);
      if(!amount)return;
      const step=Number(numeric.step)||1;
      const next=wheelNumberValue({value:Number(numeric.value),step,min:numeric.min===''?-Infinity:Number(numeric.min),max:numeric.max===''?Infinity:Number(numeric.max),direction:-amount,sensitivity});
      if(!Number.isFinite(next)||next===Number(numeric.value))return;
      const scrolls=[];for(let node=numeric.parentElement;node;node=node.parentElement)if(node.scrollHeight>node.clientHeight)scrolls.push([node,node.scrollTop]);
      const wasFocused=document.activeElement===numeric;
      state.wheelEditGroup='wheel:'+state.selectedId+':'+key;
      try{numeric.value=String(next);numeric.dispatchEvent(new Event('input',{bubbles:true}));numeric.dispatchEvent(new Event('change',{bubbles:true}));}
      finally{state.wheelEditGroup=null;}
      for(const [node,top] of scrolls)node.scrollTop=top;
      if(wasFocused){const replacement=numeric.isConnected?numeric:numeric.id?document.getElementById(numeric.id):[...root.querySelectorAll('[data-wheel-key]')].find(n=>n.dataset.wheelKey===key);replacement?.focus({preventScroll:true});}
      return;
    }
    // Ordinary wheel scrolling must never change a focused number input.
    event.preventDefault();
    let node=event.target;
    const amount=(delta.y||delta.x)*WHEEL_PRESETS[sensitivity].pan;
    while(node&&node!==document.body) {
      if(node.scrollHeight>node.clientHeight+1) {
        const css=getComputedStyle(node);
        if(/auto|scroll/.test(css.overflowY)) {
          const before=node.scrollTop;node.scrollTop+=amount;if(node.scrollTop!==before)return;
        }
      }
      node=node.parentElement;
    }
    window.scrollBy({top:amount,behavior:'instant'});
  };
  for(const root of document.querySelectorAll('.inspector-panel,.precise-transport'))root.addEventListener('wheel',propertyWheel,{passive:false});
}
