import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeGmailMessage, send_message_withRequest } from './services/gmail.js';
import { search_conversations_withRequest } from './services/chat.js';
import { computeFreeSlots, find_free_slots_withListEvents } from './services/calendar.js';

test('gmail.encodeGmailMessage builds base64url payload with headers/body', () => {
  const raw = encodeGmailMessage({
    to: 'alice@example.com',
    subject: 'Hello',
    body: 'Test body',
    cc: 'cc@example.com'
  });

  assert.ok(raw.length > 0);
  assert.equal(raw.includes('+'), false);
  assert.equal(raw.includes('/'), false);
  assert.equal(raw.includes('='), false);

  const restored = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.match(restored, /^From: me\r\n/m);
  assert.match(restored, /^To: alice@example.com\r\n/m);
  assert.match(restored, /^Cc: cc@example.com\r\n/m);
  assert.match(restored, /^Subject: Hello\r\n/m);
  assert.match(restored, /\r\n\r\nTest body$/);
});

test('gmail.send_message_withRequest sends encoded raw email', async () => {
  let captured = null;
  const fakeRequest = async (method, path, body) => {
    captured = { method, path, body };
    return { id: 'msg-1', threadId: 'thr-1', labelIds: ['SENT'] };
  };

  const result = await send_message_withRequest(fakeRequest, {
    to: 'bob@example.com',
    subject: 'Subject',
    body: 'Body'
  });

  assert.deepEqual(result, {
    messageId: 'msg-1',
    threadId: 'thr-1',
    labelIds: ['SENT']
  });

  assert.equal(captured.method, 'POST');
  assert.equal(captured.path, '/gmail/v1/users/me/messages/send');
  assert.ok(captured.body.raw);
});

test('chat.search_conversations_withRequest filters by display name (case-insensitive)', async () => {
  let requestPath = null;
  const fakeRequest = async (_method, path) => {
    requestPath = path;
    return {
      spaces: [
        { name: 'spaces/1', displayName: 'Dev Team', spaceType: 'GROUP_CHAT', lastActiveTime: '2026-01-01T10:00:00Z' },
        { name: 'spaces/2', displayName: 'Operations', spaceType: 'GROUP_CHAT', lastActiveTime: '2026-01-01T09:00:00Z' },
        { name: 'spaces/3', displayName: 'DEVELOPERS', spaceType: 'NAMED_SPACE', lastActiveTime: '2026-01-01T08:00:00Z' }
      ],
      nextPageToken: 'next-123'
    };
  };

  const result = await search_conversations_withRequest(fakeRequest, {
    spaceNameQuery: 'dev',
    pageSize: 200
  });

  assert.match(requestPath, /pageSize=100/);
  assert.equal(result.conversations.length, 2);
  assert.deepEqual(result.conversations.map(c => c.conversationId), ['spaces/1', 'spaces/3']);
  assert.equal(result.nextPageToken, 'next-123');
});

test('calendar.computeFreeSlots excludes busy windows and respects interval', () => {
  const events = [
    { start: '2026-07-04T10:30:00.000Z', end: '2026-07-04T11:30:00.000Z', isBusyTime: true },
    { start: '2026-07-04T12:00:00.000Z', end: '2026-07-04T12:30:00.000Z', isBusyTime: true },
    { start: '2026-07-04T09:00:00.000Z', end: '2026-07-04T09:30:00.000Z', isBusyTime: false }
  ];

  const result = computeFreeSlots(
    events,
    '2026-07-04T10:00:00.000Z',
    '2026-07-04T13:00:00.000Z',
    30
  );

  assert.equal(result.slotDurationMinutes, 30);
  assert.deepEqual(result.freeSlots, [
    { start: '2026-07-04T10:00:00.000Z', end: '2026-07-04T10:30:00.000Z' },
    { start: '2026-07-04T11:30:00.000Z', end: '2026-07-04T12:00:00.000Z' },
    { start: '2026-07-04T12:30:00.000Z', end: '2026-07-04T13:00:00.000Z' }
  ]);
});

test('calendar.find_free_slots_withListEvents delegates list and computes slots', async () => {
  let receivedArgs = null;
  const fakeListEvents = async (args) => {
    receivedArgs = args;
    return {
      events: [
        { start: '2026-07-04T10:00:00.000Z', end: '2026-07-04T10:30:00.000Z', isBusyTime: true }
      ]
    };
  };

  const result = await find_free_slots_withListEvents(fakeListEvents, {
    calendarId: 'primary',
    timeMin: '2026-07-04T10:00:00.000Z',
    timeMax: '2026-07-04T11:00:00.000Z',
    interval: 30
  });

  assert.equal(receivedArgs.maxResults, 250);
  assert.equal(result.freeSlots.length, 1);
  assert.deepEqual(result.freeSlots[0], {
    start: '2026-07-04T10:30:00.000Z',
    end: '2026-07-04T11:00:00.000Z'
  });
});
