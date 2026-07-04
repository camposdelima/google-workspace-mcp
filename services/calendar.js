/**
 * Google Calendar API Service
 * Implements tools for Calendar events and availability
 */

import { getAccessToken } from '../utils/auth.js';
import { httpRequest } from '../utils/http-client.js';

const CALENDAR_API_HOST = 'www.googleapis.com';

async function calendarApiRequest(method, path, body = null) {
  const token = await getAccessToken();
  return httpRequest(method, CALENDAR_API_HOST, path, body, {
    'Authorization': `Bearer ${token}`
  });
}

export function computeFreeSlots(events, timeMin, timeMax, interval = 30) {
  const busySlots = (events || [])
    .filter(e => e.isBusyTime)
    .map(e => ({
      start: new Date(e.start),
      end: new Date(e.end)
    }));

  const start = new Date(timeMin);
  const end = new Date(timeMax);
  const freeSlots = [];
  const intervalMs = interval * 60 * 1000;

  let current = new Date(start);
  while (current < end) {
    const slotEnd = new Date(current.getTime() + intervalMs);
    const isBusy = busySlots.some(busy =>
      current < busy.end && slotEnd > busy.start
    );

    if (!isBusy && slotEnd <= end) {
      freeSlots.push({
        start: current.toISOString(),
        end: slotEnd.toISOString()
      });
    }

    current = new Date(current.getTime() + intervalMs);
  }

  return {
    freeSlots,
    slotDurationMinutes: interval
  };
}

export async function find_free_slots_withListEvents(listEvents, { calendarId = 'primary', timeMin, timeMax, interval = 30 }) {
  const eventsResponse = await listEvents({
    calendarId,
    timeMin,
    timeMax,
    maxResults: 250
  });

  return computeFreeSlots(eventsResponse.events || [], timeMin, timeMax, interval);
}

export async function list_events({ calendarId = 'primary', timeMin, timeMax, maxResults = 10, pageToken }) {
  const params = new URLSearchParams();
  params.set('maxResults', Math.min(maxResults, 250));
  if (timeMin) params.set('timeMin', timeMin); // ISO 8601 format
  if (timeMax) params.set('timeMax', timeMax); // ISO 8601 format
  if (pageToken) params.set('pageToken', pageToken);
  params.set('singleEvents', 'true'); // Expand recurring events
  params.set('orderBy', 'startTime');

  const response = await calendarApiRequest('GET', `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`);

  const events = (response.items || []).map(event => ({
    eventId: event.id,
    title: event.summary || '(No title)',
    description: event.description || '',
    start: event.start?.dateTime || event.start?.date || '',
    end: event.end?.dateTime || event.end?.date || '',
    location: event.location || '',
    attendees: (event.attendees || []).map(a => ({
      email: a.email,
      displayName: a.displayName || '',
      status: a.responseStatus // needsAction, declined, tentativelyAccepted, accepted
    })),
    organizer: event.organizer ? {
      email: event.organizer.email,
      displayName: event.organizer.displayName || ''
    } : null,
    isBusyTime: !event.transparency || event.transparency === 'opaque',
    isRecurring: !!event.recurringEventId
  }));

  return {
    events,
    nextPageToken: response.nextPageToken || '',
    nextSyncToken: response.nextSyncToken || ''
  };
}

export async function get_event({ calendarId = 'primary', eventId }) {
  const response = await calendarApiRequest('GET', `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);

  return {
    eventId: response.id,
    title: response.summary || '',
    description: response.description || '',
    start: response.start?.dateTime || response.start?.date || '',
    end: response.end?.dateTime || response.end?.date || '',
    location: response.location || '',
    attendees: (response.attendees || []).map(a => ({
      email: a.email,
      displayName: a.displayName || '',
      status: a.responseStatus
    })),
    organizer: response.organizer ? {
      email: response.organizer.email,
      displayName: response.organizer.displayName || ''
    } : null,
    isBusyTime: !response.transparency || response.transparency === 'opaque',
    htmlLink: response.htmlLink || ''
  };
}

export async function create_event({ calendarId = 'primary', title, description, start, end, location, attendeeEmails }) {
  const body = {
    summary: title,
    description,
    location,
    start: {
      dateTime: start, // ISO 8601 format
      timeZone: 'UTC'
    },
    end: {
      dateTime: end, // ISO 8601 format
      timeZone: 'UTC'
    }
  };

  if (attendeeEmails && attendeeEmails.length > 0) {
    body.attendees = attendeeEmails.map(email => ({ email }));
    body.sendNotifications = true;
  }

  const response = await calendarApiRequest('POST', `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, body);

  return {
    eventId: response.id,
    title: response.summary || '',
    start: response.start?.dateTime || response.start?.date || '',
    end: response.end?.dateTime || response.end?.date || '',
    htmlLink: response.htmlLink || '',
    status: response.status // confirmed, tentativelyAccepted, declined
  };
}

export async function update_event({ calendarId = 'primary', eventId, title, description, start, end, location }) {
  const body = {};
  if (title) body.summary = title;
  if (description) body.description = description;
  if (location) body.location = location;
  if (start) {
    body.start = {
      dateTime: start,
      timeZone: 'UTC'
    };
  }
  if (end) {
    body.end = {
      dateTime: end,
      timeZone: 'UTC'
    };
  }

  const response = await calendarApiRequest('PATCH', `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, body);

  return {
    eventId: response.id,
    title: response.summary || '',
    status: response.status,
    htmlLink: response.htmlLink || ''
  };
}

export async function delete_event({ calendarId = 'primary', eventId }) {
  await calendarApiRequest('DELETE', `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);

  return {
    deleted: true,
    eventId
  };
}

export async function find_free_slots({ calendarId = 'primary', timeMin, timeMax, interval = 30 }) {
  return find_free_slots_withListEvents(list_events, { calendarId, timeMin, timeMax, interval });
}
