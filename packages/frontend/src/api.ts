import axios, { AxiosInstance } from 'axios';
import type {
  Task,
  Run,
  BridgeThread,
  ApiResponse,
  TaskListResponse,
  TaskStatsResponse,
  TaskDetailResponse,
  RunDetailResponse,
  SessionListResponse,
  SessionDetailResponse,
  SessionHistoryResponse,
  AcpSessionResponse,
  CreateTaskPayload,
  CreateSessionPayload,
  SendInputPayload,
  DispatchPayload,
  ThreadControlPayload,
} from './types';

const api: AxiosInstance = axios.create({
  baseURL: '/api',
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 90000,
});

api.interceptors.response.use(
  (response) => response.data,
  (error) => {
    if (error.response?.data) {
      return Promise.reject(error.response.data);
    }
    return Promise.reject({ ok: false, error: error.message });
  }
);

export const healthApi = {
  check: (): Promise<ApiResponse & { upstream?: unknown }> => api.get('/health'),
};

export const taskApi = {
  list: (): Promise<TaskListResponse> => api.get('/tasks'),
  getStats: (): Promise<TaskStatsResponse> => api.get('/tasks/stats'),
  getById: (id: string): Promise<TaskDetailResponse> => api.get(`/tasks/${encodeURIComponent(id)}`),
  create: (payload: CreateTaskPayload): Promise<ApiResponse & { result?: unknown; task?: Task; deferred?: boolean }> =>
    api.post('/tasks', payload),
  sendInput: (id: string, payload: SendInputPayload): Promise<ApiResponse & { task?: Task; deferred?: boolean }> =>
    api.post(`/tasks/${encodeURIComponent(id)}/input`, payload),
  terminate: (id: string): Promise<ApiResponse & { task?: Task }> =>
    api.post(`/tasks/${encodeURIComponent(id)}/terminate`),
  dismiss: (id: string): Promise<ApiResponse> =>
    api.delete(`/tasks/${encodeURIComponent(id)}`),
};

export const sessionApi = {
  list: (): Promise<SessionListResponse> => api.get('/sessions'),
  create: (payload: CreateSessionPayload): Promise<SessionDetailResponse> =>
    api.post('/sessions', payload),
  getById: (id: string): Promise<SessionDetailResponse> =>
    api.get(`/sessions/${encodeURIComponent(id)}`),
  getHistory: (id: string): Promise<SessionHistoryResponse> =>
    api.get(`/sessions/${encodeURIComponent(id)}/history`),
  sendInput: (id: string, payload: SendInputPayload): Promise<ApiResponse & { sessionId?: string; deferred?: boolean; result?: unknown }> =>
    api.post(`/sessions/${encodeURIComponent(id)}/input`, payload),
  dispatch: (id: string, payload: DispatchPayload): Promise<ApiResponse & { result?: unknown }> =>
    api.post(`/sessions/${encodeURIComponent(id)}/dispatch`, payload),
  remove: (id: string): Promise<ApiResponse & { result?: unknown }> =>
    api.delete(`/sessions/${encodeURIComponent(id)}`),
};

export const acpApi = {
  listRuns: (): Promise<ApiResponse & { tasks?: Task[] }> => api.get('/tasks'),
  createRun: (payload: CreateTaskPayload): Promise<ApiResponse & { run?: Run; task?: Task; deferred?: boolean; result?: unknown }> =>
    api.post('/acp/runs', payload),
  getRun: (id: string): Promise<RunDetailResponse> =>
    api.get(`/acp/runs/${encodeURIComponent(id)}`),
  sendInput: (id: string, payload: SendInputPayload): Promise<ApiResponse & { run?: Run; task?: Task; deferred?: boolean }> =>
    api.post(`/acp/runs/${encodeURIComponent(id)}/input`, payload),
  pause: (id: string): Promise<ApiResponse & { run?: Run; task?: Task }> =>
    api.post(`/acp/runs/${encodeURIComponent(id)}/pause`),
  resume: (id: string): Promise<ApiResponse & { run?: Run; task?: Task }> =>
    api.post(`/acp/runs/${encodeURIComponent(id)}/resume`),
  terminate: (id: string): Promise<ApiResponse & { run?: Run; task?: Task }> =>
    api.post(`/acp/runs/${encodeURIComponent(id)}/terminate`),
  getSession: (sessionKey: string): Promise<AcpSessionResponse> =>
    api.get(`/acp/sessions/${encodeURIComponent(sessionKey)}`),
};

export const bridgeApi = {
  sendFeishuEvent: (payload: unknown): Promise<ApiResponse> =>
    api.post('/bridge/feishu/events', payload),
  sendOpenClawEvent: (payload: unknown): Promise<ApiResponse> =>
    api.post('/bridge/openclaw/channel/events', payload),
  getThread: (threadId: string): Promise<ApiResponse & { thread?: BridgeThread }> =>
    api.get(`/bridge/threads/${encodeURIComponent(threadId)}`),
  controlThread: (threadId: string, payload: ThreadControlPayload): Promise<ApiResponse & { action?: string; run?: Run; task?: Task }> =>
    api.post(`/bridge/threads/${encodeURIComponent(threadId)}/control`, payload),
};

export const callbackApi = {
  send: (payload: unknown): Promise<ApiResponse> =>
    api.post('/callbacks/openclaw', payload),
  list: (): Promise<ApiResponse & { callbacks?: unknown[] }> =>
    api.get('/callbacks/openclaw'),
};

export default api;
