// REST client. In a browser the session rides in an HttpOnly cookie, so no
// token is ever readable by script. In the desktop app the page has its own
// origin, so it talks to the chosen server with a bearer token instead, kept
// in the operating system's secure storage by the app shell.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const desktop = globalThis.pravdaDesktop ?? null;
let origin = '';
let token = null;

export const isDesktop = () => desktop !== null;

/** Points the client at a server (desktop app) and restores its token. */
export async function configure(serverOrigin) {
  origin = serverOrigin.replace(/\/+$/, '');
  token = desktop ? await desktop.getToken(origin) : null;
}

export function apiOrigin() {
  return origin || location.origin;
}

/** Identifies the server for locally stored keys and pins. */
export function instanceId() {
  return apiOrigin();
}

export async function setToken(value) {
  if (!desktop) return; // browsers keep the session in the cookie
  token = value;
  await desktop.setToken(origin, value);
}

export const bearer = () => token;

function headers(extra = {}) {
  return token ? { ...extra, Authorization: `Bearer ${token}` } : extra;
}

async function request(method, path, body) {
  const options = { method, credentials: token ? 'omit' : 'same-origin', headers: headers() };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(`${origin}/api/v1${path}`, options);
  } catch {
    throw new ApiError(0, 'offline', 'Could not reach the server.');
  }
  if (response.status === 204) return null;
  let data = null;
  try {
    data = await response.json();
  } catch {
    // An empty or non-JSON body is handled by the status check below.
  }
  if (!response.ok) {
    throw new ApiError(response.status, data?.code ?? 'error', data?.message ?? 'Something went wrong.');
  }
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
  patch: (path, body) => request('PATCH', path, body),
  put: (path, body = {}) => request('PUT', path, body),
  del: (path) => request('DELETE', path),
};

/** An absolute URL for server media such as avatars. */
export function mediaUrl(path) {
  if (!path) return '';
  return path.startsWith('/') ? `${origin}${path}` : path;
}

/** Fetches protected media (an encrypted attachment) as bytes. */
export async function fetchMedia(path) {
  const response = await fetch(mediaUrl(path), { credentials: token ? 'omit' : 'same-origin', headers: headers() });
  if (!response.ok) throw new ApiError(response.status, 'media', 'That file could not be fetched.');
  return response.arrayBuffer();
}

/** Uploads bytes, reporting progress from 0 to 1. */
export function upload(data, { kind = 'message', name = 'file', server, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const query = new URLSearchParams({ kind, filename: name });
    if (server) query.set('server', server);
    xhr.open('POST', `${origin}/api/v1/uploads?${query}`);
    xhr.withCredentials = !token;
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response);
      } else {
        const res = xhr.response ?? {};
        reject(new ApiError(xhr.status, res.code ?? 'error', res.message ?? 'The upload failed.'));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, 'offline', 'The upload failed.'));
    xhr.send(data);
  });
}
