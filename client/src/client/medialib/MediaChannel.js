import { getGlobalState } from '../../state/store';

export class MediaChannel {
  constructor({ id, originalVolumePct = 100 }) {
    this.id = id;
  // baseVolumePct: the intended loudness from distance/explicit settings
  // currentVolumePct: the actual audible loudness before master, affected by fades/inhibitors
  this.baseVolumePct = originalVolumePct;
  this.currentVolumePct = originalVolumePct;
    this.tagSet = new Set();
    this.tracks = new Map();
    this.mutedByScore = false;
    this.fadeTimers = new Set();
  // When a destroy fade is initiated, we keep the finalizer here so
  // subsequent fades (like distance updates) don't cancel the removal.
  this._pendingRemoveFinalizer = null;
  this._isDestroying = false;
  this._engine = null; // set by MediaEngine.ensureChannel
  }

  setTag(tag) {
    if (!tag) return;
    this.tagSet.add(tag);
    // If engine is present, re-apply inhibitors for this channel when tags change.
    if (this._engine && typeof this._engine._applyInhibitionsFor === 'function') {
      try { this._engine._applyInhibitionsFor(this); } catch {}
    }
  }

  hasTag(tag) { return this.tagSet.has(tag); }

  addTrack(track) {
    this.tracks.set(track.id, track);
    // If a non-looping track ends, auto-remove the channel if this was the last track
    try {
      track.onEnded(() => {
        // Remove this finished track
        this.tracks.delete(track.id);
        if (this.tracks.size === 0 && this._engine) {
          this._engine.removeChannel(this.id);
        }
      });
    } catch {}
    this.updateVolumeFromMaster();
  }

  removeTrack(id) {
    const t = this.tracks.get(id);
    if (t) { t.destroy(); this.tracks.delete(id); }
    if (this.tracks.size === 0 && this._engine) {
      this._engine.removeChannel(this.id);
    }
  }

  setChannelVolumePct(pct) {
    // Update the base volume (e.g., distance or target volume). If not under inhibitor fade, also reflect it immediately.
    this.baseVolumePct = pct;
    // Only snap current volume to base when not actively inhibited (best-effort; engine sets _inhibitorActive)
    if (!this._inhibitorActive && !this._isDestroying) {
      this.currentVolumePct = pct;
    }
    this.updateVolumeFromMaster();
  }

  updateVolumeFromMaster() {
    const master = getGlobalState().settings.normalVolume || 100;
    const pct = (this.currentVolumePct / 100) * (master / 100);
    const result = Math.max(0, Math.min(1, pct));
    for (const t of this.tracks.values()) t.setVolume(result);
    // If fully silent and no tracks are playing, allow cleanup to proceed
    if (result === 0 && this.tracks.size === 0 && this._engine) {
      this._engine.removeChannel(this.id);
    }
  }

  fadeTo(targetPct, ms, cb) {
    // This fade is for base/explicit level changes. If inhibited, we only update baseVolumePct over time
    // and keep currentVolumePct clamped by the inhibitor.
    // If this fade is a destructive one, remember its finalizer.
    if (typeof cb === 'function') {
      this._pendingRemoveFinalizer = cb;
      this._isDestroying = true;
    }

    // If we're already destroying, don't allow new fades to postpone cleanup.
    if (this._isDestroying && this._pendingRemoveFinalizer) {
      // Snap to requested volume, then finalize removal immediately.
      this.setChannelVolumePct(targetPct);
      const fin = this._pendingRemoveFinalizer;
      this._pendingRemoveFinalizer = null;
      this._isDestroying = false;
      if (typeof fin === 'function') fin();
      return;
    }

  // Cancel any ongoing fade timers, but DO NOT clear the pending finalizer.
    for (const id of this.fadeTimers) clearInterval(id);
    this.fadeTimers.clear();

    const finish = () => {
      const fin = this._pendingRemoveFinalizer || cb;
      // Make sure we only run once
      this._pendingRemoveFinalizer = null;
      const wasDestroying = this._isDestroying;
      this._isDestroying = false;
      if (typeof fin === 'function') fin();
      // If this wasn’t a destroying fade, nothing else to do.
      if (!wasDestroying) return;
    };

    if (!ms || ms <= 0) {
      this.baseVolumePct = targetPct;
      // Only snap audible volume when not under inhibitor
      if (!this._inhibitorActive || this._isDestroying) {
        this.currentVolumePct = targetPct;
      }
      this.updateVolumeFromMaster();
      finish();
      return;
    }

    const interval = 25;
    const steps = Math.ceil(ms / interval) || 1;
    const inhibited = !!(this._inhibitorActive && !this._isDestroying);
    const start = inhibited ? this.baseVolumePct : this.currentVolumePct;
    const delta = targetPct - start;
    let n = 0;
    const id = setInterval(() => {
      n++;
      const x = Math.min(1, n / steps);
      const vol = start + delta * x * x; // ease-in quadratic
      if (inhibited) {
        // Only update the underlying base; keep audible volume clamped until inhibitor is gone
        this.baseVolumePct = vol;
      } else {
        this.currentVolumePct = vol;
      }
      this.updateVolumeFromMaster();
      if (n >= steps) {
        clearInterval(id);
        this.fadeTimers.delete(id);
        // Commit the base to target at the end of a base fade
        this.baseVolumePct = targetPct;
        finish();
      }
    }, interval);
    this.fadeTimers.add(id);
  }

  // Fade only the CURRENT audible volume (e.g., inhibitors/ambiance), keeping baseVolumePct intact
  fadeCurrentTo(targetPct, ms, cb) {
    // If this fade is destructive (cb provided), mark as destroying
    if (typeof cb === 'function') {
      this._pendingRemoveFinalizer = cb;
      this._isDestroying = true;
    }

    // Cancel ongoing fades but keep pending finalizer
    for (const id of this.fadeTimers) clearInterval(id);
    this.fadeTimers.clear();

    const finish = () => {
      const fin = this._pendingRemoveFinalizer || cb;
      this._pendingRemoveFinalizer = null;
      const wasDestroying = this._isDestroying;
      this._isDestroying = false;
      if (typeof fin === 'function') fin();
      if (!wasDestroying) return;
    };

    if (!ms || ms <= 0) {
      this.currentVolumePct = targetPct;
      this.updateVolumeFromMaster();
      finish();
      return;
    }

    const interval = 25;
    const steps = Math.ceil(ms / interval) || 1;
    const start = this.currentVolumePct;
    const delta = targetPct - start;
    let n = 0;
    const id = setInterval(() => {
      n++;
      const x = Math.min(1, n / steps);
      const vol = start + delta * x * x;
      this.currentVolumePct = vol;
      this.updateVolumeFromMaster();
      if (n >= steps) {
        clearInterval(id);
        this.fadeTimers.delete(id);
        finish();
      }
    }, interval);
    this.fadeTimers.add(id);
  }

  destroy() {
    for (const id of this.fadeTimers) clearInterval(id);
    this.fadeTimers.clear();
    for (const t of this.tracks.values()) t.destroy();
    this.tracks.clear();
  }
}
