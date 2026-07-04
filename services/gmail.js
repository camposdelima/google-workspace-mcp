/**
 * Google Gmail API Service
 * Implements tools for Gmail messages, threads, and labels
 */

import { getAccessToken } from '../utils/auth.js';
import { httpRequest } from '../utils/http-client.js';

const GMAIL_API_HOST = 'gmail.googleapis.com';

async function gmailApiRequest(method, path, body = null) {
  const token = await getAccessToken();
  return httpRequest(method, GMAIL_API_HOST, path, body, {
    'Authorization': `Bearer ${token}`
  });
}

export function encodeGmailMessage({ to, subject, body, cc, bcc }) {
  const headers = [
    'From: me',
    `To: ${to}`,
    `Subject: ${subject}`
  ];

  if (cc) headers.push(`Cc: ${cc}`);
  if (bcc) headers.push(`Bcc: ${bcc}`);

  const email = `${headers.join('\r\n')}\r\n\r\n${body}`;

  return Buffer.from(email)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

export async function send_message_withRequest(apiRequest, { to, subject, body, cc, bcc }) {
  const encodedEmail = encodeGmailMessage({ to, subject, body, cc, bcc });

  const response = await apiRequest('POST', `/gmail/v1/users/me/messages/send`, {
    raw: encodedEmail
  });

  return {
    messageId: response.id,
    threadId: response.threadId,
    labelIds: response.labelIds || []
  };
}

export async function list_messages({ query, maxResults = 10, pageToken }) {
  const params = new URLSearchParams();
  params.set('maxResults', Math.min(maxResults, 100));
  if (query) params.set('q', query);
  if (pageToken) params.set('pageToken', pageToken);

  const response = await gmailApiRequest('GET', `/gmail/v1/users/me/messages?${params}`);

  const messages = (response.messages || []).map(msg => ({
    messageId: msg.id,
    threadId: msg.threadId,
    snippet: msg.snippet || ''
  }));

  return {
    messages,
    resultSizeEstimate: response.resultSizeEstimate || 0,
    nextPageToken: response.nextPageToken || ''
  };
}

export async function get_message({ messageId, format = 'full' }) {
  const params = new URLSearchParams();
  params.set('format', format); // full, metadata, minimal, raw

  const response = await gmailApiRequest('GET', `/gmail/v1/users/me/messages/${messageId}?${params}`);

  // Parse headers from the response
  const headers = response.payload?.headers || [];
  const headerMap = {};
  headers.forEach(h => {
    headerMap[h.name] = h.value;
  });

  return {
    messageId: response.id,
    threadId: response.threadId,
    labels: response.labelIds || [],
    internalDate: response.internalDate,
    subject: headerMap['Subject'] || '',
    from: headerMap['From'] || '',
    to: headerMap['To'] || '',
    snippet: response.snippet || '',
    payload: response.payload || null,
    sizeEstimate: response.sizeEstimate || 0
  };
}

export async function search_messages({ query, maxResults = 25, pageToken }) {
  // Gmail search supports multiple operators: from, to, subject, before, after, etc.
  // Example queries:
  // - "from:example@gmail.com"
  // - "subject:infrastructure"
  // - "before:2026-07-01 after:2026-06-01"
  // - "is:unread"

  const params = new URLSearchParams();
  params.set('maxResults', Math.min(maxResults, 100));
  params.set('q', query || '');
  if (pageToken) params.set('pageToken', pageToken);

  const response = await gmailApiRequest('GET', `/gmail/v1/users/me/messages?${params}`);

  const messages = (response.messages || []).map(msg => ({
    messageId: msg.id,
    threadId: msg.threadId,
    snippet: msg.snippet || ''
  }));

  return {
    messages,
    resultSizeEstimate: response.resultSizeEstimate || 0,
    nextPageToken: response.nextPageToken || ''
  };
}

export async function send_message({ to, subject, body, cc, bcc }) {
  return send_message_withRequest(gmailApiRequest, { to, subject, body, cc, bcc });
}

export async function list_labels() {
  const response = await gmailApiRequest('GET', `/gmail/v1/users/me/labels`);

  const labels = (response.labels || []).map(label => ({
    id: label.id,
    name: label.name,
    messageCount: label.messagesTotal || 0,
    unreadCount: label.messagesUnread || 0,
    type: label.type // SYSTEM or USER
  }));

  return { labels };
}

export async function modify_message({ messageId, addLabels, removeLabels }) {
  const body = {};
  if (addLabels) body.addLabelIds = Array.isArray(addLabels) ? addLabels : [addLabels];
  if (removeLabels) body.removeLabelIds = Array.isArray(removeLabels) ? removeLabels : [removeLabels];

  const response = await gmailApiRequest('POST', `/gmail/v1/users/me/messages/${messageId}/modify`, body);

  return {
    messageId: response.id,
    threadId: response.threadId,
    labels: response.labelIds || []
  };
}
