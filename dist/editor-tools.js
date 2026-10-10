// Edit history contains project data only; decoded media and blob URLs stay in the asset library.
export class EditHistory {
  constructor(snapshot, limit = 100) {
    this.current = structuredClone(snapshot); this.past = []; this.future = [];
    this.limit = limit; this.group = null; this.lastEdit = 0;
  }
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
  endGroup() { this.group = null; }
  record(snapshot, group = null, now = Date.now()) {
    const next = structuredClone(snapshot);
    if (JSON.stringify(next.data) === JSON.stringify(this.current.data)) {
      this.current.view = next.view;
      if (!group) this.endGroup();
      return false;
    }
    const merge = group && this.group === group && now - this.lastEdit < 800 && !this.future.length;
    if (!merge) { this.past.push(this.current); if (this.past.length > this.limit) this.past.shift(); }
    this.current = next; this.future = []; this.group = group; this.lastEdit = now;
    return true;
  }
  undo() {
    if (!this.canUndo) return null;
    this.future.push(this.current); this.current = this.past.pop(); this.endGroup();
    return structuredClone(this.current);
  }
  redo() {
    if (!this.canRedo) return null;
    this.past.push(this.current); this.current = this.future.pop(); this.endGroup();
    return structuredClone(this.current);
  }
}

export function fitStage(width, height) {
  const fittedWidth = Math.max(0, Math.min(720, width, height * 16 / 9));
  return { width: fittedWidth, height: fittedWidth * 9 / 16 };
}

// Track labels are sticky: keep the start of the newly selected clip to their right.
export function revealTimeline({ start, duration, zoom, scrollLeft, viewportWidth, trackTop, trackHeight, scrollTop, viewportHeight, labelWidth = 146 }) {
  const margin = 24;
  const x = labelWidth + start * zoom;
  const visibleWidth = Math.max(1, viewportWidth - labelWidth - margin * 2);
  const wantedEnd = x + Math.min(Math.max(12, duration * zoom), visibleWidth);
  let left = scrollLeft;
  if (x < left + labelWidth + margin || wantedEnd > left + viewportWidth - margin) left = Math.max(0, x - labelWidth - margin);
  let top = scrollTop;
  if (trackTop < top) top = trackTop;
  else if (trackTop + trackHeight > top + viewportHeight) top = Math.max(0, trackTop + trackHeight - viewportHeight);
  return { left, top };
}

export function shortcutFor(event, { editing = false, managedText = false, dialogOpen = false } = {}) {
  if (event.isComposing || event.altKey || dialogOpen) return null;
  const modifier = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
  if (modifier && (key === 'z' || key === 'y')) {
    if (editing && !managedText) return null;
    return key === 'y' || event.shiftKey ? 'redo' : 'undo';
  }
  if (editing) return null;
  if (modifier) return key === 'd' ? 'duplicate' : null;
  if (key === 'delete' || key === 'backspace') return 'delete';
  if (event.repeat && [' ', 't', 's', '?'].includes(key)) return null;
  return ({' ': 'play', t: 'text', s: 'split', arrowleft: event.shiftKey ? 'back-second' : 'back-frame', arrowright: event.shiftKey ? 'next-second' : 'next-frame', home: 'start', end: 'end', '?': 'help'})[key] || null;
}
