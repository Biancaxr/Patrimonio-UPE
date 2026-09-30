import Papa from 'papaparse'
import type { Asset, AssetStatus, ChecklistTemplate, Inspection, Loan, Maintenance, Movement, SupportTicket } from './types'

const KEY = 'upe-patrimonio-v1'

const repair = (value: unknown) => {
  const text = String(value ?? '').trim()
  if (!/[ÃÂâ]/.test(text)) return text
  try {
    const bytes = Uint8Array.from([...text].map(char => char.charCodeAt(0)))
    return new TextDecoder('utf-8').decode(bytes)
  } catch { return text }
}

const statusOf = (value: string, index: number): AssetStatus => {
  const normalized = repair(value).toLowerCase()
  if (normalized.includes('manuten')) return 'Em manutenção'
  if (normalized.includes('danif')) return 'Danificado'
  if (normalized.includes('extravi')) return 'Extraviado'
  if (normalized.includes('baix')) return 'Baixado'
  if (normalized.includes('emprest')) return 'Emprestado'
  if (normalized.includes('dispon')) return 'Disponível'
  if (index % 29 === 0) return 'Em manutenção'
  if (index % 17 === 0) return 'Disponível'
  if (index % 41 === 0) return 'Emprestado'
  return 'Em uso'
}

const money = (value: unknown) => {
  const cleaned = repair(value).replace(/[^0-9,.-]/g, '').replace(/\./g, '').replace(',', '.')
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : 0
}

export const seedAssets = async (): Promise<Asset[]> => {
  const response = await fetch('/catalogo.csv')
  const csv = await response.text()
  const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true })
  return parsed.data.map((row, index) => {
    const fixed = Object.fromEntries(Object.entries(row).map(([key, value]) => [repair(key), repair(value)]))
    const serial = fixed['Nº Série'] || fixed['N° Série'] || `SEM-${index + 1}`
    const code = serial.toLowerCase().includes('sem patrim') || serial === '-' ? `PAT-S/${String(index + 1).padStart(4, '0')}` : serial
    return {
      id: `asset-${index + 1}`,
      code,
      name: fixed.Objeto || 'Item patrimonial',
      description: fixed.Observação && fixed.Observação !== '-' ? fixed.Observação : fixed.Modelo || '',
      category: fixed.Categoria || 'Outros',
      brand: (fixed.Modelo || '').split(' ')[0] || 'Não informada',
      model: fixed.Modelo && fixed.Modelo !== '-' ? fixed.Modelo : 'Não informado',
      serial,
      responsible: fixed.Responsável && fixed.Responsável !== '-' ? fixed.Responsável : 'Não atribuído',
      sector: fixed.Setor && fixed.Setor !== '-' ? fixed.Setor : 'Sem setor',
      room: fixed.Local && fixed.Local !== '-' ? fixed.Local : 'Sem localização',
      building: index % 3 === 0 ? 'Bloco A' : index % 3 === 1 ? 'Bloco B' : 'Bloco C',
      campus: 'Campus Caruaru',
      condition: fixed['Estado de conservação'] || 'Não informado',
      deliveryDate: fixed['Data de entrega'] || '-',
      status: statusOf(fixed.Status || '', index),
      invoice: fixed.NF || '-',
      value: money(fixed.Valor),
      notes: fixed.Observação || '',
      visibility: (index % 8 === 0 ? 'Público' : index % 13 === 0 ? 'Restrito' : 'Interno') as Asset['visibility'],
      updatedAt: new Date(Date.now() - index * 36e5 * 7).toISOString(),
    }
  }).filter(asset => asset.name && asset.name !== '-')
}

export interface StoreData {
  assets: Asset[]
  movements: Movement[]
  loans: Loan[]
  maintenances: Maintenance[]
  tickets?: SupportTicket[]
  inspections?: Inspection[]
  checklistTemplates?: ChecklistTemplate[]
}

export const loadStore = (): StoreData | null => {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null') } catch { return null }
}

export const saveStore = (data: StoreData) => localStorage.setItem(KEY, JSON.stringify(data))

export const clearStore = () => localStorage.removeItem(KEY)
