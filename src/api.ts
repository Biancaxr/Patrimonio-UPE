import type { StoreData } from './data'

export const API_URL = import.meta.env.VITE_API_URL?.replace(/\/$/, '') || ''
const TOKEN_KEY = 'upe-api-token'

export type ApiRole = 'ALUNO' | 'TI' | 'ADMINISTRACAO' | 'ADMIN'
export interface ApiUser { id: string; name: string; email: string; role: ApiRole; active?: boolean; createdAt?: string }

export const hasApi = () => Boolean(API_URL)
export const clearApiSession = () => sessionStorage.removeItem(TOKEN_KEY)

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!API_URL) throw new Error('VITE_API_URL não foi configurada.')
  const token = sessionStorage.getItem(TOKEN_KEY)
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.message || 'Não foi possível concluir a operação.')
  return payload as T
}

export async function apiLogin(email: string, password: string) {
  const session = await api<{ token: string; user: ApiUser }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
  sessionStorage.setItem(TOKEN_KEY, session.token)
  return session.user
}


export const loadRemoteStore = async (role?: 'admin' | 'administration' | 'nti' | 'student'): Promise<StoreData> => {
  if (role === 'nti') {
    const [assets, tickets] = await Promise.all([api<StoreData['assets']>('/assets'), api<NonNullable<StoreData['tickets']>>('/tickets')])
    return { assets, tickets, movements: [], loans: [], maintenances: [], inspections: [], checklistTemplates: [] }
  }
  if (role === 'student') {
    const [assets, inspections, checklistTemplates] = await Promise.all([
      api<StoreData['assets']>('/assets'),
      api<NonNullable<StoreData['inspections']>>('/inspections'),
      api<NonNullable<StoreData['checklistTemplates']>>('/checklist-templates'),
    ])
    return { assets, inspections, checklistTemplates, movements: [], loans: [], maintenances: [], tickets: [] }
  }
  const [assets, movements, loans, maintenances, tickets, inspections, checklistTemplates] = await Promise.all([
    api<StoreData['assets']>('/assets'), api<StoreData['movements']>('/movements'), api<StoreData['loans']>('/loans'),
    api<StoreData['maintenances']>('/maintenances'), api<NonNullable<StoreData['tickets']>>('/tickets'),
    api<NonNullable<StoreData['inspections']>>('/inspections'), api<NonNullable<StoreData['checklistTemplates']>>('/checklist-templates'),
  ])
  return { assets, movements, loans, maintenances, tickets, inspections, checklistTemplates }
}
