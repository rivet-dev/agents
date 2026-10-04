export type RequestLog = {
  id: number;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  status?: number;
  responseBody?: string;
  time: string;
  curl: string;
  error?: string;
};
