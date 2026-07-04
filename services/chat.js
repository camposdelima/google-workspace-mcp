/**
 * Google Chat API Service
 * Implements tools for Chat spaces and messages
 */

import { getAccessToken } from '../utils/auth.js';
import { httpRequest } from '../utils/http-client.js';

const CHAT_API_HOST = 'chat.googleapis.com';
const PEOPLE_API_HOST = 'people.googleapis.com';

async function chatApiRequest(method, path, body = null) {
  const token = await getAccessToken();
  return httpRequest(method, CHAT_API_HOST, path, body, {
    'Authorization': `Bearer ${token}`
  });
}

async function peopleApiRequest(method, path, body = null) {
  const token = await getAccessToken();
  return httpRequest(method, PEOPLE_API_HOST, path, body, {
    'Authorization': `Bearer ${token}`
  });
}

export function toPeopleResourceName(chatUserName) {
  if (!chatUserName || typeof chatUserName !== 'string') return null;
  if (!chatUserName.startsWith('users/')) return null;

  const userId = chatUserName.slice('users/'.length).trim();
  if (!userId || userId === 'app') return null;

  return `people/${userId}`;
}

function getPrimaryEmail(emailAddresses = []) {
  const primary = emailAddresses.find(e => e.metadata?.primary && e.value);
  if (primary) return primary.value;

  const first = emailAddresses.find(e => e.value);
  return first ? first.value : '';
}

export async function enrichSenderWithPeople(apiRequest, sender, cache = new Map()) {
  if (!sender || sender.userType !== 'HUMAN' || !sender.userId) {
    return sender;
  }

  const peopleResourceName = toPeopleResourceName(sender.userId);
  if (!peopleResourceName) {
    return sender;
  }

  if (cache.has(peopleResourceName)) {
    return {
      ...sender,
      ...cache.get(peopleResourceName)
    };
  }

  let profile = {};

  try {
    const person = await apiRequest(
      'GET',
      `/v1/${encodeURIComponent(peopleResourceName)}?personFields=names,emailAddresses`
    );

    const displayName = person.names?.[0]?.displayName || '';
    const email = getPrimaryEmail(person.emailAddresses || []);

    profile = {
      ...(displayName ? { displayName } : {}),
      ...(email ? { email } : {})
    };
  } catch (_error) {
    profile = {};
  }

  cache.set(peopleResourceName, profile);

  return {
    ...sender,
    ...profile
  };
}

export async function enrichMessagesWithPeople(apiRequest, messages) {
  const cache = new Map();
  return Promise.all(
    messages.map(async (message) => ({
      ...message,
      sender: await enrichSenderWithPeople(apiRequest, message.sender, cache)
    }))
  );
}

export async function search_conversations_withRequest(apiRequest, { spaceNameQuery, pageSize = 100, pageToken }) {
  const params = new URLSearchParams();
  if (pageSize) params.set('pageSize', Math.min(pageSize, 100));
  if (pageToken) params.set('pageToken', pageToken);

  const response = await apiRequest('GET', `/v1/spaces?${params}`);

  let conversations = (response.spaces || []).map(space => ({
    conversationId: space.name,
    displayName: space.displayName || (space.spaceType === 'DIRECT_MESSAGE' ? 'DM' : ''),
    conversationType: space.spaceType === 'DIRECT_MESSAGE'
      ? 'DIRECT_MESSAGE'
      : space.spaceType === 'GROUP_CHAT'
      ? 'GROUP_CHAT'
      : 'NAMED_SPACE',
    lastActiveTimestamp: space.lastActiveTime
  }));

  if (spaceNameQuery) {
    const q = spaceNameQuery.toLowerCase();
    conversations = conversations.filter(c =>
      c.displayName && c.displayName.toLowerCase().includes(q)
    );
  }

  return {
    conversations,
    nextPageToken: response.nextPageToken || ''
  };
}

export async function search_conversations({ spaceNameQuery, pageSize = 100, pageToken }) {
  return search_conversations_withRequest(chatApiRequest, { spaceNameQuery, pageSize, pageToken });
}

export async function list_messages({ conversationId, threadId, pageSize = 20, pageToken, startTime, endTime }) {
  const params = new URLSearchParams();
  params.set('pageSize', Math.min(pageSize, 50));
  if (pageToken) params.set('pageToken', pageToken);

  // Build filter for time range
  const filters = [];
  if (startTime) filters.push(`createTime > "${startTime}"`);
  if (endTime) filters.push(`createTime < "${endTime}"`);
  if (threadId) filters.push(`thread.name = "${threadId}"`);
  if (filters.length > 0) {
    params.set('filter', filters.join(' AND '));
  }

  // Order by createTime desc (newest first)
  params.set('orderBy', 'createTime desc');

  const response = await chatApiRequest('GET', `/v1/${conversationId}/messages?${params}`);

  const mappedMessages = (response.messages || []).map(msg => ({
    messageId: msg.name,
    threadId: msg.thread?.name || '',
    plaintextBody: msg.text || msg.formattedText || '',
    sender: msg.sender ? {
      userId: msg.sender.name,
      displayName: msg.sender.displayName || '',
      email: msg.sender.email || '',
      userType: msg.sender.type === 'BOT' ? 'APP' : 'HUMAN'
    } : null,
    createTime: msg.createTime,
    threadedReply: !!msg.thread && msg.thread.name !== msg.name,
    attachments: (msg.attachment || []).map(att => ({
      attachmentId: att.name,
      filename: att.contentName || '',
      mimeType: att.contentType || '',
      source: att.source === 'DRIVE_FILE' ? 'DRIVE_FILE' : 'UPLOADED_CONTENT'
    })),
    reactionSummaries: (msg.emojiReactionSummaries || []).map(r => ({
      emoji: r.emoji?.unicode || r.emoji?.customEmoji?.uid || '',
      count: r.reactionCount || 0
    }))
  }));

  const messages = await enrichMessagesWithPeople(peopleApiRequest, mappedMessages);

  return {
    messages,
    nextPageToken: response.nextPageToken || ''
  };
}

export async function search_messages({ searchParameters, orderBy = 'RELEVANCE_DESC', pageSize = 25, pageToken }) {
  const params = searchParameters || {};
  const { keywords, conversationId, startTime, endTime, sender, hasLink } = params;

  // If conversationId is provided, search only there
  let spacesToSearch = [];
  if (conversationId) {
    spacesToSearch = [{ conversationId }];
  } else {
    // Get all spaces
    const spaces = await search_conversations({ pageSize: 100 });
    spacesToSearch = spaces.conversations;
  }

  const allMessages = [];
  const searchLimit = pageSize || 25;

  for (const space of spacesToSearch) {
    if (allMessages.length >= searchLimit) break;

    try {
      const messagesData = await list_messages({
        conversationId: space.conversationId,
        pageSize: 50,
        startTime,
        endTime
      });

      let messages = messagesData.messages;

      // Apply filters
      if (keywords && keywords.length > 0) {
        const kwLower = keywords.map(k => k.toLowerCase());
        messages = messages.filter(m => {
          const text = (m.plaintextBody || '').toLowerCase();
          return kwLower.some(k => text.includes(k));
        });
      }

      if (sender) {
        messages = messages.filter(m =>
          m.sender && (m.sender.email === sender || m.sender.userId === sender)
        );
      }

      if (hasLink) {
        messages = messages.filter(m => /https?:\/\//i.test(m.plaintextBody || ''));
      }

      allMessages.push(...messages);
    } catch (e) {
      // Skip spaces with errors
      continue;
    }
  }

  // Sort
  if (orderBy === 'CREATE_TIME_DESC' || orderBy === 'RELEVANCE_DESC') {
    allMessages.sort((a, b) => new Date(b.createTime) - new Date(a.createTime));
  } else if (orderBy === 'CREATE_TIME_ASC') {
    allMessages.sort((a, b) => new Date(a.createTime) - new Date(b.createTime));
  }

  return {
    messages: allMessages.slice(0, searchLimit),
    nextPageToken: ''
  };
}

export async function send_message({ conversationId, messageText, threadId }) {
  const body = {
    text: messageText
  };

  if (threadId) {
    body.thread = { name: threadId };
  }

  const params = threadId ? '?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD' : '';
  const response = await chatApiRequest('POST', `/v1/${conversationId}/messages${params}`, body);

  return {
    message: {
      messageId: response.name,
      threadId: response.thread?.name || '',
      plaintextBody: response.text || '',
      sender: response.sender ? {
        userId: response.sender.name,
        displayName: response.sender.displayName || '',
        email: response.sender.email || '',
        userType: 'HUMAN'
      } : null,
      createTime: response.createTime,
      threadedReply: !!threadId
    }
  };
}
