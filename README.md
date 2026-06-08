# digi-bot

Bot do Discord para o **Digi** — assistente de suporte interno da Digisac. Recebe perguntas no canal `#suporte-duvidas` e em DMs, chama a [Digi RAG API](https://github.com/NicolasLimao/projeto_digi_python) e devolve a resposta. Também coleta feedback 👍/❌ via reações.

## Stack

- Node.js 18+
- discord.js v14
- axios + dotenv

## Como funciona

1. Recebe mensagem no canal de consulta ou DM → chama `POST /api/rag/query` → responde
2. Adiciona reações ✅/❌; quando o usuário reage, chama `POST /api/rag/feedback`
3. Recebe post (texto/PDF) no canal de ingestão → chama `POST /api/ingest` → responde com o total de chunks criados

## Variáveis de ambiente

Copie `.env.example` para `.env` e preencha. Variáveis obrigatórias:

- `DISCORD_BOT_TOKEN` — token do bot no Discord Developer Portal
- `RAG_API_URL` — URL do endpoint `/api/rag/query` da Digi RAG API (a URL de `/api/ingest` é derivada desta automaticamente)

Opcionais:

- `CANAL_INGESTAO`, `CANAL_CONSULTA` — IDs dos canais (tem default no código)

## Rodando localmente

```bash
npm install
npm start
```

## Deploy na SquareCloud

1. Conecte este repo no SquareCloud (ou faça upload do ZIP)
2. Configure as variáveis de ambiente no painel
3. SquareCloud lê o `squarecloud.app` e roda `node bot.js` automaticamente
4. O `AUTORESTART=true` reinicia o bot se cair

## Repositórios relacionados

- [projeto_digi_python](https://github.com/NicolasLimao/projeto_digi_python) — a API RAG em Python que este bot consome
