const test = require('node:test');
const assert = require('node:assert/strict');

const serverModule = require('./index');

const {
  applyRegionForClient,
  assignRegionForPlayerKey,
  assignRegionForToken,
  normalizeRegionId,
  registerMediaCommand,
} = serverModule;

const {
  clientsByToken,
  activeMediaByRegion,
  activeMediaByToken,
  tokensByRegion,
  resetInMemoryStores,
} = serverModule._internals;

test.beforeEach(() => {
  resetInMemoryStores();
});

test('applyRegionForClient assigns preconfigured region and syncs playback', () => {
  const originalNow = Date.now;
  try {
    const baseTime = 1_000_000;
    Date.now = () => baseTime;

    const regionId = normalizeRegionId('Spawn Plaza', { displayName: 'Spawn Plaza' });
    assignRegionForPlayerKey('id:player-123', regionId);

    registerMediaCommand(activeMediaByRegion, regionId, {
      type: 'VIDEO_INIT',
      url: 'https://cdn.example.com/intro.mp4',
      startAtEpochMs: baseTime,
      volume: 0.5,
    });
    registerMediaCommand(activeMediaByRegion, regionId, {
      type: 'VIDEO_PLAY',
      startAtEpochMs: baseTime,
      atMs: 0,
      volume: 0.5,
    });

    Date.now = () => baseTime + 3000;

    const sentMessages = [];
    const token = 'token-abc';
    clientsByToken.set(token, {
      ws: {
        readyState: 1,
        send(payload) {
          sentMessages.push(JSON.parse(payload));
        },
      },
      playerId: 'player-123',
      playerUuid: null,
      playerName: null,
      region: null,
      regionDisplayName: null,
    });

    const assignedRegion = applyRegionForClient(token, clientsByToken.get(token));

    assert.equal(assignedRegion, regionId);
    assert.equal(clientsByToken.get(token).region, regionId);
    assert.equal(sentMessages.length, 2);
    assert.equal(sentMessages[0].type, 'VIDEO_INIT');
    assert.equal(sentMessages[0].resume, true);
    assert.equal(sentMessages[0].url, 'https://cdn.example.com/intro.mp4');
    assert.equal(sentMessages[1].type, 'VIDEO_PLAY');
    assert.equal(sentMessages[1].atMs, 3000);
    assert(sentMessages[1].autoclose === false || sentMessages[1].autoclose === undefined);

    const perTokenRecord = activeMediaByToken.get(token);
    assert(perTokenRecord, 'expected media record for token');
    assert.equal(perTokenRecord.state.status, 'playing');
    assert.equal(perTokenRecord.state.url, 'https://cdn.example.com/intro.mp4');

    const members = tokensByRegion.get(regionId);
    assert(members && members.has(token), 'token should be tracked in region membership');
  } finally {
    Date.now = originalNow;
  }
});

test('applyRegionForClient resumes playback for returning player', () => {
  const originalNow = Date.now;
  try {
    const baseTime = 2_000_000;
    Date.now = () => baseTime;

    const regionId = normalizeRegionId('Lobby', { displayName: 'Lobby' });
    assignRegionForPlayerKey('id:player-xyz', regionId);

    registerMediaCommand(activeMediaByRegion, regionId, {
      type: 'VIDEO_INIT',
      url: 'https://cdn.example.com/welcome.mp4',
      startAtEpochMs: baseTime,
      volume: 0.8,
    });
    registerMediaCommand(activeMediaByRegion, regionId, {
      type: 'VIDEO_PLAY',
      startAtEpochMs: baseTime,
      atMs: 0,
      volume: 0.8,
    });

    Date.now = () => baseTime + 1200;
    const firstMessages = [];
    const firstToken = 'token-old';
    clientsByToken.set(firstToken, {
      ws: {
        readyState: 1,
        send(payload) {
          firstMessages.push(JSON.parse(payload));
        },
      },
      playerId: 'player-xyz',
      playerUuid: null,
      playerName: null,
      region: null,
      regionDisplayName: null,
    });

    const firstAssigned = applyRegionForClient(firstToken, clientsByToken.get(firstToken));
    assert.equal(firstAssigned, regionId);
    assert.equal(firstMessages[0].type, 'VIDEO_INIT');
    assert.equal(firstMessages[1].type, 'VIDEO_PLAY');
    assert.equal(firstMessages[1].atMs, 1200);

    assignRegionForToken(firstToken, null, { alreadyCanonical: true });
    clientsByToken.delete(firstToken);

    Date.now = () => baseTime + 4800;

    const secondMessages = [];
    const reconnectToken = 'token-new';
    clientsByToken.set(reconnectToken, {
      ws: {
        readyState: 1,
        send(payload) {
          secondMessages.push(JSON.parse(payload));
        },
      },
      playerId: 'player-xyz',
      playerUuid: null,
      playerName: null,
      region: null,
      regionDisplayName: null,
    });

    const secondAssigned = applyRegionForClient(reconnectToken, clientsByToken.get(reconnectToken));
    assert.equal(secondAssigned, regionId);
    assert.equal(secondMessages[0].type, 'VIDEO_INIT');
    assert.equal(secondMessages[1].type, 'VIDEO_PLAY');
    assert.equal(secondMessages[1].atMs, 4800);

    const members = tokensByRegion.get(regionId);
    assert(members && members.has(reconnectToken), 'returning token should be tracked in region');
    assert(!members || !members.has(firstToken), 'old token should not remain in region members');
  } finally {
    Date.now = originalNow;
  }
});
