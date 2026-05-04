export type TaskStatus =
  | 'queued'
  | 'submitted'
  | 'running'
  | 'completed'
  | 'failed'
  | 'terminated'
  | 'paused';

export type ControlState = 'running' | 'paused' | 'terminated';

export type Runtime = 'codex' | 'claude' | 'gemini' | 'opencode' | 'openclaw';

export interface Task {
  id: string;
  status: TaskStatus;
  controlState: ControlState;
  prompt: string;
  metadata?: Record<string, unknown>;
  sessionKey?: string;
  agentId?: string;
  threadId?: string;
  attempt?: number;
  answerText?: string;
  error?: string | null;
  submittedAt?: string | number;
  updatedAt?: string | number;
  completedAt?: string | number;
}

export interface Run {
  id: string;
  taskId: string;
  runId: string;
  prompt: string;
  metadata?: Record<string, unknown>;
  status: TaskStatus;
  agentId?: string;
  threadId?: string;
  attempt?: number;
  controlState: ControlState;
  answerText?: string;
  error?: string | null;
  submittedAt?: string | number;
  updatedAt?: string | number;
  completedAt?: string | number;
}

export interface Session {
  id: string;
  cliType: string | null;
  status: string;
  command?: string;
  args?: string[];
  cwd?: string;
  threadId?: string | null;
  sessionKey?: string | null;
  transport?: string;
  historyCount?: number;
}

export interface SessionHistoryItem {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string | number;
  status?: string;
  source?: string;
  turnId?: string | null;
}

export interface BridgeThread {
  threadId: string;
  sessionKey: string;
  agentId: string;
  runs: Run[];
  updatedAt: number;
  status: string;
  controlState: ControlState;
  lastMessage: string;
}

export interface TaskStats {
  total: number;
  byStatus: Record<string, number>;
  active: number;
  completed: number;
  failed: number;
  terminated: number;
  latestUpdatedAt: number | null;
}

export interface ApiResponse {
  ok: boolean;
  error?: string;
  code?: string;
  conflictTaskId?: string | null;
  upstream?: unknown;
  status?: number;
}

export interface TaskListResponse extends ApiResponse {
  tasks: Task[];
}

export interface TaskStatsResponse extends ApiResponse {
  stats: TaskStats;
}

export interface TaskDetailResponse extends ApiResponse {
  task: Task;
}

export interface RunDetailResponse extends ApiResponse {
  run: Run;
  task: Task;
}

export interface RunListResponse extends ApiResponse {
  runs?: Run[];
}

export interface SessionListResponse extends ApiResponse {
  sessions: Session[];
}

export interface SessionDetailResponse extends ApiResponse {
  session: Session;
}

export interface SessionHistoryResponse extends ApiResponse {
  sessionId: string;
  history: SessionHistoryItem[];
}

export interface AcpSessionResponse extends ApiResponse {
  session: {
    sessionKey: string;
    activeRun: Run | null;
    runs: Run[];
  };
}

export interface CallbackPayload {
  session_id?: string;
  task_id?: string;
  message?: string;
  [key: string]: unknown;
}

export interface CallbackLogItem {
  id: string;
  timestamp: number;
  payload: CallbackPayload;
}

export interface BridgeInboundPayload {
  eventType: string;
  source: string;
  agentId: string;
  sessionKey: string;
  threadId: string;
  text: string;
  runtime: Runtime;
  taskId: string;
  runId: string;
}

export interface BridgeInboundResponse extends ApiResponse {
  ignored?: boolean;
  reason?: string;
  threadId?: string;
  sessionKey?: string;
  run?: Run;
}

export interface ThreadControlResponse extends ApiResponse {
  action?: string;
  run?: Run;
  task?: Task;
}

export type WsMessageType =
  | 'session_registered'
  | 'task_added'
  | 'task_submitted'
  | 'task_updated'
  | 'task_terminated'
  | 'session_output'
  | 'session_message'
  | 'session_exit'
  | 'run_event'
  | 'task_submission_result';

export interface WsMessage {
  type: WsMessageType;
  task?: Task;
  session?: Session;
  sessionId?: string;
  data?: string;
  result?: unknown;
  run?: Run;
  status?: string;
  controlState?: ControlState;
  message?:
    | string
    | {
        id?: string;
        role?: 'user' | 'assistant' | 'system' | string;
        text?: string;
        createdAt?: number;
        updatedAt?: number;
        status?: string;
        source?: string;
        turnId?: string | null;
      };
  update?: boolean;
  historyCount?: number;
  timestamp?: number;
}

export function wsMessageText(message: WsMessage['message']): string {
  if (!message) return '';
  if (typeof message === 'string') return message;
  return String(message.text || '');
}

export interface MonitorEvent {
  id: string;
  timestamp: number;
  type: string;
  source: string;
  data: unknown;
}

export interface RuntimeConfig {
  name: Runtime;
  status: 'active' | 'idle' | 'error';
  config: Record<string, string | number | boolean>;
}

export interface CreateTaskPayload {
  id?: string;
  taskId?: string;
  runId?: string;
  prompt: string;
  runtime?: Runtime;
  sessionKey?: string;
  agentId?: string;
  threadId?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateSessionPayload {
  id?: string;
  cliType?: string;
  options?: {
    model?: string;
    cwd?: string;
    [key: string]: unknown;
  };
}

export interface SendInputPayload {
  message: string;
}

export interface DispatchPayload {
  [key: string]: unknown;
}

export interface ThreadControlPayload {
  action: 'pause' | 'resume' | 'terminate';
}
