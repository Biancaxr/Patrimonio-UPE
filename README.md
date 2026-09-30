# Patrimônio UPE Web

Portal React/Vite que consome a API compartilhada do Patrimônio UPE. O navegador nunca acessa o PostgreSQL diretamente.

## Ambiente local

Copie `.env.example` para `.env`:

```env
VITE_API_URL=http://localhost:3333/api
```

Depois execute:

```bash
npm install
npm run dev
```

## Hospedagem

- Comando de build: `npm ci && npm run build`
- Diretório publicado: `dist`
- Variável de build: `VITE_API_URL=https://sua-api.exemplo.com/api`
- Publique obrigatoriamente em HTTPS para permitir instalação e funcionamento do service worker.
- Configure o servidor para redirecionar rotas da aplicação para `index.html`, preservando `/api` para a API.

O domínio do portal também deve ser incluído em `WEB_ORIGIN` na hospedagem da API.

### Docker na VPS

O endereço da API é incorporado ao bundle durante o build. Gere e execute a imagem com:

```bash
docker build --build-arg VITE_API_URL=https://api.seudominio.br/api -t patrimonio-web .
docker run -d --name patrimonio-web --restart unless-stopped -p 8080:80 patrimonio-web
```

O contêiner disponibiliza `GET /health` para health checks. Use um proxy reverso com HTTPS na frente da porta `8080`.

## PWA

O build gera automaticamente o manifesto e o service worker. A aplicação pode ser instalada pelo navegador no computador ou celular e mantém o shell já carregado disponível sem conexão. Respostas autenticadas da API não são armazenadas pelo service worker.

Para testar localmente a versão instalável:

```bash
npm run build
npm run preview
```

Abra o endereço informado pelo Vite. Em produção, uma nova versão exibe um aviso para o usuário atualizar sem interromper formulários em andamento.

## Validação

```bash
npm run build
```

Consulte o README de `Patrimonio UPE API` para configurar PostgreSQL, migrations, seed e administrador inicial.
