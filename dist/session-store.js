const VERSION = 1;
const DATABASE = 'frameflow-video-studio';
export class SessionConflictError extends Error {
  constructor() { super('Phiên đã được cập nhật ở tab khác. Hãy tiếp tục ở tab đó; tab này chưa ghi đè dữ liệu.'); this.name = 'SessionConflictError'; }
}
export function assetRecord(asset) {
  return { id:asset.id, file:asset.file, name:asset.file.name, type:asset.file.type,
    lastModified:asset.file.lastModified, kind:asset.kind, duration:asset.duration };
}
export function projectRecord({state,projectName,history,aiDraft,scrollLeft=0,scrollTop=0}) {
  return structuredClone({ version:VERSION, projectName, clips:state.clips, assetIds:[...state.assets.keys()],
    selectedId:state.selectedId, playhead:state.playhead, zoom:state.zoom, globalMute:state.globalMute,
    previewSpeed:state.previewSpeed, exportResolution:state.exportSettings.height===720?'720':'1080', beats:state.beats||[],
    scrollLeft,scrollTop, aiDraft,
    history:{current:history.current,past:history.past,future:history.future} });
}
// Blobs are stored once. Metadata and newly imported blobs commit in the SAME transaction.
// No blob URLs, decoded media, API keys or running tasks are persisted.
export function createSessionStore(indexedDB = globalThis.indexedDB) {
  let opening;
  const open=()=>opening ||= new Promise((resolve,reject)=>{
    if(!indexedDB){reject(new Error('Trình duyệt không cho phép lưu phiên.'));return;}
    const request=indexedDB.open(DATABASE,VERSION);
    request.onupgradeneeded=()=>{
      const db=request.result;
      if(!db.objectStoreNames.contains('projects'))db.createObjectStore('projects');
      if(!db.objectStoreNames.contains('assets'))db.createObjectStore('assets',{keyPath:'id'});
    };
    request.onerror=()=>{opening=null;reject(request.error);};
    request.onblocked=()=>{opening=null;reject(new Error('Hãy đóng tab Video Studio cũ rồi thử lại.'));};
    request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();opening=null;};resolve(db);};
  });
  return {
    async load() {
      const db=await open();
      return new Promise((resolve,reject)=>{
        const tx=db.transaction(['projects','assets'],'readonly');let project=null,assets=[],failure;
        tx.onabort=()=>reject(failure||tx.error||new Error('Không đọc được phiên đã lưu.'));
        tx.onerror=()=>{};
        tx.oncomplete=()=>resolve({project,assets,revision:project?.revision??null});
        const request=tx.objectStore('projects').get('current');
        request.onsuccess=()=>{
          project=request.result||null;if(!project)return;
          if(project.version!==VERSION||!Array.isArray(project.clips)||!Array.isArray(project.assetIds)) {
            failure=new Error('Phiên lưu không tương thích. Bản lưu được giữ nguyên.');tx.abort();return;
          }
          for(const id of project.assetIds) {
            const item=tx.objectStore('assets').get(id);
            item.onsuccess=()=>{
              if(!item.result?.file){failure=new Error('Thiếu tệp trong phiên lưu. Bản lưu được giữ nguyên.');tx.abort();}
              else assets.push(item.result);
            };
          }
        };
      });
    },
    async write(project,assets,expectedRevision) {
      const db=await open();
      return new Promise((resolve,reject)=>{
        const tx=db.transaction(['projects','assets'],'readwrite');let failure;
        const revision=crypto.randomUUID();
        tx.onabort=()=>reject(failure||tx.error||new Error('Không thể lưu phiên.'));
        tx.onerror=()=>{};
        tx.oncomplete=()=>resolve(revision);
        const projects=tx.objectStore('projects'),request=projects.get('current');
        request.onsuccess=()=>{
          if((request.result?.revision??null)!==expectedRevision){failure=new SessionConflictError();tx.abort();return;}
          try {
            for(const asset of assets)tx.objectStore('assets').put(asset);
            projects.put({...project,version:VERSION,revision,savedAt:Date.now()},'current');
          } catch(error){failure=error;tx.abort();}
        };
      });
    }
  };
}
export class SessionAutosaver {
  // delayMs>0 coalesces bursts (typing, scrolling, wheel) into one IndexedDB write; flush() writes immediately.
  constructor({store,snapshot,assets,onStatus=()=>{},revision=null,assetIds=[],delayMs=0}) {
    Object.assign(this,{store,snapshot,assets,onStatus,revision,delayMs});
    this.known=new Set(assetIds);this.wanted=0;this.saved=0;this.running=null;this.failed=null;this.scheduled=false;this.timer=null;
  }
  get pending(){return this.wanted>this.saved;}
  schedule() {
    this.wanted++;this.onStatus('saving');
    if(this.delayMs>0){clearTimeout(this.timer);this.timer=setTimeout(()=>{this.timer=null;void this.flush();},this.delayMs);return;}
    if(!this.scheduled){this.scheduled=true;queueMicrotask(()=>{this.scheduled=false;void this.flush();});}
  }
  flush() {
    if(this.timer){clearTimeout(this.timer);this.timer=null;}
    if(this.running)return this.running;
    if(this.failed?.name==='SessionConflictError') {this.onStatus('error',this.failed);return Promise.resolve(false);}
    this.running=this.drain().finally(()=>{this.running=null;});return this.running;
  }
  async drain() {
    try {
      while(this.pending) {
        const generation=this.wanted,project=this.snapshot();
        const assets=this.assets().filter(a=>!this.known.has(a.id)).map(assetRecord);
        this.onStatus('saving');
        this.revision=await this.store.write(project,assets,this.revision);
        for(const asset of assets)this.known.add(asset.id);
        this.saved=generation;this.failed=null;
      }
      this.onStatus('saved');return true;
    } catch(error){this.failed=error;this.onStatus('error',error);return false;}
  }
}
