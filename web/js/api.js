/**
 * KBPRO — 前端 API 客户端
 */
const JSON_HEADERS = { 'Content-Type': 'application/json' };

export class ApiError extends Error {
  constructor(status, message, payload) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

async function request(method, path, { body, formData, signal, raw = false, headers = {} } = {}) {
  const init = { method, credentials: 'same-origin', headers: { ...headers }, signal };
  if (formData) {
    init.body = formData;
  } else if (body !== undefined) {
    init.headers = { ...JSON_HEADERS, ...init.headers };
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(0, '网络连接失败，请检查服务是否运行', null);
  }

  // 会话失效（例如在别处改了密码、或管理员重置了会话）：通知应用壳回到登录页，
  // 否则用户只会在各个页面反复看到「未登录或会话已过期」的提示却无从操作。
  // 登录/注册接口本身的 401 是「密码错误」，不属于会话失效，必须排除。
  if (res.status === 401 && !/\/api\/auth\/(login|register)$/.test(path)) {
    try {
      window.dispatchEvent(new CustomEvent('kbpro:unauthorized', { detail: { path } }));
    } catch { /* 忽略 */ }
  }

  if (raw) {
    if (!res.ok) throw new ApiError(res.status, `请求失败（${res.status}）`, null);
    return res;
  }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    if (!res.ok) throw new ApiError(res.status, `请求失败（${res.status}）`, null);
    return res;
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || (data && data.ok === false)) {
    throw new ApiError(res.status, data?.error || `请求失败（${res.status}）`, data);
  }
  return data;
}

const get = (p, opts) => request('GET', p, opts);
const post = (p, body, opts) => request('POST', p, { body, ...opts });
const put = (p, body, opts) => request('PUT', p, { body, ...opts });
const patch = (p, body, opts) => request('PATCH', p, { body, ...opts });
const del = (p, opts) => request('DELETE', p, opts);

function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, x));
    else sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/* ------------------------------------------------------------------ API */

export const api = {
  /* --- 认证 --- */
  login: (email, password) => post('/api/auth/login', { email, password }),
  register: (name, email, password) => post('/api/auth/register', { name, email, password }),
  logout: () => post('/api/auth/logout'),
  me: () => get('/api/auth/me'),

  /* --- 个人中心 --- */
  updateMe: (payload) => patch('/api/users/me', payload),
  changePassword: (oldPassword, newPassword) => post('/api/users/me/password', { oldPassword, newPassword }),
  deleteAccount: (password) => del('/api/users/me', { body: { password } }),
  storage: () => get('/api/users/me/storage'),
  aiConfig: () => get('/api/users/me/ai'),
  testAiConfig: (payload) => post('/api/users/me/ai/test', payload),
  saveAiConfig: (payload) => put('/api/users/me/ai', payload),
  searchUsers: (q) => get(`/api/users/search${qs({ q })}`),
  notifications: () => get('/api/notifications'),
  readNotifications: (ids) => post('/api/notifications/read', { ids }),

  /* --- 知识库 --- */
  workspaces: () => get('/api/workspaces'),
  createWorkspace: (payload) => post('/api/workspaces', payload),
  updateWorkspace: (id, payload) => patch(`/api/workspaces/${id}`, payload),
  deleteWorkspace: (id) => del(`/api/workspaces/${id}`),
  overview: (id) => get(`/api/workspaces/${id}/overview`),
  activity: (id, params) => get(`/api/workspaces/${id}/activity${qs(params)}`),
  folders: (id) => get(`/api/workspaces/${id}/folders`),
  tags: (id) => get(`/api/workspaces/${id}/tags`),
  tagCloud: (id) => get(`/api/workspaces/${id}/tagcloud`),
  graph: (id, params) => get(`/api/workspaces/${id}/graph${qs(params)}`),
  exportWorkspaceUrl: (id, includeFiles = true) => `/api/workspaces/${id}/export${qs({ includeFiles: includeFiles ? 1 : 0 })}`,

  /* --- 团队 --- */
  teams: () => get('/api/teams'),
  createTeam: (payload) => post('/api/teams', payload),
  updateTeam: (id, payload) => patch(`/api/teams/${id}`, payload),
  members: (id) => get(`/api/teams/${id}/members`),
  addMember: (id, email, role) => post(`/api/teams/${id}/members`, { email, role }),
  updateMember: (id, userId, role) => patch(`/api/teams/${id}/members/${userId}`, { role }),
  removeMember: (id, userId) => del(`/api/teams/${id}/members/${userId}`),

  /* --- 文件夹 --- */
  createFolder: (payload) => post('/api/folders', payload),
  updateFolder: (id, payload) => patch(`/api/folders/${id}`, payload),
  moveFolder: (id, parentId) => post(`/api/folders/${id}/move`, { parentId }),
  deleteFolder: (id, mode = 'move-to-root') => del(`/api/folders/${id}${qs({ mode })}`),
  breadcrumb: (id) => get(`/api/folders/${id}/breadcrumb`),

  /* --- 标签 --- */
  updateTag: (id, payload) => patch(`/api/tags/${id}`, payload),
  deleteTag: (id) => del(`/api/tags/${id}`),

  /* --- 文件 --- */
  files: (params) => get(`/api/files${qs(params)}`),
  file: (id) => get(`/api/files/${id}`),
  fileText: (id) => get(`/api/files/${id}/text`),
  filePreview: (id, token) => get(`/api/files/${id}/preview${qs({ token })}`),
  fileContentUrl: (id, { download = false, inline = true, token } = {}) => `/api/files/${id}/content${qs({ download: download ? 1 : 0, inline: inline ? 1 : 0, token })}`,
  updateFile: (id, payload) => patch(`/api/files/${id}`, payload),
  deleteFile: (id, hard = false) => del(`/api/files/${id}${qs({ hard: hard ? 1 : 0 })}`),
  restoreFile: (id) => post(`/api/files/${id}/restore`),
  batchFiles: (action, ids, extra = {}) => post('/api/files/batch', { action, ids, ...extra }),
  reindexFile: (id, sync = false) => post(`/api/files/${id}/reindex`, { sync }),
  relatedFiles: (id, limit = 8) => get(`/api/files/${id}/related${qs({ limit })}`),
  fileAnalysis: (id) => get(`/api/files/${id}/analysis`),
  fileExportUrl: (id, format = 'md') => `/api/files/${id}/export${qs({ format })}`,
  createTextFile: (payload) => post('/api/files/text', payload),

  /** 上传（带进度） */
  upload(files, { workspaceId, folderId, tags, encrypt, autoIndex }, onProgress, signal) {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      fd.append('workspaceId', workspaceId);
      if (folderId) fd.append('folderId', folderId);
      if (tags) fd.append('tags', Array.isArray(tags) ? tags.join(',') : tags);
      if (encrypt) fd.append('encrypt', '1');
      if (autoIndex === false) fd.append('autoIndex', '0');
      for (const f of files) fd.append('file', f, f.name);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/files/upload', true);
      xhr.withCredentials = true;
      if (signal) {
        signal.addEventListener('abort', () => xhr.abort(), { once: true });
      }
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress({ loaded: e.loaded, total: e.total, percent: Math.round((e.loaded / e.total) * 100) });
      };
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
        if (xhr.status >= 200 && xhr.status < 300 && data?.ok) resolve(data);
        else reject(new ApiError(xhr.status, data?.error || `上传失败（${xhr.status}）`, data));
      };
      xhr.onerror = () => reject(new ApiError(0, '上传失败：网络错误', null));
      xhr.onabort = () => reject(new ApiError(0, '上传已取消', null));
      xhr.send(fd);
    });
  },

  /** 笔记内嵌图片上传 */
  uploadAsset(file, { workspaceId, noteId } = {}) {
    const fd = new FormData();
    if (workspaceId) fd.append('workspaceId', workspaceId);
    if (noteId) fd.append('noteId', noteId);
    fd.append('file', file, file.name);
    return request('POST', '/api/uploads/asset', { formData: fd });
  },

  /* --- 笔记 --- */
  notes: (params) => get(`/api/notes${qs(params)}`),
  note: (id) => get(`/api/notes/${id}`),
  createNote: (payload) => post('/api/notes', payload),
  saveNote: (id, payload) => put(`/api/notes/${id}`, payload),
  deleteNote: (id, hard = false) => del(`/api/notes/${id}${qs({ hard: hard ? 1 : 0 })}`),
  restoreNote: (id) => post(`/api/notes/${id}/restore`),
  noteVersions: (id) => get(`/api/notes/${id}/versions`),
  noteVersion: (id, v) => get(`/api/notes/${id}/versions/${v}`),
  restoreNoteVersion: (id, v) => post(`/api/notes/${id}/versions/${v}/restore`),
  duplicateNote: (id) => post(`/api/notes/${id}/duplicate`),
  batchNotes: (action, ids, extra = {}) => post('/api/notes/batch', { action, ids, ...extra }),
  noteExportUrl: (id, format = 'md') => `/api/notes/${id}/export${qs({ format })}`,

  /* --- 检索 --- */
  search: (params) => get(`/api/search${qs(params)}`),
  suggest: (params) => get(`/api/search/suggest${qs(params)}`),

  /* --- 共享 --- */
  shares: (resourceType, resourceId) => get(`/api/shares${qs({ resourceType, resourceId })}`),
  createShare: (payload) => post('/api/shares', payload),
  deleteShare: (id) => del(`/api/shares/${id}`),
  shareByToken: (token) => get(`/api/share/${token}`),

  /* --- 评论 --- */
  comments: (resourceType, resourceId) => get(`/api/comments${qs({ resourceType, resourceId })}`),
  addComment: (payload) => post('/api/comments', payload),
  updateComment: (id, payload) => patch(`/api/comments/${id}`, payload),
  deleteComment: (id) => del(`/api/comments/${id}`),

  /* --- 协作 --- */
  collabPatch: (type, id, payload) => post(`/api/collab/${type}/${id}/patch`, payload),
  acquireLock: (type, id) => post(`/api/locks/${type}/${id}`),
  releaseLock: (type, id) => del(`/api/locks/${type}/${id}`),

  /* --- AI --- */
  aiStatus: () => get('/api/ai/status'),
  analyze: (payload) => post('/api/ai/analyze', payload),
  compare: (fileIds) => post('/api/ai/compare', { fileIds }),
  expand: (payload) => post('/api/ai/expand', payload),
  reindex: (payload) => post('/api/ai/reindex', payload),

  chats: (params) => get(`/api/chats${qs(params)}`),
  chat: (id) => get(`/api/chats/${id}`),
  updateChat: (id, payload) => patch(`/api/chats/${id}`, payload),
  deleteChat: (id) => del(`/api/chats/${id}`),
  messageFeedback: (id, feedback) => post(`/api/messages/${id}/feedback`, { feedback }),

  /**
   * 流式问答（SSE over fetch）
   * @param {{question:string, workspaceId?:string, chatId?:string, fileIds?:string[], topK?:number}} payload
   * @param {{onContexts?:Function, onToken?:Function, onDone?:Function, onError?:Function, signal?:AbortSignal}} handlers
   */
  async ask(payload, handlers = {}) {
    const res = await fetch('/api/ai/ask', {
      method: 'POST',
      credentials: 'same-origin',
      headers: JSON_HEADERS,
      body: JSON.stringify({ ...payload, stream: true }),
      signal: handlers.signal
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new ApiError(res.status, data?.error || `请求失败（${res.status}）`, data);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    let result = { chatId: payload.chatId || '', content: '', citations: [] };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const blocks = buf.split('\n\n');
      buf = blocks.pop() || '';
      for (const block of blocks) {
        if (!block.trim() || block.startsWith(':')) continue;
        const evLine = block.split('\n').find((l) => l.startsWith('event:'));
        const dataLines = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
        if (!evLine || !dataLines.length) continue;
        const ev = evLine.slice(6).trim();
        let data = null;
        try { data = JSON.parse(dataLines.join('\n')); } catch { continue; }
        if (ev === 'start') { result.chatId = data.chatId || result.chatId; handlers.onStart?.(data); }
        else if (ev === 'contexts') { result.citations = data.citations || []; handlers.onContexts?.(data); }
        else if (ev === 'token') { result.content += data.text || ''; handlers.onToken?.(data.text || ''); }
        else if (ev === 'done') { result = { ...result, ...data, content: result.content }; handlers.onDone?.(data); }
        else if (ev === 'error') { handlers.onError?.(new Error(data.message || '生成失败')); }
      }
    }
    return result;
  },

  /* --- 备份 / 系统 --- */
  backups: () => get('/api/backups'),
  createBackup: (payload) => post('/api/backups', payload),
  deleteBackup: (id) => del(`/api/backups/${id}`),
  restoreBackup: (id, payload) => post(`/api/backups/${id}/restore`, payload),
  backupDownloadUrl: (id) => `/api/backups/${id}/download`,
  logs: (params) => get(`/api/logs${qs(params)}`),
  clearLogs: () => del('/api/logs'),
  settings: () => get('/api/settings'),
  saveSettings: (payload) => patch('/api/settings', payload),
  systemStats: () => get('/api/system/stats'),
  health: () => get('/api/health'),

  /** 创建 SSE 连接 */
  events() {
    return new EventSource('/api/events', { withCredentials: true });
  },
  collabStream(type, id) {
    return new EventSource(`/api/collab/${type}/${id}/stream`, { withCredentials: true });
  },

  request,
  qs
};

export default api;
