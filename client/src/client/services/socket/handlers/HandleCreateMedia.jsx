import { MediaManager } from '../../media/MediaManager';
import { MediaTrack } from '../../../medialib/MediaTrack';
import { MediaEngine } from '../../../medialib/MediaEngine';
import { debugLog } from '../../debugging/DebugService';
import { AudioPreloader } from '../../preloading/AudioPreloader';
import { MEDIA_MUTEX } from '../../../util/mutex';
import { AudioSourceProcessor } from '../../../util/AudioSourceProcessor';

const sourceRewriter = new AudioSourceProcessor();

export async function handleCreateMedia(data) {
  function convertDistanceToVolume(maxDistance, currentDistance) {
    return Math.round(((maxDistance - currentDistance) / maxDistance) * 100);
  }

  function normalizeInstant(value) {
    if (!value) return null;
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return value;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  const looping = data.media.loop;
  const { startInstant } = data.media;
  const id = data.media.mediaId;
  let { source } = data.media;
  const { doPickup } = data.media;
  const { fadeTime } = data.media;
  const { distance } = data;
  const { flag } = data.media;
  const { maxDistance } = data;
  const { muteRegions, muteSpeakers } = data.media;
  const { startAtMillis } = data.media;
  const { speed } = data.media;
  let volume = 100;

  await MEDIA_MUTEX.lock();
  try {
    const initialSource = source;
    source = await sourceRewriter.translate(source);
    console.log(`translaged source ${initialSource} to ${source}`);

    // Engine path: create or reuse channel
    const engine = MediaManager.engine instanceof MediaEngine ? MediaManager.engine : new MediaEngine();
    const existingChannel = engine.channels.get(id);
    const normalizedStartAt = startAtMillis ?? 0;
    const normalizedSpeed = (speed != null && speed !== 0) ? speed : 100;

    if (existingChannel && existingChannel.tracks && existingChannel.tracks.size > 0) {
      const iterator = existingChannel.tracks.values().next();
      const existingTrack = iterator && !iterator.done ? iterator.value : null;
      const existingInstant = normalizeInstant(existingTrack ? existingTrack.startInstant : null);
      const targetInstant = normalizeInstant(startInstant);
      const instantsMatch = (existingInstant == null && targetInstant == null)
        || (existingInstant != null && targetInstant != null && Math.abs(existingInstant - targetInstant) <= 250);
      const canReuse = existingTrack
        && existingTrack.source === source
        && existingTrack.loop === !!looping
        && (existingTrack.startAtMillis ?? 0) === normalizedStartAt
        && (existingTrack.speedPct ?? 100) === normalizedSpeed
        && instantsMatch
        && existingTrack.state !== 'destroyed'
        && existingTrack.state !== 'stopped';

      if (canReuse) {
        try {
          existingTrack.setLoop(looping);
          if (existingTrack.speedPct !== normalizedSpeed) existingTrack.setPlaybackSpeed(normalizedSpeed);
          // Re-apply server synced position in case our local timer drifted while paused/loading.
          if (doPickup) existingTrack.applyStartDateIfAny();
          existingChannel.setTag(id);
          existingChannel.setTag(flag);
          if (maxDistance !== 0) {
            existingChannel.setTag('SPECIAL');
            existingChannel.maxDistance = maxDistance;
            const startVolume = convertDistanceToVolume(maxDistance, distance);
            existingChannel.fadeTo(startVolume, fadeTime);
          } else {
            existingChannel.setTag('DEFAULT');
            if (fadeTime === 0) {
              existingChannel.setChannelVolumePct(volume);
            } else {
              existingChannel.fadeTo(volume, fadeTime);
            }
          }
          await existingTrack.play();
        } catch (reuseErr) {
          console.warn(`Failed to reuse media channel ${id}, falling back to full reload`, reuseErr);
        }
        return;
      }
    }

    let preloaded;
    try {
      preloaded = await AudioPreloader.getResource(source, false, true);
    } catch (e) {
      console.error(`Failed to load audio from ${source}`, e);
      return;
    }

    // only if its a new version and provided, then use that volume
    if (data.media.volume != null) {
      volume = data.media.volume;
    }

    // attempt to stop the existing one, if any
    MediaManager.destroySounds(id, false, true);

    const newChannel = engine.ensureChannel(id, volume);
    newChannel.setTag(id);

    // Use the same fadeTime as the media to crossfade regions/speakers
    if (muteRegions) { debugLog('Incrementing region inhibit'); MediaManager.engine.incrementInhibitor('REGION', fadeTime); }
    if (muteSpeakers) { debugLog('Incrementing speaker inhibit'); MediaManager.engine.incrementInhibitor('SPEAKER', fadeTime); }

    // Undo inhibitors when the engine channel is finally removed
    engine.whenFinished(id, async () => {
      // eslint-disable-next-line no-console
      console.log(`Channel ${id} finished, removing inhibitors`);
      try {
        await MEDIA_MUTEX.unlock();
        if (muteRegions) MediaManager.engine.decrementInhibitor('REGION', fadeTime);
        if (muteSpeakers) MediaManager.engine.decrementInhibitor('SPEAKER', fadeTime);
      } finally {
        MEDIA_MUTEX.unlock();
      }
    });

    newChannel.setTag(flag);
    // Preload audio element and create track
    const track = new MediaTrack({
      id: `${id}::0`, source, audio: preloaded, loop: looping, startAtMillis, startInstant,
    });

    if (speed != null && speed !== 1 && speed !== 0) track.setPlaybackSpeed(speed);
    newChannel.addTrack(track);
    if (!looping) {
      track.onEnded(() => {
        if (MediaManager.engine) MediaManager.engine.removeChannel(id);
      });
    }

    newChannel.setChannelVolumePct(0);
    // convert distance
    if (maxDistance !== 0) {
      const startVolume = convertDistanceToVolume(maxDistance, distance);
      newChannel.setTag('SPECIAL');
      newChannel.maxDistance = maxDistance;
      newChannel.fadeTo(startVolume, fadeTime);
    } else {
      // default sound, just play
      newChannel.setTag('DEFAULT');

      if (fadeTime === 0) {
        newChannel.setChannelVolumePct(volume);
      } else {
        newChannel.fadeTo(volume, fadeTime);
      }
    }

    // Start playback via MediaTrack
    if (doPickup) { /* startInstant already handled by track */ }
    await track.play();
  } finally {
    MEDIA_MUTEX.unlock();
  }
}
