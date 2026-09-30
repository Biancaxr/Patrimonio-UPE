import { useEffect } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'

export default function PwaUpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW()

  useEffect(() => {
    if (!offlineReady) return
    const timeout = window.setTimeout(() => setOfflineReady(false), 5000)
    return () => window.clearTimeout(timeout)
  }, [offlineReady, setOfflineReady])

  if (!needRefresh && !offlineReady) return null

  return (
    <aside className="pwa-notice" role="status" aria-live="polite">
      <div>
        <strong>{needRefresh ? 'Nova versão disponível' : 'Aplicativo pronto para uso offline'}</strong>
        <span>{needRefresh ? 'Atualize para carregar as melhorias mais recentes.' : 'As telas já carregadas poderão ser abertas sem conexão.'}</span>
      </div>
      {needRefresh && <button onClick={() => void updateServiceWorker(true)}>Atualizar</button>}
      <button
        className="pwa-notice-close"
        aria-label="Fechar aviso"
        onClick={() => {
          setNeedRefresh(false)
          setOfflineReady(false)
        }}
      >
        ×
      </button>
    </aside>
  )
}
