import test from 'node:test';
import assert from 'node:assert/strict';
import {wheelPixels,wheelZoom,wheelNumberValue,WheelSteps,setupPrecisionWheel} from '../dist/precision-tools.js';
test('pixel, line and page wheels normalize without losing horizontal trackpad movement',()=>{
 assert.deepEqual(wheelPixels({deltaX:2,deltaY:3,deltaMode:1}),{x:32,y:48});
 assert.deepEqual(wheelPixels({deltaX:0,deltaY:1,deltaMode:2},800),{x:0,y:800});
});
test('zoom keeps the same timestamp under the mouse and clamps supported zoom',()=>{
 const p={zoom:52,scrollLeft:400,pointerX:350,delta:-100,sensitivity:'normal'};
 const z=wheelZoom(p);
 assert.ok(Math.abs((400+350-146)/52-(z.left+350-146)/z.zoom)<1e-9);
 assert.equal(wheelZoom({...p,zoom:600}).zoom,600);
});
test('precise timing advances one millisecond with no floating point drift and respects bounds',()=>{
 assert.equal(wheelNumberValue({value:10.999,step:.001,sensitivity:'precise',direction:1}),11);
 assert.equal(wheelNumberValue({value:.001,step:.001,min:0,sensitivity:'fast',direction:-1}),0);
 assert.equal(wheelNumberValue({value:99,step:1,min:0,max:100,sensitivity:'fast',direction:1}),100);
 assert.equal(wheelNumberValue({value:1,step:.001,sensitivity:'slow',direction:1}),1.01);
});
test('trackpad accumulates small motion and resets on field, direction or idle change',()=>{
 const steps=new WheelSteps();
 assert.equal(steps.take(10,'a',1),0);assert.equal(steps.take(30,'a',2),1);
 assert.equal(steps.take(120,'a',3),1);assert.equal(steps.take(10,'b',4),0);
 assert.equal(steps.take(-40,'b',5),-1);assert.equal(steps.take(10,'b',1000),0);
});
test('ordinary property wheel scrolls without editing; Alt wheel updates using normal change events',()=>{
 const originals=Object.fromEntries(['document','window','localStorage','getComputedStyle'].map(k=>[k,globalThis[k]]));
 try {
  const picker={value:'slow'}, timeline={handlers:{},addEventListener(k,fn){this.handlers[k]=fn;},clientWidth:800,scrollLeft:0,scrollTop:0};
  const root={handlers:{},addEventListener(k,fn){this.handlers[k]=fn;},clientHeight:100,scrollHeight:400,scrollTop:50,parentElement:null};
  let inputEvents=0,changeEvents=0;
  const number={id:'text-start',value:'1.000',step:'.001',min:'0',max:'100',dataset:{},parentElement:root,closest(){return this;},dispatchEvent(e){if(e.type==='input')inputEvents++;if(e.type==='change')changeEvents++;}};
  globalThis.document={getElementById:()=>picker,querySelectorAll:()=>[root],body:{},activeElement:null};
  globalThis.window={scrollBy(){}};globalThis.localStorage={getItem:()=>null,setItem(){}};globalThis.getComputedStyle=()=>({overflowY:'auto'});
  const state={selectedId:'text1',playhead:0};
  setupPrecisionWheel({state,elements:{'timeline-scroll':timeline,'zoom-slider':{}},renderTimeline(){},seekTo(t){state.playhead=t;},pausePlayback(){}});
  let prevented=false;
  const event={target:number,currentTarget:root,deltaX:0,deltaY:100,deltaMode:0,preventDefault(){prevented=true;}};
  root.handlers.wheel(event);assert.equal(number.value,'1.000');assert.equal(root.scrollTop,85);assert.ok(prevented);
  picker.value='precise';picker.onchange();root.handlers.wheel({...event,deltaY:-100,altKey:true});
  assert.equal(number.value,'1.001');assert.equal(inputEvents,1);assert.equal(changeEvents,1);assert.equal(root.scrollTop,85);assert.equal(state.wheelEditGroup,null);
  timeline.handlers.wheel({...event,altKey:true});assert.equal(state.playhead,.001);
 } finally {for(const [k,v] of Object.entries(originals)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}}
});
