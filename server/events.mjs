import { EventEmitter } from 'node:events';
export class Events extends EventEmitter {
  constructor() { super(); this.seq = 0; this.ring = []; this.bytes = 0; this.discardedThrough = 0; }
  push(type, payload = {}, threadId = null) {
    const event = { seq: ++this.seq, type, threadId, payload };
    const encoded = JSON.stringify(event), bytes = Buffer.byteLength(encoded);
    if (bytes <= 1024 * 1024) { this.ring.push({ event, bytes }); this.bytes += bytes; }
    else this.discardedThrough = this.seq;
    while (this.ring.length > 2000 || this.bytes > 4 * 1024 * 1024) { const removed=this.ring.shift();this.bytes-=removed.bytes;this.discardedThrough=Math.max(this.discardedThrough,removed.event.seq); }
    this.emit('event', event);
    return event;
  }
  since(seq) { const gap = !Number.isFinite(seq) || seq > this.seq || seq < this.discardedThrough; return { gap, seq: this.seq, events: gap ? [] : this.ring.filter(r => r.event.seq > seq).map(r => r.event) }; }
}
