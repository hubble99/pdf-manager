import axios, { AxiosError, type AxiosRequestConfig } from 'axios';
import { API_BASE_URL } from './config';

// ── Axios instance ──────────────────────────────────────────────────────────
const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 120_000, // 2 minutes — large PDF operations may take time
  headers: {
    Accept: 'application/json',
  },
});

// ── Request interceptor — add common headers ────────────────────────────────
apiClient.interceptors.request.use(
  (config) => {
    // Don't set Content-Type for multipart/form-data (axios sets it automatically with boundary)
    return config;
  },
  (error) => Promise.reject(error)
);

// ── Response interceptor — normalize errors ─────────────────────────────────
apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<any>) => {
    let message = error.message || 'An unexpected error occurred';
    
    if (error.response?.data) {
      const data = error.response.data;
      if (data instanceof Blob) {
        try {
          const text = await data.text();
          const json = JSON.parse(text);
          message = json.message || json.detail || message;
        } catch {
          // Keep default message if not JSON
        }
      } else {
        message = data.message || data.detail || message;
      }
    }

    // Re-throw with a normalized message
    return Promise.reject(new Error(message));
  }
);

// ── Typed helpers ───────────────────────────────────────────────────────────
export async function get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
  const res = await apiClient.get<T>(url, config);
  return res.data;
}

export async function post<T>(
  url: string,
  data?: FormData | Record<string, unknown>,
  config?: AxiosRequestConfig
): Promise<T> {
  const res = await apiClient.post<T>(url, data, config);
  return res.data;
}

export async function postForm<T>(url: string, formData: FormData): Promise<T> {
  const res = await apiClient.post<T>(url, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data;
}

// ── Health check ─────────────────────────────────────────────────────────────
export async function checkHealth(): Promise<boolean> {
  try {
    await get('/health');
    return true;
  } catch {
    return false;
  }
}

export default apiClient;
