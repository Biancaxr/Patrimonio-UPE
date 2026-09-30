export type AssetStatus = 'Em uso' | 'Disponível' | 'Emprestado' | 'Em manutenção' | 'Danificado' | 'Extraviado' | 'Baixado'

export interface Asset {
  id: string
  code: string
  name: string
  description: string
  category: string
  brand: string
  model: string
  serial: string
  responsible: string
  sector: string
  room: string
  building: string
  campus: string
  condition: string
  deliveryDate: string
  status: AssetStatus
  invoice: string
  value: number
  notes: string
  visibility: 'Público' | 'Interno' | 'Restrito'
  updatedAt: string
}

export interface Movement {
  id: string
  assetId: string
  assetCode: string
  assetName: string
  from: string
  to: string
  previousResponsible: string
  newResponsible: string
  reason: string
  user: string
  createdAt: string
}

export interface Loan {
  id: string
  assetId: string
  assetCode: string
  assetName: string
  requester: string
  dueDate: string
  status: 'Emprestado' | 'Devolvido' | 'Atrasado'
  createdAt: string
}

export interface Maintenance {
  id: string
  assetId: string
  assetCode: string
  assetName: string
  issue: string
  technician: string
  status: 'Aguardando manutenção' | 'Em manutenção' | 'Aguardando peça' | 'Concluído' | 'Sem possibilidade de reparo'
  openedAt: string
  cost: number
}

export type TicketStatus = 'Novo' | 'Em triagem' | 'Em atendimento' | 'Resolvido'

export interface SupportTicket {
  id: string
  assetId?: string
  assetCode?: string
  assetName?: string
  requester: string
  contact: string
  location: string
  category: 'Equipamento danificado' | 'Falha de sistema' | 'Dúvida' | 'Outro'
  description: string
  audience: ('Administrativo' | 'NTI')[]
  status: TicketStatus
  createdAt: string
}

export interface ChecklistTemplate {
  id: string
  name: string
  location: string
  items: string[]
}

export interface Inspection {
  id: string
  templateId: string
  templateName: string
  location: string
  inspector: string
  scheduledDate: string
  notes: string
  completedItems: string[]
  totalItems: number
  status: 'Agendada' | 'Em andamento' | 'Concluída'
  createdAt: string
}
